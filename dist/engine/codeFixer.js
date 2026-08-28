"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSpecFix = generateSpecFix;
// src/engine/codeFixer.ts
const openai_1 = require("openai");
/**
 * Sanitizes LLM output to strip markdown fences and leading path comments
 */
function sanitizeCode(code) {
    return code
        // Strip markdown fences if present inside JSON string
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/i, '')
        // Strip leading header comments like "// tests/fixed-login.spec.ts"
        .replace(/^\/\/\s*[^\n]*\.spec\.[tj]s\n?/i, '')
        // Normalize line endings to LF
        .replace(/\r\n/g, '\n')
        .trim() + '\n';
}
async function generateSpecFix(specCode, failureContext) {
    const openai = new openai_1.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `
You are an expert SDET specializing in Playwright TypeScript test automation.
A Playwright test failed with the following execution context:

- Failing Action: ${failureContext.actionMethod || 'Unknown'}
- Failing Selector: ${failureContext.failedSelector || 'Unknown'}
- Error Message: ${failureContext.errorMessage || 'Timeout'}

DOM SNAPSHOT AT FAILURE:
\`\`\`html
${failureContext.domSnapshot || 'No HTML snapshot available'}
\`\`\`

ORIGINAL SPEC FILE:
\`\`\`typescript
${specCode}
\`\`\`

TASK:
1. Examine the DOM snapshot HTML to see what elements actually exist on the page.
2. If the original action attempted to click a non-existent element (e.g. submit button on a form that uses Enter key or placeholder inputs), refactor the spec to interact with elements that actually exist in the DOM (e.g. filling an input field and pressing Enter).
3. Do NOT alter assertions or test intent—only replace invalid locators or missing actions with valid Playwright methods matching the DOM.
4. Do NOT include top-level file path comments (such as "// tests/fixed-login.spec.ts"), header annotations, or markdown code block fences inside the "fixedCode" string. Output only raw, executable TypeScript code for that property.
5. Return valid JSON matching:

{
  "explanation": "Brief 1-2 sentence explanation of the fix based on the DOM state",
  "fixedCode": "COMPLETE_UPDATED_TYPESCRIPT_CODE"
}
`;
    const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
    });
    const content = response.choices[0].message.content;
    if (!content)
        throw new Error('LLM returned empty response');
    const parsed = JSON.parse(content);
    const cleanFixedCode = sanitizeCode(parsed.fixedCode);
    return {
        originalCode: specCode,
        fixedCode: cleanFixedCode,
        explanation: parsed.explanation,
    };
}
