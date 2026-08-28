"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
const llmClient_1 = require("../src/utils/llmClient");
test_1.test.describe('Shorky LLM Integration Layer', () => {
    (0, test_1.test)('Verify LLM client can communicate with API', async () => {
        const prompt = 'Respond with exactly two words: "Shorky Active"';
        const response = await (0, llmClient_1.askLLM)(prompt);
        console.log(`🤖 [Shorky Response]: ${response}`);
        (0, test_1.expect)(response).toContain('Shorky Active');
    });
});
