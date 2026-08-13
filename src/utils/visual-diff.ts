import { Page, expect } from '@playwright/test';

export interface VisualDiffOptions {
  threshold?: number;
  maxDiffPixelRatio?: number;
  maskSelectors?: string[];
}

export async function assertVisualBaseline(
  page: Page,
  snapshotName: string,
  options: VisualDiffOptions = {}
): Promise<void> {
  const { threshold = 0.1, maxDiffPixelRatio = 0.01, maskSelectors = [] } = options ?? {};
  const maskLocators = maskSelectors.map(s => page.locator(s));

  console.log(`📸 [Shorky Visual Diff] Comparing baseline: "${snapshotName}"...`);

  await expect(page).toHaveScreenshot(`${snapshotName}.png`, {
    threshold,
    maxDiffPixelRatio,
    mask: maskLocators,
    animations: 'disabled',
  });

  console.log(`✅ [Shorky Visual Diff Passed] Baseline "${snapshotName}" matches.`);
}