import { test, expect } from '@playwright/test';

test.describe('Shorky Baseline Test Suite', () => {
  test('Verify login page renders correctly', async ({ page }) => {
    // Navigate to a reliable demo testing site
    await page.goto('https://the-internet.herokuapp.com/login');
    
    // Assert page header visibility
    const heading = page.locator('h2');
    await expect(heading).toHaveText('Login Page');

    // Assert key form elements exist
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });
});

