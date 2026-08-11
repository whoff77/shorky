import { askLLM } from './llmClient';

interface HealRequest {
  failedSelector: string;
  domSnippet: string;
}

/**
 * Sends a broken selector and DOM context to the LLM to predict the correct CSS selector.
 */
export async function healSelector({ failedSelector, domSnippet }: HealRequest): Promise<string> {
  const prompt = `
You are an automated self-healing QA engine named Shorky.
A Playwright test failed because the locator "${failedSelector}" could not be found.

Here is the current HTML context of the page:
\`\`\`html
${domSnippet}
\`\`\`

Task:
Analyze the HTML snippet and identify the correct, valid CSS selector for the intended target element.
Return ONLY the raw CSS selector string (e.g., button[type="submit"] or #username). 
Do NOT include markdown formatting, code blocks, quotes, or explanation.
`;

  const suggestedSelector = await askLLM(prompt);
  // Strip any accidental markdown formatting returned by the LLM
  return suggestedSelector.replace(/```/g, '').trim();
}
