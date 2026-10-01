// src/reporters/__tests__/cloudReporter.test.ts
//
// Regression tests for the retry-duplication bug in ShorkyCloudReporter.
//
// Playwright invokes onTestEnd() once per ATTEMPT (initial + every retry),
// and — critically — `result` is ALREADY the last element of `test.results`
// at the moment ANY attempt's onTestEnd() fires (Playwright appends it in
// `_onTestBegin()`, before the attempt even runs). That means a naive
// "is this the final attempt?" check comparing `result` against
// `test.results[test.results.length - 1]` is always true and never filters
// anything out. The fix accumulates a Map<testId, TestRunItem> that each
// onTestEnd() call OVERWRITES (never pushes to) — so retries of the same
// test simply replace its entry — and only reads that Map back out, once,
// in onEnd(), where the final passed/failed totals and the payload's
// `tests[]` array are computed.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import ShorkyCloudReporter from '../cloudReporter';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  process.env.SHORKY_CLOUD_API_KEY = 'test-api-key';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  mock.restoreAll();
  resetEnv();
});

/** Minimal TestResult stub — only the fields ShorkyCloudReporter actually reads. */
function makeResult(overrides: Partial<any> = {}): any {
  return {
    status: 'failed',
    error: { message: 'Timeout exceeded' },
    attachments: [],
    ...overrides,
  };
}

/**
 * Minimal TestCase stub whose `results` array + `outcome()` mimic
 * Playwright's real semantics. `file`/`projectName` default to a single
 * fixed spec file and "Google Chrome" so existing single-browser tests
 * don't need to change, but can be overridden to simulate the SAME
 * logical test (same file + title) running under a DIFFERENT browser
 * project — each such TestCase gets its own distinct `id`, exactly like
 * real Playwright does across its multi-browser matrix.
 */
function makeTestCase(
  id: string,
  title: string,
  results: any[],
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped',
  options: { file?: string; projectName?: string } = {}
): any {
  const { file = 'tests/example.spec.ts', projectName = 'Google Chrome' } = options;
  return {
    id,
    title,
    results,
    outcome: () => outcome,
    location: { file, line: 1, column: 1 },
    parent: { project: () => ({ name: projectName }) },
  };
}

/**
 * Calls onEnd() with `fetch` mocked to capture the outgoing telemetry
 * payload, returning the parsed `tests[]` array plus the raw payload for
 * further assertions (e.g. passedCount/failedCount).
 */
async function runOnEndAndCapturePayload(reporter: ShorkyCloudReporter): Promise<any> {
  let capturedBody: any;
  mock.method(globalThis, 'fetch', async (_url: string, init: any) => {
    // Both runPreflightCheck() and the telemetry POST itself call fetch;
    // only the telemetry POST sends a body containing `tests`, so only
    // capture that one.
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (body && Array.isArray(body.tests)) {
      capturedBody = body;
    }
    return jsonResponse(200, { success: true, allowExecution: true, acceptsTelemetry: true });
  });

  await reporter.onEnd({ status: 'failed', duration: 1234 } as any);
  return capturedBody;
}

test('onTestEnd + onEnd: a test retried 3 times (all failed/timedOut) produces exactly ONE tests[] entry and one failedCount increment', async () => {
  process.env.SHORKY_CLOUD_API_KEY = 'test-api-key';
  const reporter = new ShorkyCloudReporter();

  const attempt1 = makeResult({ status: 'timedOut', error: { message: 'attempt 1 timed out' } });
  const attempt2 = makeResult({ status: 'timedOut', error: { message: 'attempt 2 timed out' } });
  const attempt3 = makeResult({ status: 'timedOut', error: { message: 'attempt 3 (final) timed out' } });

  // `results` accumulates every attempt in order, exactly as Playwright's
  // real TestCase.results does — each attempt is already appended to this
  // array by the time onTestEnd() fires for it.
  const results = [attempt1, attempt2, attempt3];
  const test1 = makeTestCase('test-1', 'user should be able to log in', results, 'unexpected');

  // Simulate Playwright invoking onTestEnd() once per attempt, in order.
  // Each call OVERWRITES (never appends) the Map entry for 'test-1'.
  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);
  reporter.onTestEnd(test1, attempt3);

  const payload = await runOnEndAndCapturePayload(reporter);

  assert.equal(payload.tests.length, 1, 'exactly one telemetry record must be emitted for this test, regardless of retry count');
  assert.equal(payload.failedCount, 1, 'failedCount must only be incremented once per test, not once per attempt');
  assert.equal(payload.passedCount, 0);
  assert.equal(payload.tests[0].status, 'failed');
});

test('onTestEnd + onEnd: combines error messages from every failed attempt into the single emitted record', async () => {
  const reporter = new ShorkyCloudReporter();

  const attempt1 = makeResult({ status: 'timedOut', error: { message: 'attempt 1 timed out' } });
  const attempt2 = makeResult({ status: 'timedOut', error: { message: 'attempt 2 (final) timed out' } });
  const results = [attempt1, attempt2];
  const test1 = makeTestCase('test-1', 'flaky test', results, 'unexpected');

  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);

  const payload = await runOnEndAndCapturePayload(reporter);
  assert.equal(payload.tests.length, 1);
  const combinedError = payload.tests[0].traceLogs[0]?.message ?? '';
  assert.match(combinedError, /attempt 1 timed out/);
  assert.match(combinedError, /attempt 2 \(final\) timed out/);
});

test('onTestEnd + onEnd: a flaky test (failed once, then passed on retry) is reported as PASSED exactly once', async () => {
  const reporter = new ShorkyCloudReporter();

  const attempt1 = makeResult({ status: 'failed', error: { message: 'flaky failure' } });
  const attempt2 = makeResult({ status: 'passed', error: undefined });
  const results = [attempt1, attempt2];
  const test1 = makeTestCase('test-1', 'flaky test', results, 'flaky');

  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);

  const payload = await runOnEndAndCapturePayload(reporter);
  assert.equal(payload.tests.length, 1);
  assert.equal(payload.tests[0].status, 'passed');
  assert.equal(payload.passedCount, 1);
  assert.equal(payload.failedCount, 0);
});

test('onTestEnd + onEnd: two DIFFERENT tests each retried produce exactly two tests[] entries (one per test, not per attempt)', async () => {
  const reporter = new ShorkyCloudReporter();

  const testAAttempt1 = makeResult({ status: 'failed', error: { message: 'A attempt 1 failed' } });
  const testAAttempt2 = makeResult({ status: 'passed', error: undefined });
  const testA = makeTestCase('test-a', 'test A', [testAAttempt1, testAAttempt2], 'flaky');

  const testBAttempt1 = makeResult({ status: 'timedOut', error: { message: 'B attempt 1 timed out' } });
  const testBAttempt2 = makeResult({ status: 'timedOut', error: { message: 'B attempt 2 (final) timed out' } });
  const testB = makeTestCase('test-b', 'test B', [testBAttempt1, testBAttempt2], 'unexpected');

  reporter.onTestEnd(testA, testAAttempt1);
  reporter.onTestEnd(testB, testBAttempt1);
  reporter.onTestEnd(testA, testAAttempt2);
  reporter.onTestEnd(testB, testBAttempt2);

  const payload = await runOnEndAndCapturePayload(reporter);

  assert.equal(payload.tests.length, 2, 'each distinct test must contribute exactly one entry, keyed by its own test.id');
  const byName = Object.fromEntries(payload.tests.map((t: any) => [t.testName, t.status]));
  assert.deepEqual(byName, { 'test A': 'passed', 'test B': 'failed' });
  assert.equal(payload.passedCount, 1);
  assert.equal(payload.failedCount, 1);
});

test('onTestEnd + onEnd: the SAME test failing across Chrome, Firefox, and WebKit is collapsed into ONE tests[] entry', async () => {
  const reporter = new ShorkyCloudReporter();

  const sharedFile = 'tests/cross-browser.spec.ts';
  const sharedTitle = 'checkout flow should complete';

  const chromeResult = makeResult({ status: 'failed', error: { message: 'Button not clickable' } });
  const chromeTest = makeTestCase('chrome-id', sharedTitle, [chromeResult], 'unexpected', {
    file: sharedFile,
    projectName: 'Google Chrome',
  });

  const firefoxResult = makeResult({ status: 'failed', error: { message: 'Button not clickable' } });
  const firefoxTest = makeTestCase('firefox-id', sharedTitle, [firefoxResult], 'unexpected', {
    file: sharedFile,
    projectName: 'firefox',
  });

  const webkitResult = makeResult({ status: 'failed', error: { message: 'Element detached from DOM' } });
  const webkitTest = makeTestCase('webkit-id', sharedTitle, [webkitResult], 'unexpected', {
    file: sharedFile,
    projectName: 'webkit',
  });

  // Each browser project produces its OWN TestCase (distinct `id`), exactly
  // as Playwright's real multi-browser matrix does — but all three share
  // the same spec file + title.
  reporter.onTestEnd(chromeTest, chromeResult);
  reporter.onTestEnd(firefoxTest, firefoxResult);
  reporter.onTestEnd(webkitTest, webkitResult);

  const payload = await runOnEndAndCapturePayload(reporter);

  assert.equal(payload.tests.length, 1, 'a single test failing across 3 browsers must collapse into ONE telemetry entry');
  assert.equal(payload.failedCount, 1, 'failedCount must only be incremented once for this test, not once per browser');
  assert.equal(payload.passedCount, 0);
  assert.equal(payload.tests[0].testName, sharedTitle);
  assert.equal(payload.tests[0].status, 'failed');

  const combinedMessage = payload.tests[0].traceLogs[0]?.message ?? '';
  assert.match(combinedMessage, /\[Google Chrome\] Button not clickable/);
  assert.match(combinedMessage, /\[firefox\] Button not clickable/);
  assert.match(combinedMessage, /\[webkit\] Element detached from DOM/);
});

test('onTestEnd + onEnd: a test passing on Chrome but failing on Firefox is still reported as FAILED overall', async () => {
  const reporter = new ShorkyCloudReporter();

  const sharedFile = 'tests/cross-browser.spec.ts';
  const sharedTitle = 'mixed-outcome test';

  const chromeResult = makeResult({ status: 'passed', error: undefined });
  const chromeTest = makeTestCase('chrome-id-2', sharedTitle, [chromeResult], 'expected', {
    file: sharedFile,
    projectName: 'Google Chrome',
  });

  const firefoxResult = makeResult({ status: 'failed', error: { message: 'Timed out waiting for selector' } });
  const firefoxTest = makeTestCase('firefox-id-2', sharedTitle, [firefoxResult], 'unexpected', {
    file: sharedFile,
    projectName: 'firefox',
  });

  reporter.onTestEnd(chromeTest, chromeResult);
  reporter.onTestEnd(firefoxTest, firefoxResult);

  const payload = await runOnEndAndCapturePayload(reporter);

  assert.equal(payload.tests.length, 1, 'still a single merged entry for the one logical test');
  assert.equal(payload.tests[0].status, 'failed', 'any failing browser must mark the merged test as failed overall');
  assert.equal(payload.failedCount, 1);
  assert.equal(payload.passedCount, 0);
});

test('onTestEnd + onEnd: a single-attempt (no retries) passing test still emits exactly one record', async () => {
  const reporter = new ShorkyCloudReporter();

  const onlyAttempt = makeResult({ status: 'passed', error: undefined });
  const test1 = makeTestCase('test-1', 'simple passing test', [onlyAttempt], 'expected');

  reporter.onTestEnd(test1, onlyAttempt);

  const payload = await runOnEndAndCapturePayload(reporter);
  assert.equal(payload.tests.length, 1);
  assert.equal(payload.tests[0].status, 'passed');
  assert.equal(payload.passedCount, 1);
});

test('onTestEnd + onEnd: strips ANSI color escape codes from the error message', async () => {
  const reporter = new ShorkyCloudReporter();

  const onlyAttempt = makeResult({
    status: 'failed',
    error: { message: '\x1b[31mTest timeout of 30000ms exceeded.\x1b[39m' },
  });
  const test1 = makeTestCase('test-1', 'ansi test', [onlyAttempt], 'unexpected');

  reporter.onTestEnd(test1, onlyAttempt);

  const payload = await runOnEndAndCapturePayload(reporter);
  const message = payload.tests[0].traceLogs[0]?.message ?? '';

  assert.equal(message, '[Google Chrome] Test timeout of 30000ms exceeded.');
  assert.doesNotMatch(message, /\x1b\[/, 'no raw ANSI escape sequence should remain in the stored message');
  assert.doesNotMatch(message, /\[31m|\[39m/, 'no visible "[31m"-style leftover should remain either');
});

test('onTestEnd + onEnd: does NOT add "[Attempt N/M]" prefixes when every retry fails with the identical (ANSI-stripped) error', async () => {
  const reporter = new ShorkyCloudReporter();

  // Same underlying message on every attempt, but wrapped in DIFFERENT
  // ANSI color codes (as Playwright often does) — these must be treated
  // as identical once stripped, so no "[Attempt N/M]" numbering is added.
  const attempt1 = makeResult({ status: 'timedOut', error: { message: '\x1b[31mTest timeout of 30000ms exceeded.\x1b[39m' } });
  const attempt2 = makeResult({ status: 'timedOut', error: { message: 'Test timeout of 30000ms exceeded.' } });
  const attempt3 = makeResult({ status: 'timedOut', error: { message: '\x1b[31mTest timeout of 30000ms exceeded.\x1b[0m' } });
  const results = [attempt1, attempt2, attempt3];
  const test1 = makeTestCase('test-1', 'repeatedly-identical failure', results, 'unexpected');

  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);
  reporter.onTestEnd(test1, attempt3);

  const payload = await runOnEndAndCapturePayload(reporter);
  const message = payload.tests[0].traceLogs[0]?.message ?? '';

  assert.equal(message, '[Google Chrome] Test timeout of 30000ms exceeded.');
  assert.doesNotMatch(message, /\[Attempt/, 'identical errors across retries must not be prefixed with attempt numbers');
});

test('onTestEnd + onEnd: DOES add "[Attempt N/M]" prefixes when retries fail with genuinely different errors', async () => {
  const reporter = new ShorkyCloudReporter();

  const attempt1 = makeResult({ status: 'timedOut', error: { message: 'Element not found: #submit' } });
  const attempt2 = makeResult({ status: 'timedOut', error: { message: 'Element not found: #confirm' } });
  const results = [attempt1, attempt2];
  const test1 = makeTestCase('test-1', 'genuinely different failures', results, 'unexpected');

  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);

  const payload = await runOnEndAndCapturePayload(reporter);
  const message = payload.tests[0].traceLogs[0]?.message ?? '';

  assert.match(message, /\[Attempt 1\/2\] Element not found: #submit/);
  assert.match(message, /\[Attempt 2\/2\] Element not found: #confirm/);
});

test('onTestEnd: does nothing when no API key is configured', () => {
  delete process.env.SHORKY_CLOUD_API_KEY;
  const reporter = new ShorkyCloudReporter();

  const onlyAttempt = makeResult({ status: 'failed' });
  const test1 = makeTestCase('test-1', 'unused', [onlyAttempt], 'unexpected');

  reporter.onTestEnd(test1, onlyAttempt);

  const testItems = Array.from((reporter as any).testResultsById.values());
  assert.equal(testItems.length, 0);
});
