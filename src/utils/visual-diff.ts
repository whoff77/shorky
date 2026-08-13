import { Page, expect } from '@playwright/test';

export interface VisualDiffOptions {
  threshold?: number;           // Color sensitivity (0.0 to 1.0). Default: 0.1
  maxDiffPixelRatio?: number;   // Max allowed mismatched pixel ratio. Default: 0.01 (1%)
  maskSelectors?: string[];     // Selectors to mask out (timestamps, avatars, banners)
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