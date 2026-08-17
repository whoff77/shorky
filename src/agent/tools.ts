import { Page } from '@playwright/test';

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
      description: 'Fills text into a form input or textarea field on the page.',
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
      description: 'Clicks an interactive element (button, link, checkbox) on the page. Uses self-healing fallback if the selector fails.',
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

/**
 * Tool Executor Implementation
 * Maps the agent's function calls directly to live Playwright page operations.
 */
export async function executeAgentTool(
  page: Page,
  toolName: string,
  args: any,
  autoHealPage?: any
): Promise<string> {
  console.log(`🤖 [Agent Tool Executing]: ${toolName}`, JSON.stringify(args));

  try {
    switch (toolName) {
      case 'navigate': {
        await page.goto(args.url);
        return `Successfully navigated to ${args.url}. Current title: "${await page.title()}"`;
      }

      case 'inspectDOM': {
        // Extract a clean snapshot of interactive elements to feed back to the LLM
        const elements = await page.evaluate(() => {
          const nodes = Array.from(document.querySelectorAll('button, input, a, form, h1, h2, h3, [role="button"]'));
          return nodes.slice(0, 30).map((el, index) => {
            const htmlEl = el as HTMLElement;
            return {
              index,
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              name: el.getAttribute('name') || undefined,
              type: el.getAttribute('type') || undefined,
              text: htmlEl.innerText?.trim() || el.getAttribute('value') || '',
              selector: el.id ? `#${el.id}` : el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : el.tagName.toLowerCase()
            };
          });
        });
        return JSON.stringify(elements, null, 2);
      }

      case 'fillInput': {
        await page.fill(args.selector, args.value);
        return `Successfully filled selector "${args.selector}" with value "${args.value}".`;
      }

      case 'clickElement': {
        if (autoHealPage && autoHealPage.clickAndHeal) {
          await autoHealPage.clickAndHeal(args.selector);
        } else {
          await page.click(args.selector);
        }
        return `Successfully clicked element matching selector "${args.selector}".`;
      }

      case 'evaluateState': {
        if (autoHealPage && autoHealPage.assertVisual) {
          await autoHealPage.assertVisual(args.assertion);
          return `Visual assertion passed for: "${args.assertion}"`;
        }
        return `Evaluated state assertion: "${args.assertion}"`;
      }

      default:
        throw new Error(`Unknown agent tool: ${toolName}`);
    }
  } catch (error: any) {
    console.error(`❌ [Agent Tool Error] ${toolName} failed:`, error.message);
    return `ERROR executing ${toolName}: ${error.message}. You should inspect the DOM or try an alternative selector/action.`;
  }
}