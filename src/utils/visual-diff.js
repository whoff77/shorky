"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertVisualBaseline = assertVisualBaseline;
const test_1 = require("@playwright/test");
async function assertVisualBaseline(page, snapshotName, options = {}) {
    const { threshold = 0.1, maxDiffPixelRatio = 0.01, maskSelectors = [] } = options ?? {};
    const maskLocators = maskSelectors.map(s => page.locator(s));
    console.log(`📸 [Shorky Visual Diff] Comparing baseline: "${snapshotName}"...`);
    await (0, test_1.expect)(page).toHaveScreenshot(`${snapshotName}.png`, {
        threshold,
        maxDiffPixelRatio,
        mask: maskLocators,
        animations: 'disabled',
    });
    console.log(`✅ [Shorky Visual Diff Passed] Baseline "${snapshotName}" matches.`);
}
