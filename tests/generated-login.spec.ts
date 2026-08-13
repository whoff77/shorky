import { test, expect } from '../src/fixtures/autoHealFixture';

test('Log in and assert secure area dashboard', async ({ autoHealPage }) => {
  const { page, clickAndHeal, assertVisual } = autoHealPage;
  const url = 'https://the-internet.herokuapp.com/login';
  const usernameSelector = '#username';
  const passwordSelector = '#password';
  
  // Intentionally broken selector to force Shorky to heal live in CI
  const loginButtonSelector = 'button[type="submit"]';
  const prompt = 'Secure Area';

  await page.goto(url);
  await page.fill(usernameSelector, 'tomsmith');
  await page.fill(passwordSelector, 'SuperSecretPassword!');
  await clickAndHeal(loginButtonSelector);
  await assertVisual(prompt);
});