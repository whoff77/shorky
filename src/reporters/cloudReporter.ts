import { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';
import { getShorkyCloudApiKey, getShorkyCloudTelemetryUrl, isShorkyCloudEnabled, logDashboardCallToAction } from '../config/shorkyCloud';
import { SHORKY_TOKENS_ATTACHMENT_NAME } from '../fixtures/autoHealFixture';
import { resolveRepositoryName } from '../utils/gitContext';
import { runPreflightCheck } from '../cli/preflight';
import { getExecutionId } from '../utils/executionId';
import { resolveCleanErrorMessage } from '../utils/format';

/** One browser (Playwright project)'s final snapshot for a given test, after combining all of ITS OWN retry attempts. */
interface BrowserAttemptSnapshot {
  status: 'passed' | 'failed' | 'healed';
  /** Already prefixed with `[${projectName}] `, e.g. `"[firefox] Timeout exceeded"`. */
  error?: string;
  tokensUsed: number;
}

interface TestRunItem {
  title: string;
  status: 'passed' | 'failed' | 'healed';
  error?: string;
  /** LLM tokens consumed self-healing/asserting-vision during this test, extracted from the `SHORKY_TOKENS_ATTACHMENT_NAME` attachment (see `autoHealFixture.ts`). */
  tokensUsed: number;
  /**
   * Per-browser (Playwright project) snapshots, keyed by `test.id` (which IS
   * unique per project — see TestCase.id — unlike the `${file}::${title}`
   * key this entry itself lives under in `testResultsById`). Used so that
   * (a) retries of the SAME browser simply overwrite that browser's own
   * slot here, while (b) a DIFFERENT browser running the identical test
   * merges into this same `TestRunItem` instead of creating a sibling
   * duplicate — see the multi-browser matrix dedup in `onTestEnd()`.
   */
  browserResults: Map<string, BrowserAttemptSnapshot>;
}

// ANSI-stripping utilities (`stripAnsiCodes`/`resolveCleanErrorMessage`)
// now live in `../utils/format` (imported above) so `fixTrace.ts` can apply
// the exact same cleanup to the `/api/webhook` payload and LLM prompt
// context, instead of duplicating this logic.

/**
 * Extracts the LLM token count `autoHealFixture.ts` attached to this test
 * result (see `SHORKY_TOKENS_ATTACHMENT_NAME`), if any. Attachments cross
 * the worker-process -> main-process boundary as plain buffers/strings, so
 * this parses the attachment body back into a number, defensively falling
 * back to 0 for any malformed/missing attachment rather than throwing.
 */
function extractTokensUsed(result: TestResult): number {
  const attachment = result.attachments.find((a) => a.name === SHORKY_TOKENS_ATTACHMENT_NAME);
  if (!attachment) return 0;

  const raw = attachment.body ? attachment.body.toString('utf-8') : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export default class ShorkyCloudReporter implements Reporter {
  private apiEndpoint: string;
  private apiKey: string;
  // Accumulates ONE entry per LOGICAL test, keyed by a COMPOSITE
  // `${test.location.file}::${test.title}` string — deliberately NOT
  // `test.id`, because `test.id` is unique per (file, title, PROJECT)
  // triple (see TestCase.id), so the same test running across the
  // Chrome/firefox/webkit matrix (playwright.config.ts's `projects`)
  // produces a DIFFERENT `test.id` per browser. Keying by `test.id` was
  // the root cause of a single broken test across 3 browsers showing up
  // as 3 separate telemetry failures and triggering 3 separate auto-heal
  // attempts. Keying by file+title instead means every browser's attempt
  // at the SAME test converges on the same Map entry.
  //
  // Playwright invokes `onTestEnd()` once per ATTEMPT — the initial run
  // plus every retry (see @playwright/test's runner, which calls
  // `reporter.onTestEnd?.(test, result)` synchronously after each attempt
  // finishes) — and, critically, `result` is ALREADY the last element of
  // `test.results` at the moment ANY attempt's `onTestEnd` fires
  // (Playwright appends it in `_onTestBegin()`, before the attempt even
  // runs). That means a "is this the final attempt?" check comparing
  // `result` against `test.results[test.results.length - 1]` is always
  // true and never actually filters anything out — the real fix is to
  // never treat any individual `onTestEnd()` call as final. Instead, each
  // call OVERWRITES only its own browser's slot (see
  // `TestRunItem.browserResults`, keyed by `test.id`, which IS stable
  // across retries of the SAME browser) — so retries of one browser never
  // clobber another browser's already-recorded outcome for the same test
  // — and the merged `status`/`error`/`tokensUsed` across ALL browsers is
  // recomputed every time from `browserResults`.
  private testResultsById = new Map<string, TestRunItem>();

  constructor() {
    this.apiEndpoint = getShorkyCloudTelemetryUrl();
    this.apiKey = getShorkyCloudApiKey();
  }

  onBegin(config: FullConfig, suite: Suite) {
    if (!this.apiKey) {
      console.log('ℹ️ [Shorky] SHORKY_CLOUD_API_KEY not found. Skipping cloud reporting.');
      logDashboardCallToAction();
      return;
    }
    console.log('🚀 [Shorky] Initializing Shorky Cloud reporting run...');
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.apiKey) return;

    let testStatus: 'passed' | 'failed' | 'healed' = 'passed';

    // `test.outcome()` reflects Playwright's own final verdict across all
    // retries observed SO FAR ('flaky' once a later attempt passed after
    // earlier failures, 'unexpected' once every attempt so far failed) —
    // preferred over inspecting `result.status` in isolation so a
    // flaky-but-ultimately-passing test is correctly reported as passed
    // rather than failed. Because this entry is overwritten on every
    // attempt and only read back in `onEnd()` after the whole run
    // finishes, whatever `outcome()` reports on the LAST `onTestEnd()`
    // call for this test (i.e. after its final attempt) is authoritative.
    const outcome = test.outcome();
    if (outcome === 'expected' || outcome === 'flaky') {
      testStatus = 'passed';
    } else if (outcome === 'unexpected') {
      testStatus = 'failed';
    }
    // outcome() === 'skipped' intentionally leaves testStatus at its
    // 'passed' default, matching this reporter's previous behavior for
    // skipped/interrupted results. NOTE: this is THIS BROWSER'S status —
    // see the merge step below for how it's combined across all browsers.

    // Combine the error message from EVERY attempt failed SO FAR (not just
    // this one) so the final overwritten entry reflects the full retry
    // history once the last attempt's onTestEnd() call overwrites it. Each
    // attempt's message is ANSI-stripped first (see resolveCleanErrorMessage)
    // so the stored/dashboard-rendered text never contains raw terminal
    // color codes like "[31m".
    const failedAttempts = test.results.filter((r) => r.status === 'failed' || r.status === 'timedOut');
    const cleanedFailedMessages = failedAttempts.map(resolveCleanErrorMessage);
    // A retried test very often fails with the EXACT same error on every
    // attempt (e.g. the same broken selector timing out identically each
    // time) — in that case there's nothing useful about numbering them, so
    // only prefix with "[Attempt N/M]" when the attempts' messages
    // actually DIFFER from one another; otherwise just report the single
    // shared message once.
    const uniqueFailedMessages = Array.from(new Set(cleanedFailedMessages));
    const combinedBrowserMessage =
      uniqueFailedMessages.length > 1
        ? cleanedFailedMessages.map((msg, i) => `[Attempt ${i + 1}/${cleanedFailedMessages.length}] ${msg}`).join('\n')
        : uniqueFailedMessages[0] ?? (testStatus === 'failed' ? resolveCleanErrorMessage(result) : undefined);

    // Prefix with the Playwright project (browser) name — e.g. "[firefox]
    // ..." — so once this browser's message is merged alongside every
    // OTHER browser's message for the same logical test below, the
    // combined log explicitly lists which browser(s) failed instead of
    // presenting one anonymous, ambiguous error string.
    const projectName = test.parent.project()?.name || 'unknown';
    const browserErrorMessage = combinedBrowserMessage !== undefined ? `[${projectName}] ${combinedBrowserMessage}` : undefined;

    // Tokens are attached per-attempt (see autoHealFixture.ts); sum across
    // every attempt observed so far, for THIS browser, so retried
    // self-healing spend is never undercounted once only the final
    // overwritten slot is read back.
    const browserTokensUsed = test.results.reduce((sum, r) => sum + extractTokensUsed(r), 0);

    // Deduplicate the multi-browser matrix: a single logical test run
    // across Chrome/firefox/webkit (see playwright.config.ts's `projects`)
    // produces a SEPARATE `TestCase` — with its own distinct `test.id` —
    // per browser. Keying this outer Map by `${file}::${title}` instead of
    // `test.id` means every browser's TestCase converges on the SAME
    // `TestRunItem`, collapsing N browser failures into 1 telemetry entry.
    const testKey = `${test.location.file}::${test.title}`;
    let item = this.testResultsById.get(testKey);
    if (!item) {
      item = { title: test.title, status: 'passed', tokensUsed: 0, browserResults: new Map() };
      this.testResultsById.set(testKey, item);
    }

    // OVERWRITE (never push/append) only THIS BROWSER's slot, keyed by its
    // own stable `test.id`. A retried attempt of the SAME browser already
    // wrote a slot here; this call simply replaces it. A DIFFERENT browser
    // running the identical test writes to its own distinct slot instead,
    // so one browser's retries can never clobber another browser's
    // already-recorded outcome.
    item.browserResults.set(test.id, {
      status: testStatus,
      error: browserErrorMessage,
      tokensUsed: browserTokensUsed,
    });

    // Re-derive the merged, cross-browser view from scratch every time a
    // browser's slot changes: if ANY browser ultimately failed, the test
    // as a whole is reported as failed (a passing Chrome run must never
    // mask a genuine Firefox/WebKit failure); tokens are summed across
    // every browser; and every browser's (already browser-prefixed) error
    // message is combined into one log entry.
    const browserSnapshots = Array.from(item.browserResults.values());
    item.status = browserSnapshots.some((b) => b.status === 'failed')
      ? 'failed'
      : browserSnapshots.some((b) => b.status === 'healed')
        ? 'healed'
        : 'passed';
    item.tokensUsed = browserSnapshots.reduce((sum, b) => sum + b.tokensUsed, 0);
    const combinedMessages = browserSnapshots.map((b) => b.error).filter((msg): msg is string => !!msg);
    item.error = combinedMessages.length > 0 ? combinedMessages.join('\n') : undefined;
  }

  async onEnd(result: FullResult) {
    const cloudUrl = getShorkyCloudTelemetryUrl();

    // Skip attempting transmission entirely if cloud is explicitly disabled
    if (!isShorkyCloudEnabled()) {
      console.log('ℹ️ [Shorky Cloud] Telemetry transmission skipped (SHORKY_CLOUD_API_KEY not configured).');
      return;
    }

    try {
      // Governance pre-check: ask shorky-cloud's tier-aware
      // `/api/v1/governance/preflight` whether it will actually accept
      // telemetry before paying the network round-trip to
      // `/api/v1/telemetry`. A free-tier project that has hit its cloud
      // storage quota gets `acceptsTelemetry: false` here — previously
      // the CLI always POSTed the payload anyway and relied on
      // `/api/v1/telemetry`'s own server-side drop behavior (still in
      // place as a safety net), wasting the round-trip. `undefined`
      // (check skipped/failed open, or Pro tier with no storage quota)
      // is treated as "proceed" — only an explicit `false` skips the POST.
      const preflight = await runPreflightCheck();
      if (preflight.acceptsTelemetry === false) {
        console.log(
          `ℹ️ [Shorky Cloud] Skipping telemetry transmission: ${preflight.message || 'free tier cloud storage quota reached.'}`,
        );
        return;
      }

      console.log(`📤 [Shorky Cloud] Transmitting run artifacts to ${cloudUrl}...`);

      // Read the accumulated per-test Map back out ONLY here, once the
      // entire run has finished — every test's entry has by now been
      // overwritten down to its single final-attempt snapshot PER BROWSER,
      // then merged across every browser that ran it (see onTestEnd()'s
      // doc comment and the `browserResults` merge step), so `testItems`
      // below is naturally deduplicated with exactly one record per
      // LOGICAL test — not one per (test, browser, retry) combination —
      // and the passed/failed totals computed from it are never inflated
      // by retries OR by the multi-browser matrix.
      const testItems = Array.from(this.testResultsById.values());
      const passedCount = testItems.filter((item) => item.status === 'passed').length;
      const failedCount = testItems.filter((item) => item.status === 'failed').length;
      const durationMs = Math.round(result.duration ?? 0);
      // Sum of every test's tokensUsed (captured from OpenAI response.usage
      // during self-healing/vision calls — see tokenUsage.ts and
      // autoHealFixture.ts). Reported both per-test and as a run-level
      // total below; shorky-cloud's /api/v1/telemetry uses the run-level
      // total when present, atomically incrementing that project's
      // tokensUsedThisMonth for the /api/v1/governance/preflight budget guard.
      const totalTokensUsed = testItems.reduce((sum, item) => sum + item.tokensUsed, 0);

      // Standardized repo identity (GITHUB_REPOSITORY -> local .git/config
      // -> "local/unknown") — see gitContext.ts. Split into repoOwner/repoName
      // and sent in the exact same shape `fixTrace.ts`'s notifyShorkyCloud()
      // sends, so the dashboard shows a consistent repo identity for both
      // the run-level telemetry (this reporter) and the per-fix webhook.
      const [repoOwner, repoName] = resolveRepositoryName().split('/');

      // Resolve the SAME shared execution ID `fixTrace.ts`'s
      // notifyShorkyCloud()/notifyShorkyCloudBatch() resolve for this exact
      // CI run (see executionId.ts's getExecutionId()) — prioritizing the
      // numeric GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT (deterministically hashed
      // into UUID shape), so this reporter (running in the Playwright test
      // process) and the separate Shorky CLI process (running afterwards,
      // as its own GitHub Actions step) always tag their respective
      // telemetry/webhook dispatches with the identical runId instead of
      // each independently minting its own random UUID.
      const runId = getExecutionId();

      // Construct the flattened payload matching shorky-cloud's Zod schema
      const telemetryPayload = {
        projectName: process.env.SHORKY_PROJECT_NAME || 'shorky',
        repoOwner,
        repoName,
        runId,
        status: failedCount > 0 ? 'failed' : 'passed',
        passedCount,
        failedCount,
        durationMs,
        tokensUsed: totalTokensUsed,
        tests: testItems.map((item) => ({
          testName: item.title,
          status: item.status,
          traceLogs: item.error 
            ? [{
                step: 1,
                action: 'test_execution',
                status: item.status === 'failed' ? 'failed' : 'success',
                timestamp: new Date().toISOString(),
                message: item.error,
              }]
            : [],
          selfHealingCount: item.status === 'healed' ? 1 : 0,
          tokensUsed: item.tokensUsed,
        }))
      };

      const response = await fetch(cloudUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-shorky-api-key': getShorkyCloudApiKey(),
        },
        body: JSON.stringify(telemetryPayload),
        // Set a short timeout so offline runs don't hang execution
        signal: AbortSignal.timeout(3000), 
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('⚠️ [Shorky Cloud] Backend responded with status:', response.status, JSON.stringify(errorData, null, 2));
      } else {
        console.log('✅ [Shorky Cloud] Telemetry successfully transmitted.');
        logDashboardCallToAction();
      }
    } catch (error: any) {
      // Gracefully log offline status without throwing an unhandled stack trace
      if (error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TimeoutError') {
        console.warn('ℹ️ [Shorky Cloud] Cloud server unavailable. Continuing offline execution.');
      } else {
        console.warn('⚠️ [Shorky Cloud] Telemetry warning:', error?.message || error);
      }
    }
  }
}