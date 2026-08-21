import { Page, Locator } from '@playwright/test';
import { healSelector } from '../utils/healingEngine';

/**
 * Structured trace entry captured for every reasoning step, action, and
 * self-healing attempt the agent performs. These are aggregated by
 * agentRunner.ts and eventually surfaced to cloudReporter.ts via
 * test attachments (see tests/agent-login.spec.ts).
 */
export interface AgentTraceEntry {
  timestamp: string;
  type: 'thought' | 'action' | 'observation' | 'heal-attempt' | 'heal-success' | 'heal-failure';
  tool?: string;
  tier?: string;
  detail: string;
}

/**
 * OpenAI Function Definition Schemas
 * These JSON schemas tell the LLM what tools are available, what they do,
 * and what parameters are strictly required.
 */
export const SHORKY_AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'navigate',
      description: 'Navigates the browser to a specific target URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to navigate to (e.g., https://example.com/login)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'inspectDOM',
      description: 'Scans the active page and returns key interactive elements (buttons, inputs, links, forms) with their visible text, IDs, and attributes.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'fillInput',
      description: 'Fills text into a form input or textarea field on the page. Uses a multi-tier selector fallback engine if the primary selector fails.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS or text selector for the target input element' },
          value: { type: 'string', description: 'The text value to enter into the input' }
        },
        required: ['selector', 'value']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'clickElement',
      description: 'Clicks an interactive element (button, link, checkbox) on the page. Uses a multi-tier selector fallback / self-healing engine if the selector fails.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS, XPath, or visible text selector for the element to click' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'selectOption',
      description: 'Selects an option from a native <select> element or a custom (ARIA/listbox-based) dropdown component by visible label or value.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the <select> element or the dropdown trigger/container' },
          optionLabel: { type: 'string', description: 'The visible text label of the option to select' },
          optionValue: { type: 'string', description: 'The underlying value attribute of the option to select (used for native selects when label is ambiguous)' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'uploadFile',
      description: 'Uploads one or more local files into a file input element.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the <input type="file"> element' },
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute or relative filesystem paths of the files to upload'
          }
        },
        required: ['selector', 'filePaths']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'keyboardPress',
      description: 'Presses a keyboard key or key combination (e.g. Enter, Tab, Escape, Control+A), optionally scoped to a focused element selector.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key or key combination to press (e.g. "Enter", "Tab", "Escape", "Control+A")' },
          selector: { type: 'string', description: 'Optional CSS selector to focus before pressing the key' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'evaluateState',
      description: 'Evaluates whether the current page state meets a high-level visual/functional goal or requirement.',
      parameters: {
        type: 'object',
        properties: {
          assertion: { type: 'string', description: 'The visual or semantic requirement to verify (e.g., "User is logged in and sees Secure Area header")' }
        },
        required: ['assertion']
      }
    }
  }
];

function nowIso(): string {
  return new Date().toISOString();
}

function pushTrace(traceLogs: AgentTraceEntry[] | undefined, entry: Omit<AgentTraceEntry, 'timestamp'>) {
  if (!traceLogs) return;
  traceLogs.push({ timestamp: nowIso(), ...entry });
}

/**
 * Dynamic DOM re-inspection helper. Re-scans the live page for interactive
 * elements and returns a lightweight snapshot used both by the LLM
 * ('inspectDOM' tool) and by the internal selector fallback engine (Tier 2).
 */
async function inspectInteractiveElements(page: Page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button, input, textarea, select, a, form, h1, h2, h3, [role="button"], [role="option"], [role="listbox"]'));
    return nodes.slice(0, 50).map((el, index) => {
      const htmlEl = el as HTMLElement;
      return {
        index,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
        type: el.getAttribute('type') || undefined,
        role: el.getAttribute('role') || undefined,
        text: htmlEl.innerText?.trim() || el.getAttribute('value') || el.getAttribute('aria-label') || '',
        selector: el.id
          ? `#${el.id}`
          : el.getAttribute('name')
          ? `[name="${el.getAttribute('name')}"]`
          : el.tagName.toLowerCase()
      };
    });
  });
}

/**
 * Multi-Tier Selector Fallback Engine
 * ------------------------------------
 * When a primary selector fails during clickElement/fillInput, we progressively
 * attempt more forgiving recovery strategies before giving up:
 *
 *   Tier 1: Role/Text heuristics    -> page.getByRole(...) / page.getByText(...)
 *   Tier 2: Dynamic DOM re-inspection -> re-scan the DOM and fuzzy-match on text/id/name
 *   Tier 3: Visual element grounding -> LLM-assisted selector healing using a live screenshot + HTML
 *
 * Returns a resolved Locator on success, or throws if every tier is exhausted.
 */
async function resolveWithFallback(
  page: Page,
  originalSelector: string,
  intent: 'click' | 'fill',
  traceLogs?: AgentTraceEntry[]
): Promise<Locator> {
  // --- Tier 1: Role/Text heuristics ---
  pushTrace(traceLogs, { type: 'heal-attempt', tier: 'role-text', detail: `Attempting role/text heuristics for "${originalSelector}"` });
  try {
    const roleGuess = intent === 'click' ? 'button' : 'textbox';
    const byRole = page.getByRole(roleGuess as any, { name: originalSelector, exact: false });
    if ((await byRole.count()) > 0) {
      pushTrace(traceLogs, { type: 'heal-success', tier: 'role-text', detail: `Resolved "${originalSelector}" via getByRole("${roleGuess}", { name: "${originalSelector}" })` });
      return byRole.first();
    }
  } catch {
    /* fall through to next heuristic */
  }

  try {
    const byText = page.getByText(originalSelector, { exact: false });
    if ((await byText.count()) > 0) {
      pushTrace(traceLogs, { type: 'heal-success', tier: 'role-text', detail: `Resolved "${originalSelector}" via getByText("${originalSelector}")` });
      return byText.first();
    }
  } catch {
    /* fall through to Tier 2 */
  }

  // --- Tier 2: Dynamic DOM re-inspection ---
  pushTrace(traceLogs, { type: 'heal-attempt', tier: 'dom-reinspect', detail: `Re-inspecting DOM to locate a match for "${originalSelector}"` });
  try {
    const elements = await inspectInteractiveElements(page);
    const needle = originalSelector.toLowerCase().replace(/[#.\[\]'"=]/g, ' ').trim();
    const match = elements.find((el) => {
      const haystack = `${el.text} ${el.id ?? ''} ${el.name ?? ''} ${el.selector}`.toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    });
    if (match) {
      const candidate = page.locator(match.selector);
      if ((await candidate.count()) > 0) {
        pushTrace(traceLogs, { type: 'heal-success', tier: 'dom-reinspect', detail: `Resolved "${originalSelector}" -> "${match.selector}" via DOM re-inspection` });
        return candidate.first();
      }
    }
  } catch {
    /* fall through to Tier 3 */
  }

  // --- Tier 3: Visual element grounding (LLM-assisted, using screenshot + HTML context) ---
  pushTrace(traceLogs, { type: 'heal-attempt', tier: 'visual-grounding', detail: `Requesting LLM-assisted visual grounding for "${originalSelector}"` });
  try {
    const healedSelector = await healSelector(page, originalSelector);
    const candidate = page.locator(healedSelector);
    if ((await candidate.count()) > 0) {
      pushTrace(traceLogs, { type: 'heal-success', tier: 'visual-grounding', detail: `Resolved "${originalSelector}" -> "${healedSelector}" via visual grounding` });
      return candidate.first();
    }
  } catch {
    /* all tiers exhausted */
  }

  pushTrace(traceLogs, { type: 'heal-failure', tier: 'all', detail: `All fallback tiers exhausted for selector "${originalSelector}"` });
  throw new Error(`Unable to resolve selector "${originalSelector}" after exhausting all fallback tiers.`);
}

/**
 * Tool Executor Implementation
 * Maps the agent's function calls directly to live Playwright page operations.
 */
export async function executeAgentTool(
  page: Page,
  toolName: string,
  args: any,
  autoHealPage?: any,
  traceLogs?: AgentTraceEntry[]
): Promise<string> {
  console.log(`🤖 [Agent Tool Executing]: ${toolName}`, JSON.stringify(args));
  pushTrace(traceLogs, { type: 'action', tool: toolName, detail: `Calling ${toolName}(${JSON.stringify(args)})` });

  try {
    switch (toolName) {
      case 'navigate': {
        await page.goto(args.url);
        const observation = `Successfully navigated to ${args.url}. Current title: "${await page.title()}"`;
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
        return observation;
      }

      case 'inspectDOM': {
        // Extract a clean snapshot of interactive elements to feed back to the LLM
        const elements = await inspectInteractiveElements(page);
        const observation = JSON.stringify(elements, null, 2);
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: `Inspected DOM: found ${elements.length} interactive elements` });
        return observation;
      }

      case 'fillInput': {
        try {
          await page.fill(args.selector, args.value, { timeout: 3000 });
        } catch (primaryError) {
          console.warn(`⚠️ [Interceptor] fillInput selector failed: "${args.selector}". Initiating fallback engine...`);
          const locator = await resolveWithFallback(page, args.selector, 'fill', traceLogs);
          await locator.fill(args.value);
        }
        const observation = `Successfully filled selector "${args.selector}" with value "${args.value}".`;
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
        return observation;
      }

      case 'clickElement': {
        if (autoHealPage && autoHealPage.clickAndHeal) {
          await autoHealPage.clickAndHeal(args.selector);
        } else {
          try {
            await page.click(args.selector, { timeout: 3000 });
          } catch (primaryError) {
            console.warn(`⚠️ [Interceptor] clickElement selector failed: "${args.selector}". Initiating fallback engine...`);
            const locator = await resolveWithFallback(page, args.selector, 'click', traceLogs);
            await locator.click();
          }
        }
        const observation = `Successfully clicked element matching selector "${args.selector}".`;
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
        return observation;
      }

      case 'selectOption': {
        const { selector, optionLabel, optionValue } = args;
        try {
          // Native <select> element path
          if (optionValue) {
            await page.selectOption(selector, { value: optionValue }, { timeout: 3000 });
          } else {
            await page.selectOption(selector, { label: optionLabel }, { timeout: 3000 });
          }
        } catch (primaryError) {
          console.warn(`⚠️ [Interceptor] selectOption failed on native <select> "${selector}". Trying custom dropdown pattern...`);
          // Custom dropdown fallback: click trigger to open, then click the matching option by text
          const trigger = await resolveWithFallback(page, selector, 'click', traceLogs);
          await trigger.click();
          const optionText = optionLabel || optionValue;
          const optionLocator = page.getByRole('option', { name: optionText, exact: false }).or(page.getByText(optionText, { exact: false }));
          await optionLocator.first().click();
        }
        const observation = `Successfully selected option "${optionLabel || optionValue}" on "${selector}".`;
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
        return observation;
      }

      case 'uploadFile': {
        const { selector, filePaths } = args;
        try {
          await page.setInputFiles(selector, filePaths, { timeout: 3000 });
        } catch (primaryError) {
          console.warn(`⚠️ [Interceptor] uploadFile selector failed: "${selector}". Initiating fallback engine...`);
          const locator = await resolveWithFallback(page, selector, 'click', traceLogs);
          await locator.setInputFiles(filePaths);
        }
        const observation = `Successfully uploaded file(s) [${filePaths.join(', ')}] to "${selector}".`;
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
        return observation;
      }

      case 'keyboardPress': {
        const { key, selector } = args;
        if (selector) {
          try {
            const locator = page.locator(selector);
            await locator.press(key, { timeout: 3000 });
          } catch (primaryError) {
            console.warn(`⚠️ [Interceptor] keyboardPress selector failed: "${selector}". Initiating fallback engine...`);
            const locator = await resolveWithFallback(page, selector, 'click', traceLogs);
            await locator.press(key);
          }
        } else {
          await page.keyboard.press(key);
        }
        const observation = `Successfully pressed key "${key}"${selector ? ` on selector "${selector}"` : ''}.`;
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
        return observation;
      }

      case 'evaluateState': {
        if (autoHealPage && autoHealPage.assertVisual) {
          await autoHealPage.assertVisual(args.assertion);
          const observation = `Visual assertion passed for: "${args.assertion}"`;
          pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
          return observation;
        }
        const observation = `Evaluated state assertion: "${args.assertion}"`;
        pushTrace(traceLogs, { type: 'observation', tool: toolName, detail: observation });
        return observation;
      }

      default:
        throw new Error(`Unknown agent tool: ${toolName}`);
    }
  } catch (error: any) {
    console.error(`❌ [Agent Tool Error] ${toolName} failed:`, error.message);
    pushTrace(traceLogs, { type: 'heal-failure', tool: toolName, detail: `ERROR executing ${toolName}: ${error.message}` });
    return `ERROR executing ${toolName}: ${error.message}. You should inspect the DOM or try an alternative selector/action.`;
  }
}
