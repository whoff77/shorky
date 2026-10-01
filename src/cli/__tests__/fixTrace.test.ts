// src/cli/__tests__/fixTrace.test.ts
//
// Regression tests for the two telemetry bugs described in the task:
//
//   1. File-level dedup dropping additional failing tests in the same spec
//      file (`collectFailedSpecsFromReport` used to key by specPath alone).
//   2. The "4/5" batching leak, where a fix silently failed to reach the
//      final `notifyShorkyCloudBatch()` payload.
//
// Run via Node's built-in test runner (no extra dependencies):
//   npm test
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  collectFailedSpecsFromReport,
  notifyShorkyCloudBatch,
  updateVisualBaseline,
  computeStage1Telemetry,
  dispatchStage1Telemetry,
} from '../fixTrace';
import type { HealedFixEntry } from '../../utils/githubPr';
import type { PreflightResult } from '../preflight';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetEnv();
  process.env.GITHUB_REPOSITORY = 'whoff77/shorky';
});

afterEach(() => {
  mock.restoreAll();
  resetEnv();
});

// --- collectFailedSpecsFromReport: composite-key dedup -------------------

test('collectFailedSpecsFromReport: preserves BOTH failing tests when a single spec file has two distinct failures', () => {
  const report = {
    suites: [
      {
        specs: [],
        suites: [
          {
            specs: [
              {
                file: 'dynamic-form-elements.spec.ts',
                title: 'checkbox should toggle correctly',
                tests: [
                  {
                    results: [
                      {
                        status: 'failed',
                        error: { message: 'Checkbox not found' },
                        attachments: [{ name: 'trace', path: '/tmp/checkbox-trace.zip' }],
                      },
                    ],
                  },
                ],
              },
              {
                file: 'dynamic-form-elements.spec.ts',
                title: 'dropdown should select an option',
                tests: [
                  {
                    results: [
                      {
                        status: 'failed',
                        error: { message: 'Dropdown option missing' },
                        attachments: [{ name: 'trace', path: '/tmp/dropdown-trace.zip' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const failures = collectFailedSpecsFromReport(report as any);

  assert.equal(failures.length, 2, 'both distinct failing tests in the same spec file must be preserved');
  const titles = failures.map((f) => f.testTitle).sort();
  assert.deepEqual(titles, ['checkbox should toggle correctly', 'dropdown should select an option']);

  const specPaths = new Set(failures.map((f) => f.specPath));
  assert.equal(specPaths.size, 1, 'both failures should target the same spec file path');
});

test('collectFailedSpecsFromReport: still dedupes multiple retries of the EXACT same test', () => {
  const report = {
    suites: [
      {
        specs: [
          {
            file: 'broken-login-flow.spec.ts',
            title: 'user should be able to log in',
            tests: [
              {
                results: [
                  { status: 'failed', error: { message: 'attempt 1 failed' } },
                  { status: 'failed', error: { message: 'attempt 2 (final) failed' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const failures = collectFailedSpecsFromReport(report as any);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].testTitle, 'user should be able to log in');
  assert.equal(failures[0].errorLog, 'attempt 2 (final) failed');
});

test('collectFailedSpecsFromReport: reproduces the reported scenario — 5 failing tests across 4 files, one file with 2', () => {
  const makeSpec = (file: string, title: string) => ({
    file,
    title,
    tests: [{ results: [{ status: 'failed', error: { message: `${title} failed` } }] }],
  });

  const report = {
    suites: [
      {
        specs: [
          makeSpec('broken-login-flow.spec.ts', 'user should be able to log in'),
          makeSpec('dynamic-form-elements.spec.ts', 'checkbox should toggle correctly'),
          makeSpec('dynamic-form-elements.spec.ts', 'dropdown should select an option'),
          makeSpec('another-flow.spec.ts', 'another test'),
          makeSpec('yet-another-flow.spec.ts', 'yet another test'),
        ],
      },
    ],
  };

  const failures = collectFailedSpecsFromReport(report as any);

  assert.equal(failures.length, 5, 'all 5 originally-failing tests must be present, none dropped');
  const uniqueSpecPaths = new Set(failures.map((f) => f.specPath));
  assert.equal(uniqueSpecPaths.size, 4, 'the 5 failures should map back to exactly 4 distinct spec files');
});

// --- collectFailedSpecsFromReport: cross-browser matrix dedup ------------

test('collectFailedSpecsFromReport: a test failing on Chrome, firefox, AND webkit is only processed ONCE', () => {
  const makeBrowserTest = (projectName: string, message: string) => ({
    projectName,
    results: [{ status: 'failed', error: { message } }],
  });

  const report = {
    suites: [
      {
        specs: [
          {
            file: 'checkout-flow.spec.ts',
            title: 'checkout flow should complete',
            // Playwright's JSON reporter merges every project's run of the
            // same spec+title into ONE shared `tests[]` array — one entry
            // per browser, in whatever order the workers happened to finish.
            tests: [
              makeBrowserTest('webkit', 'Element detached from DOM'),
              makeBrowserTest('firefox', 'Timed out waiting for selector'),
              makeBrowserTest('Google Chrome', 'Button not clickable'),
            ],
          },
        ],
      },
    ],
  };

  const failures = collectFailedSpecsFromReport(report as any);

  assert.equal(failures.length, 1, 'a single test failing across 3 browsers must only be processed once');
  assert.equal(failures[0].testTitle, 'checkout flow should complete');
});

test('collectFailedSpecsFromReport: prefers the Chromium instance\'s error/trace even when it is NOT the first browser seen', () => {
  const report = {
    suites: [
      {
        specs: [
          {
            file: 'checkout-flow.spec.ts',
            title: 'checkout flow should complete',
            tests: [
              {
                projectName: 'webkit',
                results: [
                  {
                    status: 'failed',
                    error: { message: 'webkit error' },
                    attachments: [{ name: 'trace', path: '/tmp/webkit-trace.zip' }],
                  },
                ],
              },
              {
                projectName: 'Google Chrome',
                results: [
                  {
                    status: 'failed',
                    error: { message: 'chrome error' },
                    attachments: [{ name: 'trace', path: '/tmp/chrome-trace.zip' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const failures = collectFailedSpecsFromReport(report as any);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorLog, 'chrome error', 'the Chromium instance\'s trace/error is preferred over webkit\'s, regardless of array order');
  assert.equal(failures[0].traceZipPath, '/tmp/chrome-trace.zip');
});

// --- notifyShorkyCloudBatch: no silent drops -----------------------------

function makeHealedFix(overrides: Partial<HealedFixEntry>): HealedFixEntry {
  return {
    specPath: 'tests/example.spec.ts',
    explanation: 'Fixed the thing.',
    fixedCode: 'test("example", async () => {});',
    testName: 'example test',
    tokensUsed: 10,
    ...overrides,
  };
}

test('notifyShorkyCloudBatch: dispatches every notifiable fix exactly once, including a test that used to be dropped', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(200, { message: 'OK' }));

  const fixes: HealedFixEntry[] = [
    makeHealedFix({ specPath: 'tests/broken-login-flow.spec.ts', testName: 'user should be able to log in' }),
    makeHealedFix({ specPath: 'tests/dynamic-form-elements.spec.ts', testName: 'checkbox should toggle correctly' }),
    // Second test from the SAME file — this is the exact entry that used
    // to be dropped by the old specPath-only dedup logic.
    makeHealedFix({ specPath: 'tests/dynamic-form-elements.spec.ts', testName: 'dropdown should select an option' }),
    makeHealedFix({ specPath: 'tests/another-flow.spec.ts', testName: 'another test' }),
    makeHealedFix({ specPath: 'tests/yet-another-flow.spec.ts', testName: 'yet another test' }),
  ];

  await notifyShorkyCloudBatch(fixes, 'shared-run-id');

  assert.equal(fetchMock.mock.calls.length, 5, 'every one of the 5 healed fixes must be dispatched — none silently dropped');

  const dispatchedTestNames = fetchMock.mock.calls.map((call) => {
    const [, init] = call.arguments as FetchArgs;
    const body = JSON.parse((init?.body as string) || '{}');
    return body.testName;
  });

  assert.deepEqual(
    dispatchedTestNames.sort(),
    [
      'another test',
      'checkbox should toggle correctly',
      'dropdown should select an option',
      'user should be able to log in',
      'yet another test',
    ].sort()
  );
});

test('notifyShorkyCloudBatch: skips only visual-regression / codeless entries, dispatching everything else', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(200, { message: 'OK' }));

  const fixes: HealedFixEntry[] = [
    makeHealedFix({ specPath: 'tests/a.spec.ts', testName: 'a' }),
    makeHealedFix({ specPath: 'tests/b.spec.ts', testName: 'b', isVisualRegression: true, fixedCode: undefined }),
    makeHealedFix({ specPath: 'tests/c.spec.ts', testName: 'c' }),
  ];

  await notifyShorkyCloudBatch(fixes, 'shared-run-id');

  assert.equal(fetchMock.mock.calls.length, 2, 'visual-regression entries have no fixedCode and are intentionally not webhook-dispatched');
});

test('notifyShorkyCloudBatch: does nothing (no fetch calls) when there are no notifiable fixes', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(200, { message: 'OK' }));

  await notifyShorkyCloudBatch([], 'shared-run-id');

  assert.equal(fetchMock.mock.calls.length, 0);
});

// --- updateVisualBaseline: "Auto-Accept Visual Baselines" -----------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shorky-visual-baseline-'));
}

test('updateVisualBaseline: overwrites the baseline PNG with the actual screenshot bytes', () => {
  const dir = makeTempDir();
  try {
    const expectedPath = path.join(dir, '__snapshots__', 'example.spec.ts', 'sample.png');
    const actualPath = path.join(dir, 'test-results', 'sample-actual.png');

    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.mkdirSync(path.dirname(actualPath), { recursive: true });
    fs.writeFileSync(expectedPath, Buffer.from('old-baseline-bytes'));
    fs.writeFileSync(actualPath, Buffer.from('new-actual-bytes'));

    const result = updateVisualBaseline({ expectedPath, actualPath });

    assert.equal(result, true, 'should report success when both paths exist');
    assert.equal(fs.readFileSync(expectedPath, 'utf-8'), 'new-actual-bytes', 'baseline should now contain the actual screenshot bytes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateVisualBaseline: returns false and leaves nothing changed when expectedPath/actualPath are missing', () => {
  assert.equal(updateVisualBaseline(undefined), false);
  assert.equal(updateVisualBaseline({}), false);
  assert.equal(updateVisualBaseline({ expectedPath: '/tmp/does-not-matter.png' }), false);
});

test('updateVisualBaseline: returns false when the actual screenshot does not exist on disk', () => {
  const dir = makeTempDir();
  try {
    const expectedPath = path.join(dir, 'sample.png');
    const actualPath = path.join(dir, 'sample-actual.png'); // never created

    fs.writeFileSync(expectedPath, Buffer.from('old-baseline-bytes'));

    const result = updateVisualBaseline({ expectedPath, actualPath });

    assert.equal(result, false);
    assert.equal(fs.readFileSync(expectedPath, 'utf-8'), 'old-baseline-bytes', 'baseline must be left untouched on failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- computeStage1Telemetry: Stage 1 "run artifacts" telemetry -----------
//
// Regression coverage for the architectural fix described in the task:
// since GitHub Action consumers never load `cloudReporter.ts`, Stage 1
// telemetry must be computed directly from the Playwright JSON report by
// `fixTrace.ts` itself.

function makeMinimalReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    stats: { duration: 12345 },
    suites: [],
    ...overrides,
  };
}

test('computeStage1Telemetry: counts passed/failed tests and reports run duration from report.stats', () => {
  const report = makeMinimalReport({
    suites: [
      {
        specs: [
          {
            file: 'login.spec.ts',
            title: 'user should be able to log in',
            tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
          },
          {
            file: 'checkout.spec.ts',
            title: 'checkout should fail gracefully',
            tests: [
              {
                status: 'unexpected',
                results: [{ status: 'failed', error: { message: 'Timeout exceeded' } }],
              },
            ],
          },
        ],
      },
    ],
  });

  const result = computeStage1Telemetry(report as any);

  assert.equal(result.passedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.durationMs, 12345);
  assert.equal(result.tests.length, 2);

  const failedEntry = result.tests.find((t) => t.testName === 'checkout should fail gracefully');
  assert.ok(failedEntry, 'failed test entry should exist');
  assert.equal(failedEntry!.status, 'failed');
  assert.equal(failedEntry!.traceLogs[0]?.message, 'Timeout exceeded');

  const passedEntry = result.tests.find((t) => t.testName === 'user should be able to log in');
  assert.ok(passedEntry, 'passed test entry should exist');
  assert.equal(passedEntry!.status, 'passed');
  assert.deepEqual(passedEntry!.traceLogs, []);
});

test('computeStage1Telemetry: treats "flaky" and "skipped" as passed, matching cloudReporter.ts semantics', () => {
  const report = makeMinimalReport({
    suites: [
      {
        specs: [
          {
            file: 'flaky.spec.ts',
            title: 'eventually passes after a retry',
            tests: [{ status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }],
          },
          {
            file: 'skipped.spec.ts',
            title: 'intentionally skipped test',
            tests: [{ status: 'skipped', results: [] }],
          },
        ],
      },
    ],
  });

  const result = computeStage1Telemetry(report as any);

  assert.equal(result.passedCount, 2);
  assert.equal(result.failedCount, 0);
});

test('computeStage1Telemetry: deduplicates a test run across multiple browser projects, failing if ANY browser failed', () => {
  const report = makeMinimalReport({
    suites: [
      {
        specs: [
          {
            file: 'cross-browser.spec.ts',
            title: 'renders the homepage',
            tests: [
              { status: 'expected', projectName: 'Google Chrome', results: [{ status: 'passed' }] },
              {
                status: 'unexpected',
                projectName: 'firefox',
                results: [{ status: 'failed', error: { message: 'Firefox-only failure' } }],
              },
            ],
          },
        ],
      },
    ],
  });

  const result = computeStage1Telemetry(report as any);

  assert.equal(result.tests.length, 1, 'both browser runs of the same test must merge into a single entry');
  assert.equal(result.passedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.tests[0].traceLogs[0]?.message, 'Firefox-only failure');
});

test('computeStage1Telemetry: recurses into nested suites', () => {
  const report = makeMinimalReport({
    suites: [
      {
        specs: [],
        suites: [
          {
            specs: [
              {
                file: 'nested.spec.ts',
                title: 'nested suite test',
                tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
              },
            ],
          },
        ],
      },
    ],
  });

  const result = computeStage1Telemetry(report as any);

  assert.equal(result.tests.length, 1);
  assert.equal(result.passedCount, 1);
});

// --- dispatchStage1Telemetry: gating + payload dispatch -------------------

function makePreflight(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return { ok: true, skipped: false, ...overrides };
}

test('dispatchStage1Telemetry: does not call fetch when SHORKY_CLOUD_API_KEY is not configured', async () => {
  delete process.env.SHORKY_CLOUD_API_KEY;
  const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(200, { success: true }));

  await dispatchStage1Telemetry(makeMinimalReport() as any, 'run-id-1', makePreflight());

  assert.equal(fetchMock.mock.calls.length, 0);
});

test('dispatchStage1Telemetry: does not call fetch when preflight.acceptsTelemetry is explicitly false', async () => {
  process.env.SHORKY_CLOUD_API_KEY = 'test-key';
  const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(200, { success: true }));

  await dispatchStage1Telemetry(
    makeMinimalReport() as any,
    'run-id-2',
    makePreflight({ acceptsTelemetry: false, message: 'quota reached' })
  );

  assert.equal(fetchMock.mock.calls.length, 0);
});

test('dispatchStage1Telemetry: POSTs the telemetry payload to getShorkyCloudTelemetryUrl() when enabled and accepted', async () => {
  process.env.SHORKY_CLOUD_API_KEY = 'test-key';
  process.env.GITHUB_REPOSITORY = 'whoff77/shorky';

  let capturedUrl: string | URL | Request | undefined;
  let capturedBody: any;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    capturedUrl = input;
    capturedBody = JSON.parse((init?.body as string) || '{}');
    return jsonResponse(200, { success: true });
  });

  const report = makeMinimalReport({
    stats: { duration: 5000 },
    suites: [
      {
        specs: [
          {
            file: 'a.spec.ts',
            title: 'a passing test',
            tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
          },
        ],
      },
    ],
  });

  await dispatchStage1Telemetry(report as any, 'shared-run-id', makePreflight({ acceptsTelemetry: true }));

  assert.equal(fetchMock.mock.calls.length, 1);
  assert.match(String(capturedUrl), /\/api\/v1\/telemetry$/);
  assert.equal(capturedBody.runId, 'shared-run-id');
  assert.equal(capturedBody.repoOwner, 'whoff77');
  assert.equal(capturedBody.repoName, 'shorky');
  assert.equal(capturedBody.passedCount, 1);
  assert.equal(capturedBody.failedCount, 0);
  assert.equal(capturedBody.durationMs, 5000);
  assert.equal(capturedBody.status, 'passed');
});

test('dispatchStage1Telemetry: gracefully warns (does not throw) when the cloud endpoint is unreachable', async () => {
  process.env.SHORKY_CLOUD_API_KEY = 'test-key';
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });

  await assert.doesNotReject(
    dispatchStage1Telemetry(makeMinimalReport() as any, 'run-id-3', makePreflight())
  );
});
