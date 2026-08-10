import OpenAI from 'openai';
import * as dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.warn('⚠️ [Shorky] Warning: OPENAI_API_KEY is not set in environment variables.');
}

export const openai = new OpenAI({
  apiKey: apiKey || 'dummy-key',
});

/**
 * Sends a text prompt to the LLM and returns the text response.
 * @param prompt The prompt string to evaluate.
 * @param model The model identifier (default: gpt-4o-mini for fast, low-cost execution).
 */
export async function askLLM(prompt: string, model: string = 'gpt-4o-mini'): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
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
  } catch (error) {
    console.error('❌ [Shorky] LLM API Call Failed:', error);
    throw error;
  }
}

