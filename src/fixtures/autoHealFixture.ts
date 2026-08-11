import { test as baseTest, Page, expect } from '@playwright/test';
import { healSelector } from '../utils/healingEngine';

type AutoHealFixtures = {
  autoHealPage: {
    clickAndHeal: (selector: string) => Promise<void>;
    page: Page;
  };
};

export const test = baseTest.extend<AutoHealFixtures>({
  autoHealPage: async ({ page }, use) => {
    const clickAndHeal = async (selector: string) => {
      try {
        // Attempt standard click with a short timeout to catch failures fast
        await page.click(selector, { timeout: 2000 });
      } catch (error) {
        console.warn(`\n⚠️ [Shorky Interceptor] Selector failed: "${selector}". Initiating self-healing...`);

        // Grab a snapshot of the current DOM body
        const domSnippet = await page.evaluate(() => document.body.innerHTML.slice(0, 3000));

        // Request a healed selector from the LLM
        const healedSelector = await healSelector({
          failedSelector: selector,
          domSnippet,
        });

        console.log(`✨ [Shorky Healed] Replaced "${selector}" -> "${healedSelector}"`);

        // Retry the click action using the healed selector
        await page.click(healedSelector);
      }
    };

    await use({ clickAndHeal, page });
  },
});

export { expect };
