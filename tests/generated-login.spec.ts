import { test, expect } from '../src/fixtures/autoHealFixture';

test('Log in and assert secure area dashboard', async ({ autoHealPage }) => {
  const { page, clickAndHeal, assertVisual, assertVisualBaseline } = autoHealPage;

  await page.goto('https://the-internet.herokuapp.com/login');
  await page.fill('#username', 'tomsmith');
  await page.fill('#password', 'SuperSecretPassword!');
  await clickAndHeal('button[type="submit"]');
  await assertVisual('Secure Area');

  // 🧪 ARTIFICIAL FAILURE INJECTION:
  // Inject CSS to move the heading and make the button bright neon purple
  // await page.evaluate(() => {
  //   const heading = document.querySelector('h2');
  //   if (heading instanceof HTMLElement) heading.style.marginTop = '100px';

  //   const logoutBtn = document.querySelector('a.button');
  //   if (logoutBtn instanceof HTMLElement) logoutBtn.style.backgroundColor = 'purple';
  // });

  await assertVisualBaseline('login-page-baseline', {
    threshold: 0.1,
    maskSelectors: ['#flash-messages'],
  });
});
