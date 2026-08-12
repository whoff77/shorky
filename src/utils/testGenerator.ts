import OpenAI from 'openai';
import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateTestSpec(targetUrl: string, prompt: string, outputFileName: string) {
  console.log(`🔍 [Shorky Generator] Inspecting live page at ${targetUrl}...`);

  // Launch headless browser to fetch DOM context
//   const browser = await chromium.launch({ headless: true });
const browser = await chromium.launch({
    channel: 'chrome',
    headless: true
  });
  const page = await browser.newPage();
  await page.goto(targetUrl);
  
  const domSnapshot = await page.evaluate(() => {
    return document.body.innerHTML.slice(0, 5000);
  });

  await browser.close();

  console.log(`🧠 [Shorky Generator] Generating Playwright test spec with gpt-4o-mini...`);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are an expert Playwright automation engineer. Generate a high-quality TypeScript test file for Playwright.
Key Requirements:
1. Import test and expect from '../src/fixtures/autoHealFixture'.
2. Use the 'autoHealPage' fixture like this:
   test('description', async ({ autoHealPage }) => {
     const { page, clickAndHeal, assertVisual } = autoHealPage;
     await page.goto(url);
     await page.fill(selector, value);
     await clickAndHeal(selector);
     await assertVisual(prompt);
   });
3. Return ONLY executable TypeScript code inside a single block. Do not include markdown code fences or conversational text.`
      },
      {
        role: 'user',
        content: `Target URL: ${targetUrl}
User Requirement: ${prompt}

DOM Snapshot Context:
\`\`\`html
${domSnapshot}
\`\`\``,
      },
    ],
    temperature: 0.1,
  });

  let rawCode = response.choices[0]?.message?.content?.trim() || '';

  // Clean out any accidental code fence formatting
  if (rawCode.startsWith('```')) {
    rawCode = rawCode.replace(/^```(typescript|ts)?/, '').replace(/```$/, '').trim();
  }

  const outputPath = path.join(process.cwd(), 'tests', outputFileName);
  fs.writeFileSync(outputPath, rawCode, 'utf-8');

  console.log(`✅ [Shorky Generator] Test file generated successfully at: tests/${outputFileName}`);
}