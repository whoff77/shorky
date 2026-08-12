import { test, expect } from '../src/fixtures/autoHealFixture';

test.describe('Shorky AI Visual Audit Suite', () => {
  test('Validates login page rendering and layout via AI Vision', async ({ autoHealPage }) => {
    const { page, assertVisual } = autoHealPage;

    await page.goto('https://the-internet.herokuapp.com/login');

    // Run AI Visual Assertion
    await assertVisual('The page shows a clean login form with visible username and password fields and a submit button.');
  });
});