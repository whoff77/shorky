import { test, expect } from '@playwright/test';

test('user should be able to add a todo item', async ({ page }) => {
  await page.goto('https://demo.playwright.dev/todomvc/');
  
  // Locate the input field for adding a new todo item
  const todoInput = page.locator('.new-todo');
  
  // Fill the input field and press Enter to add a new todo item
  await todoInput.fill('Buy groceries');
  await todoInput.press('Enter');

  // Verify the new todo item is added to the list
  const todoItem = page.locator('.todo-list li');
  await expect(todoItem).toHaveText('Buy groceries');
});