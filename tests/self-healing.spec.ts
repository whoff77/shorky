import { test, expect } from '../src/fixtures/autoHealFixture';

test.describe('Shorky Self-Healing Suite', () => {
  test('Automatically heals a broken button selector', async ({ autoHealPage }) => {
    const { page, clickAndHeal } = autoHealPage;

    await page.goto('https://the-internet.herokuapp.com/login');

    // Fill in standard inputs
    await page.fill('#username', 'tomsmith');
    await page.fill('#password', 'SuperSecretPassword!');

    // Pass an INTENTIONALLY BROKEN selector to our self-healing handler
    await clickAndHeal('button[type="submit"]');

    // Verify successful login navigation post-healing
    await expect(page.locator('#flash')).toContainText('You logged into a secure area!');
  });
});
