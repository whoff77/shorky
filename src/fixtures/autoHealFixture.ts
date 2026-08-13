import { test as baseTest, Page, expect } from '@playwright/test';
import { healSelector, assertVisual } from '../utils/healingEngine';
import { assertVisualBaseline, VisualDiffOptions } from '../utils/visual-diff';
import * as fs from 'fs';
import * as path from 'path';

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
  autoHealPage: async ({ page }, use) => {
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
  },
});

export { expect };