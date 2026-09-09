// src/cli/__tests__/preflight.test.ts
//
// Unit/mock tests for the pre-flight budget guard (src/cli/preflight.ts).
// Run via Node's built-in test runner (no extra dependencies):
//   npm test        (node --import tsx --test "src/**/__tests__/**/*.test.ts")
//   npm run test:watch
//
// Strategy: mock global.fetch (the only I/O runPreflightCheck() performs)
// with node:test's built-in `mock.method`, and drive process.env directly
// since src/config/shorkyCloud.ts reads env vars live on every call (no
// module-level caching to worry about resetting between tests).
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// runPreflightCheck() is re-imported fresh in each test via a dynamic
// require after env vars are set, since Node's CJS module cache would
// otherwise reuse a stale `src/config/shorkyCloud.ts` import — in practice
// that module has no top-level state, but importing after env setup keeps
// the test's intent explicit and avoids any future caching foot-gun.
import { runPreflightCheck } from '../preflight';

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
  process.env.SHORKY_CLOUD_URL = 'http://localhost:3000/api/v1/telemetry';
  process.env.SHORKY_CLOUD_API_KEY = 'test-api-key';
});

afterEach(() => {
  mock.restoreAll();
  resetEnv();
});

test('runPreflightCheck: returns ok=true on 200 OK and calls fetch with the correct request', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (...args: FetchArgs) => {
    return jsonResponse(200, { success: true, tokensUsed: 100, monthlyTokenLimit: 1_000_000 });
  });

  const result = await runPreflightCheck();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.status, 200);
  assert.equal(fetchMock.mock.calls.length, 1);

  const [url, init] = fetchMock.mock.calls[0].arguments as FetchArgs;
  assert.equal(url, 'http://localhost:3000/api/v1/preflight');
  assert.equal(init?.method, 'POST');
  assert.equal((init?.headers as Record<string, string>)['x-shorky-api-key'], 'test-api-key');
  assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/json');
});

test('runPreflightCheck: returns ok=false with message on 402 Payment Required (subscription inactive)', async () => {
  mock.method(globalThis, 'fetch', async () =>
    jsonResponse(402, {
      success: false,
      error: 'Organization subscription is past_due. Reactivate your subscription to resume AI-powered self-healing.',
      subscriptionStatus: 'past_due',
    }),
  );

  const result = await runPreflightCheck();

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.status, 402);
  assert.match(result.message ?? '', /subscription is past_due/i);
});

test('runPreflightCheck: falls back to a default message on 402 when the response body is malformed', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('not json', { status: 402 }));

  const result = await runPreflightCheck();

  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(result.message, 'Organization subscription is not active.');
});

test('runPreflightCheck: returns ok=false with message on 429 Too Many Requests (token budget exceeded)', async () => {
  mock.method(globalThis, 'fetch', async () =>
    jsonResponse(429, {
      success: false,
      error: 'Monthly LLM token budget exceeded (2000000/1000000 tokens used). Self-healing is paused until next billing cycle or the limit is increased.',
      tokensUsed: 2_000_000,
      monthlyTokenLimit: 1_000_000,
    }),
  );

  const result = await runPreflightCheck();

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.status, 429);
  assert.match(result.message ?? '', /token budget exceeded/i);
});

test('runPreflightCheck: falls back to a default message on 429 when the response body is malformed', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('not json', { status: 429 }));

  const result = await runPreflightCheck();

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.message, 'Monthly LLM token budget exceeded.');
});

// --- Fail-open scenarios ---------------------------------------------
// A transient/unexpected cloud-side problem (timeout, connection refused,
// unrelated 5xx) must NEVER block the CI job on its own — only an explicit
// 402/429 response is a hard stop. See preflight.ts's module doc comment.

test('runPreflightCheck: fails OPEN (ok=true) on a simulated request timeout', async () => {
  mock.method(globalThis, 'fetch', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    throw timeoutError;
  });

  const result = await runPreflightCheck();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.status, undefined);
});

test('runPreflightCheck: fails OPEN (ok=true) on a simulated connection refusal (ECONNREFUSED)', async () => {
  mock.method(globalThis, 'fetch', async () => {
    const connError: any = new TypeError('fetch failed');
    connError.cause = { code: 'ECONNREFUSED' };
    throw connError;
  });

  const result = await runPreflightCheck();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
});

test('runPreflightCheck: fails OPEN (ok=true) on an unexpected 500 Internal Server Error', async () => {
  mock.method(globalThis, 'fetch', async () =>
    jsonResponse(500, { success: false, error: 'Internal Server Error' }),
  );

  const result = await runPreflightCheck();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.status, 500);
});

test('runPreflightCheck: fails OPEN (ok=true) on a 401 Invalid API Key rather than hard-blocking', async () => {
  mock.method(globalThis, 'fetch', async () =>
    jsonResponse(401, { success: false, error: 'Invalid API key' }),
  );

  const result = await runPreflightCheck();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.status, 401);
});

// --- Skip-path scenarios -----------------------------------------------

test('runPreflightCheck: skips entirely (ok=true, skipped=true) and never calls fetch when no API key is configured', async () => {
  delete process.env.SHORKY_CLOUD_API_KEY;
  const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(200, { success: true }));

  const result = await runPreflightCheck();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('runPreflightCheck: skips entirely when Shorky Cloud is not enabled (no SHORKY_CLOUD_URL, ENABLE_SHORKY_CLOUD unset)', async () => {
  delete process.env.SHORKY_CLOUD_URL;
  delete process.env.ENABLE_SHORKY_CLOUD;
  const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(200, { success: true }));

  const result = await runPreflightCheck();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(fetchMock.mock.calls.length, 0);
});
