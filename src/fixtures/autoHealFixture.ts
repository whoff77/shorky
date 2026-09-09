import { test as baseTest, Page, expect } from '@playwright/test';
import { healSelector, assertVisual } from '../utils/healingEngine';
import { assertVisualBaseline, VisualDiffOptions } from '../utils/visual-diff';
import { getTokensUsedThisTest, resetTokensUsedThisTest } from '../utils/tokenUsage';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Attachment name used to bridge LLM token usage from the worker process
 * (where fixtures/test bodies run and OpenAI calls actually happen — see
 * `healingEngine.ts`'s `recordTokenUsage()`) to the main process reporter
 * (`cloudReporter.ts`, which runs in a separate process and has no direct
 * access to worker-local state). `cloudReporter.ts`'s `onTestEnd()` looks
 * for an attachment with this exact name.
 */
export const SHORKY_TOKENS_ATTACHMENT_NAME = 'shorky-tokens-used';

const REGISTRY_PATH = path.join(__dirname, 'healed-selectors.json');

function loadRegistry(): Record<string, string> {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      return JSON.parse(data || '{}');
    }
  } catch (err) {
    console.error('⚠️ [Shorky] Failed to read healed-selectors.json', err);
  }
  return {};
}

function saveRegistry(registry: Record<string, string>) {
  try {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ [Shorky] Failed to save healed-selectors.json', err);
  }
}

export type AutoHealFixtures = {
  autoHealPage: {
    page: Page;
    clickAndHeal: (selector: string) => Promise<void>;
    assertVisual: (expectation: string) => Promise<void>;
    assertVisualBaseline: (snapshotName: string, options?: VisualDiffOptions) => Promise<void>;
  };
};

export const test = baseTest.extend<AutoHealFixtures>({
  autoHealPage: async ({ page }, use, testInfo) => {
    // Reset the per-test token counter at fixture setup so tokens consumed
    // by a *previous* test sharing this worker process never bleed into
    // the current test's reported usage (see tokenUsage.ts).
    resetTokensUsedThisTest();

    const clickAndHeal = async (selector: string) => {
      const registry = loadRegistry();
      const activeSelector = registry[selector] || selector;

      if (registry[selector]) {
        console.log(`⚡ [Shorky Cache] Using pre-healed selector: "${selector}" -> "${registry[selector]}"`);
      }

      try {
        await page.click(activeSelector, { timeout: 3000 });
      } catch (error) {
        console.warn(`⚠️ [Shorky Interceptor] Selector failed: "${selector}". Initiating self-healing...`);

        const healedSelector = await healSelector(page, selector);

        console.log(`✨ [Shorky Healed] Replaced "${selector}" -> "${healedSelector}"`);

        registry[selector] = healedSelector;
        saveRegistry(registry);

        await page.click(healedSelector);
      }
    };

    const runVisualCheck = async (expectation: string) => {
      console.log(`👁️ [Shorky Vision] Auditing visual layout: "${expectation}"...`);
      const result = await assertVisual(page, expectation);

      if (!result.passed) {
        console.error(`❌ [Shorky Vision Failed] ${result.reason}`);
        throw new Error(`Visual assertion failed: ${result.reason}`);
      } else {
        console.log(`✅ [Shorky Vision Passed] ${result.reason}`);
      }
    };

    const runVisualBaseline = async (snapshotName: string, options?: VisualDiffOptions) => {
      await assertVisualBaseline(page, snapshotName, options ?? {});
    };

    await use({
      page,
      clickAndHeal,
      assertVisual: runVisualCheck,
      assertVisualBaseline: runVisualBaseline,
    });

    // Fixture teardown (runs after the test body completes, but while
    // `testInfo` is still attachable): snapshot the tokens consumed by any
    // self-healing/vision calls made during this test and attach them to
    // the test result so `cloudReporter.ts` (running in the main process)
    // can read them back out in `onTestEnd()`.
    const tokensUsed = getTokensUsedThisTest();
    if (tokensUsed > 0) {
      await testInfo.attach(SHORKY_TOKENS_ATTACHMENT_NAME, {
        body: String(tokensUsed),
        contentType: 'text/plain',
      });
    }
  },
});

export { expect };