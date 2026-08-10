import { test, expect } from '@playwright/test';
import { askLLM } from '../src/utils/llmClient';

test.describe('Shorky LLM Integration Layer', () => {
  test('Verify LLM client can communicate with API', async () => {
    const prompt = 'Respond with exactly two words: "Shorky Active"';
    
    const response = await askLLM(prompt);
    
    console.log(`🤖 [Shorky Response]: ${response}`);
    
    expect(response).toContain('Shorky Active');
  });
});

