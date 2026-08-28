import OpenAI from 'openai';
import { Page } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

// Lazily instantiated & cached so top-level imports of this module never
// fail when OPENAI_API_KEY is absent (e.g. in CI jobs that only run
// shorky-cloud-backed flows). The client is only constructed the first time
// one of the functions below actually needs to make an OpenAI call.
let cachedClient: OpenAI | undefined;

function getOpenAIClient(): OpenAI {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is missing. Provide OPENAI_API_KEY for local CLI mode, or configure SHORKY_CLOUD_URL and SHORKY_CLOUD_API_KEY for cloud mode.',
    );
  }

  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

export async function healSelector(page: Page, failedSelector: string): Promise<string> {
  const domSnapshot = await page.evaluate(() => {
    return document.body.innerHTML.slice(0, 4000);
  });

  const response = await getOpenAIClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: `A Playwright test failed clicking selector: "${failedSelector}".
Here is the raw HTML snapshot of the page:
\`\`\`html
${domSnapshot}
\`\`\`
Return ONLY the best valid CSS selector to click the intended element (e.g. button[type="submit"]). Do not include any explanation, quotes, or markdown code fences.`,
      },
    ],
    temperature: 0,
  });

  const healedSelector = response.choices[0]?.message?.content?.trim() || 'button[type="submit"]';
  return healedSelector;
}

export async function assertVisual(
  page: Page,
  expectationPrompt: string
): Promise<{ passed: boolean; reason: string }> {
  // Take screenshot buffer as base64
  const screenshotBuffer = await page.screenshot({ fullPage: false });
  const base64Image = screenshotBuffer.toString('base64');

  const response = await getOpenAIClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this UI screenshot. Expectation: "${expectationPrompt}".
Does the visual representation satisfy the expectation? Reply ONLY in valid JSON matching this schema:
{"passed": true|false, "reason": "brief explanation"}`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const content = response.choices[0]?.message?.content || '{}';
  return JSON.parse(content);
}