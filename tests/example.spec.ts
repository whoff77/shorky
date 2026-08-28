import { test, expect } from '@playwright/test';

test('Shorky Cloud Telemetry Verification', async ({ page }) => {
  await page.goto('https://example.com');
  // INTENTIONAL FAILURE: Triggers Shorky failure telemetry
  await expect(page.locator('h1')).toHaveText('WRONG_HEADER_SHORKY_CLOUD_TEST');
});
