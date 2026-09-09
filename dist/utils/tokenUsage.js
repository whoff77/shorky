"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordTokenUsage = recordTokenUsage;
exports.getTokensUsedThisTest = getTokensUsedThisTest;
exports.resetTokensUsedThisTest = resetTokensUsedThisTest;
// src/utils/tokenUsage.ts
//
// Lightweight per-process accumulator for LLM tokens consumed by
// self-healing / vision assertions during the *currently executing* test
// (see `healingEngine.ts` and `agentRunner.ts`, which call `recordTokenUsage()`
// after every OpenAI chat-completion response).
//
// WHY A MODULE-LEVEL COUNTER: Playwright runs each test's fixtures/body
// inside a worker process that is *separate* from the main process running
// reporters like `cloudReporter.ts`. There is no way to share in-memory
// state directly between the two. The supported bridge for worker -> main
// process data is `testInfo.attach()` (see `TestResult.attachments`), so
// `autoHealFixture.ts`'s `autoHealPage` fixture snapshots this counter via
// `getTokensUsedThisTest()`, attaches it to the test result, and
// `cloudReporter.ts` reads that attachment back out in `onTestEnd()`.
//
// Safe for `fullyParallel: true`: each worker process runs exactly one test
// at a time, so as long as the counter is reset at the start of every test
// (via `resetTokensUsedThisTest()` in the fixture), there is no
// cross-contamination between tests sharing a worker.
let tokensUsedThisTest = 0;
/**
 * Records tokens consumed by an OpenAI chat-completion call. Accepts the
 * raw `response.usage` object (or `undefined`/`null`) directly so call
 * sites can pass it through without extra null-checking boilerplate.
 */
function recordTokenUsage(usage) {
    if (usage?.total_tokens) {
        tokensUsedThisTest += usage.total_tokens;
    }
}
/** Returns the total tokens recorded since the last reset. */
function getTokensUsedThisTest() {
    return tokensUsedThisTest;
}
/** Resets the counter — call at the start of each test (see `autoHealFixture.ts`). */
function resetTokensUsedThisTest() {
    tokensUsedThisTest = 0;
}
