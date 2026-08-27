// tests/fixed-login.spec.ts
import { test, expect } from '@playwright/test';

test('user should be able to log in', async ({ page }) => {
  await page.goto('https://the-internet.herokuapp.com/login');
  
  // Fill in the username and password fields
  await page.fill('#userrname', 'tomsmith');
  await page.fill('#passsword', 'SuperSecretPassword!');
  
  // Click the login button
  await page.click('button[type="sumbit"]');
  
  // Assert that the login was successful by checking the URL or a success message
  await expect(page).toHaveURL('https://the-internet.herokuapp.com/secure');
});