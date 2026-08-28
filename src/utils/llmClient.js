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
exports.openai = void 0;
exports.askLLM = askLLM;
const openai_1 = __importDefault(require("openai"));
const dotenv = __importStar(require("dotenv"));
// Load environment variables from .env
dotenv.config();
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.warn('⚠️ [Shorky] Warning: OPENAI_API_KEY is not set in environment variables.');
}
exports.openai = new openai_1.default({
    apiKey: apiKey || 'dummy-key',
});
/**
 * Sends a text prompt to the LLM and returns the text response.
 * @param prompt The prompt string to evaluate.
 * @param model The model identifier (default: gpt-4o-mini for fast, low-cost execution).
 */
async function askLLM(prompt, model = 'gpt-4o-mini') {
    try {
        const response = await exports.openai.chat.completions.create({
            model: model,
            messages: [
                {
                    role: 'system',
                    content: 'You are Shorky, an AI-powered QA assistant helping with automated testing.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.2, // Low temperature for deterministic QA answers
        });
        return response.choices[0]?.message?.content?.trim() || '';
    }
    catch (error) {
        console.error('❌ [Shorky] LLM API Call Failed:', error);
        throw error;
    }
}
