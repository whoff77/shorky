import { Page } from '@playwright/test';
import OpenAI from 'openai';
import { SHORKY_AGENT_TOOLS, executeAgentTool } from './tools';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface AgentRunOptions {
  goal: string;
  maxSteps?: number;
  autoHealPage?: any;
}

export interface AgentRunResult {
  success: boolean;
  stepsExecuted: number;
  finalAnswer: string;
  history: string[];
}

/**
 * ReAct Agent Runner
 * Executes a high-level testing goal autonomously via a Reason-Act-Observe loop.
 */
export async function runAgentGoal(
  page: Page,
  options: AgentRunOptions
): Promise<AgentRunResult> {
  const { goal, maxSteps = 10, autoHealPage } = options;
  const historyLog: string[] = [];

  console.log(`\n🤖 [Shorky Agent Starting] Goal: "${goal}"`);

  // Initial System Prompt establishing the ReAct persona and rules
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are Shorky, an autonomous AI Test Engineer operating inside a live Playwright browser context.

Goal: Complete the high-level testing instruction provided by the user.

Workflow Rules:
1. First, inspect the current DOM state using 'inspectDOM' or navigate to the target page if not already there.
2. Analyze the interactive elements available on the page.
3. Formulate a logical step-by-step plan.
4. Execute tool calls ('fillInput', 'clickElement', 'navigate', etc.) to interact with the application.
5. After completing key actions, evaluate page state using 'evaluateState'.
6. If an action fails, inspect the DOM again and adjust your selector or strategy.
7. Once the goal is completely achieved, respond with a final text message confirming completion.`
    },
    {
      role: 'user',
      content: `Goal: ${goal}`
    }
  ];

  let stepCount = 0;
  let isGoalComplete = false;
  let finalAnswer = '';

  while (stepCount < maxSteps && !isGoalComplete) {
    stepCount++;
    console.log(`\n🔄 [ReAct Cycle ${stepCount}/${maxSteps}] Reason & Plan...`);

    // 1. Ask model for next action or completion
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: SHORKY_AGENT_TOOLS,
      tool_choice: 'auto',
      temperature: 0.1,
    });

    const responseMessage = response.choices[0].message;
    messages.push(responseMessage);

    // If model provided reasoning/thought output, log it
    if (responseMessage.content) {
      console.log(`💭 [Agent Thought]: ${responseMessage.content}`);
      historyLog.push(`Thought: ${responseMessage.content}`);
    }

    // 2. ACT: Check if model invoked any function tools
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      for (const toolCall of responseMessage.tool_calls) {
        // Safely narrow union type to standard function tool calls
        if (toolCall.type !== 'function') continue;

        const functionName = toolCall.function.name;
        let functionArgs: any = {};

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          functionArgs = {};
        }

        console.log(`⚡ [Agent Action]: Calling ${functionName}(${JSON.stringify(functionArgs)})`);

        // Execute the tool in the live Playwright context
        const observation = await executeAgentTool(page, functionName, functionArgs, autoHealPage);
        console.log(`👁️ [Agent Observation]: ${observation.slice(0, 150)}${observation.length > 150 ? '...' : ''}`);

        historyLog.push(`Action: ${functionName}(${JSON.stringify(functionArgs)}) -> ${observation}`);

        // 3. OBSERVE: Append tool execution result back into conversation context
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: observation,
        });
      }
    } else if (responseMessage.content && !responseMessage.tool_calls) {
      // If the model gave a text response with no tool calls, it considers the goal complete
      isGoalComplete = true;
      finalAnswer = responseMessage.content;
      console.log(`\n🎉 [Agent Completed Goal]: ${finalAnswer}`);
    }
  }

  if (!isGoalComplete && stepCount >= maxSteps) {
    console.warn(`⚠️ [Agent Warning]: Reached max step limit (${maxSteps}) without completing goal.`);
    finalAnswer = `Agent reached maximum steps (${maxSteps}) before reaching conclusion.`;
  }

  // Single top-level return statement satisfying Promise<AgentRunResult>
  return {
    success: isGoalComplete,
    stepsExecuted: stepCount,
    finalAnswer: finalAnswer || 'Agent execution completed.',
    history: historyLog,
  };
}