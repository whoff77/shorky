"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTestSpec = generateTestSpec;
const openai_1 = __importDefault(require("openai"));
const test_1 = require("@playwright/test");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const openai = new openai_1.default({
    apiKey: process.env.OPENAI_API_KEY,
});
async function generateTestSpec(targetUrl, prompt, outputFileName) {
    console.log(`🔍 [Shorky Generator] Inspecting live page at ${targetUrl}...`);
    // Launch headless browser to fetch DOM context
    //   const browser = await chromium.launch({ headless: true });
    const browser = await test_1.chromium.launch({
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
