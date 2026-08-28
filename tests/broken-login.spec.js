"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
(0, test_1.test)('user should be able to log in', async ({ page }) => {
    await page.goto('https://the-internet.herokuapp.com/login');
    // Fill in the username and password fields using accessible role/label locators
    await page.getByLabel('Username').fill('tomsmith');
    await page.getByLabel('Password').fill('SuperSecretPassword!');
    // Click the login button
    await page.getByRole('button', { name: /Login/ }).click();
    // Assert that the login was successful by checking the URL
    await (0, test_1.expect)(page).toHaveURL('https://the-internet.herokuapp.com/secure');
});
