"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
test_1.test.describe('Shorky Baseline Test Suite', () => {
    (0, test_1.test)('Verify login page renders correctly', async ({ page }) => {
        // Navigate to a reliable demo testing site
        await page.goto('https://the-internet.herokuapp.com/login');
        // Assert page header visibility
        const heading = page.locator('h2');
        await (0, test_1.expect)(heading).toHaveText('Login Page');
        // Assert key form elements exist
        await (0, test_1.expect)(page.locator('#username')).toBeVisible();
        await (0, test_1.expect)(page.locator('#password')).toBeVisible();
        await (0, test_1.expect)(page.locator('button[type="submit"]')).toBeVisible();
    });
});
