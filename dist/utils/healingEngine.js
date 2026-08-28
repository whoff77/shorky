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
exports.healSelector = healSelector;
exports.assertVisual = assertVisual;
const openai_1 = __importDefault(require("openai"));
const dotenv = __importStar(require("dotenv"));
dotenv.config();
// Lazily instantiated & cached so top-level imports of this module never
// fail when OPENAI_API_KEY is absent (e.g. in CI jobs that only run
// shorky-cloud-backed flows). The client is only constructed the first time
// one of the functions below actually needs to make an OpenAI call.
let cachedClient;
function getOpenAIClient() {
    if (cachedClient) {
        return cachedClient;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is missing. Provide OPENAI_API_KEY for local CLI mode, or configure SHORKY_CLOUD_URL and SHORKY_CLOUD_API_KEY for cloud mode.');
    }
    cachedClient = new openai_1.default({ apiKey });
    return cachedClient;
}
async function healSelector(page, failedSelector) {
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
async function assertVisual(page, expectationPrompt) {
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
