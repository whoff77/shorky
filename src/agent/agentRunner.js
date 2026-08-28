"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAgentGoal = runAgentGoal;
const openai_1 = __importDefault(require("openai"));
const tools_1 = require("./tools");
let cachedClient = null;
function getOpenAIClient() {
    if (cachedClient) {
        return cachedClient;
    }
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is missing. Provide OPENAI_API_KEY for local agent execution.');
    }
    cachedClient = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
    return cachedClient;
}
/**
 * ReAct Agent Runner
 * Executes a high-level testing goal autonomously via a Reason-Act-Observe loop.
 */
async function runAgentGoal(page, options) {
    const { goal, maxSteps = 10, autoHealPage } = options;
    const historyLog = [];
    const traceLogs = [];
    const pushTrace = (entry) => {
        traceLogs.push({ timestamp: new Date().toISOString(), ...entry });
    };
    console.log(`\n🤖 [Shorky Agent Starting] Goal: "${goal}"`);
    pushTrace({ type: 'thought', detail: `Agent starting with goal: "${goal}"` });
    // Initial System Prompt establishing the ReAct persona and rules
    const messages = [
        {
            role: 'system',
            content: `You are Shorky, an autonomous AI Test Engineer operating inside a live Playwright browser context.

Goal: Complete the high-level testing instruction provided by the user.

Workflow Rules:
1. First, inspect the current DOM state using 'inspectDOM' or navigate to the target page if not already there.
2. Analyze the interactive elements available on the page.
3. Formulate a logical step-by-step plan.
4. Execute tool calls ('fillInput', 'clickElement', 'selectOption', 'uploadFile', 'keyboardPress', 'navigate', etc.) to interact with the application.
5. After completing key actions, evaluate page state using 'evaluateState'.
6. If an action fails, inspect the DOM again and adjust your selector or strategy. The underlying tools already attempt automatic selector fallback/self-healing, but you should still reason about better selectors when repeated failures occur.
7. Use 'selectOption' for both native <select> dropdowns and custom ARIA-based dropdown widgets.
8. Use 'uploadFile' for any <input type="file"> elements, providing local file paths.
9. Use 'keyboardPress' for keys like Enter, Tab, or Escape when needed to submit forms or dismiss elements.
10. Once the goal is completely achieved, respond with a final text message confirming completion.`
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
        const response = await getOpenAIClient().chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            tools: tools_1.SHORKY_AGENT_TOOLS,
            tool_choice: 'auto',
            temperature: 0.1,
        });
        const responseMessage = response.choices[0].message;
        messages.push(responseMessage);
        // If model provided reasoning/thought output, log it
        if (responseMessage.content) {
            console.log(`💭 [Agent Thought]: ${responseMessage.content}`);
            historyLog.push(`Thought: ${responseMessage.content}`);
            pushTrace({ type: 'thought', detail: responseMessage.content });
        }
        // 2. ACT: Check if model invoked any function tools
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            for (const toolCall of responseMessage.tool_calls) {
                // Safely narrow union type to standard function tool calls
                if (toolCall.type !== 'function')
                    continue;
                const functionName = toolCall.function.name;
                let functionArgs = {};
                try {
                    functionArgs = JSON.parse(toolCall.function.arguments);
                }
                catch (e) {
                    functionArgs = {};
                }
                console.log(`⚡ [Agent Action]: Calling ${functionName}(${JSON.stringify(functionArgs)})`);
                // Execute the tool in the live Playwright context
                const observation = await (0, tools_1.executeAgentTool)(page, functionName, functionArgs, autoHealPage, traceLogs);
                console.log(`👁️ [Agent Observation]: ${observation.slice(0, 150)}${observation.length > 150 ? '...' : ''}`);
                historyLog.push(`Action: ${functionName}(${JSON.stringify(functionArgs)}) -> ${observation}`);
                // 3. OBSERVE: Append tool execution result back into conversation context
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: observation,
                });
            }
        }
        else if (responseMessage.content && !responseMessage.tool_calls) {
            // If the model gave a text response with no tool calls, it considers the goal complete
            isGoalComplete = true;
            finalAnswer = responseMessage.content;
            console.log(`\n🎉 [Agent Completed Goal]: ${finalAnswer}`);
            pushTrace({ type: 'thought', detail: `Agent concluded goal is complete: ${finalAnswer}` });
        }
    }
    if (!isGoalComplete && stepCount >= maxSteps) {
        console.warn(`⚠️ [Agent Warning]: Reached max step limit (${maxSteps}) without completing goal.`);
        finalAnswer = `Agent reached maximum steps (${maxSteps}) before reaching conclusion.`;
        pushTrace({ type: 'heal-failure', detail: finalAnswer });
    }
    // Single top-level return statement satisfying Promise<AgentRunResult>
    return {
        success: isGoalComplete,
        stepsExecuted: stepCount,
        finalAnswer: finalAnswer || 'Agent execution completed.',
        history: historyLog,
        traceLogs,
    };
}
