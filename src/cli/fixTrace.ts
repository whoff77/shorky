import fs from 'fs';
import path from 'path';
import { parsePlaywrightTrace, resolveSpecSourcePath, isVisualRegressionFailure } from '../engine/traceParser';
import { generateSpecFix, FixResult } from '../engine/codeFixer';
import { getShorkyCloudApiKey, getShorkyCloudWebhookUrl, logDashboardCallToAction } from '../config/shorkyCloud';
import { runPreflightCheck } from './preflight';
import { HealedFixEntry, openHealingPullRequest, pushConsolidatedHealingBranch, stageHealingFix } from '../utils/githubPr';
import { overwriteSpecInPlace } from '../utils/specWriter';
import { resolveRepositoryName } from '../utils/gitContext';
import { getExecutionId } from '../utils/executionId';

import dotenv from 'dotenv';
dotenv.config();

/**
 * Hard runtime guard invoked immediately before every `openHealingPullRequest()`
 * call site. Individual PR creation must NEVER happen while a batch report
 * run is in progress — that's the exact root cause of duplicate individual
 * PRs (e.g. #47, #48) appearing alongside the single consolidated PR.
 * Throwing here (rather than merely logging) makes it structurally
 * impossible for a future refactor to accidentally invoke
 * `openHealingPullRequest()` from the batch path without an immediate,
 * loud failure.
 */
function assertIndividualPrAllowed(specPath: string, batchMode: boolean): void {
  if (batchMode) {
    throw new Error(
      `Invariant violation: attempted to call openHealingPullRequest() for "${specPath}" while batchMode=true. Individual PR creation is strictly forbidden during batch report runs — only the single consolidated pull request (via pushConsolidatedHealingBranch) may be created.`
    );
  }
}

/**
 * Sends the final repaired code and trace context to shorky-cloud,
 * ensuring it only triggers once per successful offline fix.
 *
 * Only used for the standalone (`--trace`/`--spec`) single-fix flow. Batch
 * report runs (`runReportFix`) intentionally skip this per-spec dispatch —
 * see `notifyShorkyCloudBatch` — so a single report with N failed specs
 * only ever produces one webhook call, not N.
 */
async function notifyShorkyCloud(
  specPath: string, 
  fixResult: { fixedCode: string; explanation: string }, 
  traceZipPath?: string | null,
  errorLog?: string | null,
  runId?: string,
  testName?: string | null,
  tokensUsed?: number
) {
  const [repoOwner, repoName] = resolveRepositoryName().split('/');
  const sanitizedSpecPath = specPath.replace(/^\/+/, '');
  const payload = {
    repoOwner,
    repoName,
    branch: process.env.GITHUB_REF_NAME || process.env.BRANCH || 'main',
    specPath: sanitizedSpecPath,
    testName: testName || undefined,
    traceZipPath: traceZipPath || null,
    errorLog: errorLog || null,
    fixedCode: fixResult.fixedCode,
    explanation: fixResult.explanation,
    runId: runId || undefined,
    // LLM tokens consumed generating this fix (see codeFixer.ts's
    // response.usage.total_tokens, threaded through HealedFixEntry.tokensUsed).
    // shorky-cloud's /api/webhook uses this to atomically increment
    // projects.tokensUsedThisMonth for BYOK self-healing runs -- without it,
    // the free-tier budget guard never reflects standalone/webhook-driven
    // healing spend (only the separate cloudReporter.ts /api/v1/telemetry
    // path was previously wired up to do this).
    tokensUsed: tokensUsed || 0,
  };

  // [DIAGNOSTIC] Print the exact outgoing webhook payload (minus the API
  // key, which is sent as a header, not in the body) right before the
  // request is dispatched. This is the single source of truth for
  // confirming which runId a given spec's telemetry was actually tagged
  // with — critical for tracing down split/duplicate Neon run IDs.
  console.log(`📤 [Diagnostic] shorky-cloud webhook payload for "${sanitizedSpecPath}":`, JSON.stringify(payload, null, 2));

  const webhookUrl = getShorkyCloudWebhookUrl();
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shorky-api-key': getShorkyCloudApiKey(),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      console.warn(`⚠️ shorky-cloud webhook responded with status ${res.status}:`, JSON.stringify(errorData));
    } else {
      const data = await res.json();
      console.log(`🎉 Webhook dispatched successfully: ${data.prUrl || data.message || 'OK'}`);
    }
  } catch (err: any) {
    console.warn(`⚠️ Failed to trigger shorky-cloud webhook:`, err.message || err);
  }
}

/**
 * Notifies shorky-cloud of every fix produced during a batch `runReportFix()`
 * run, sharing the same suite-wide `runId` so every dispatch is grouped
 * under a single run card on the dashboard.
 *
 * shorky-cloud's `/api/webhook` endpoint validates the request body against
 * a *flat* Zod schema requiring non-empty top-level `specPath`, `fixedCode`,
 * and `explanation` strings — it has no concept of a batched/nested
 * `fixes: [...]` array. Sending one combined request with a nested array
 * (and no top-level `specPath`/`fixedCode`/`explanation`) fails Zod
 * validation with a 400 "Invalid payload" error on every batch run.
 *
 * To stay compatible with that schema while still avoiding a fresh/duplicate
 * PR per spec, this dispatches one flat, schema-shaped webhook request per
 * healed code fix — reusing the exact same payload shape as
 * `notifyShorkyCloud()` — but all sharing `runId` so shorky-cloud attaches
 * every trace to the same test run rather than creating N separate runs.
 * Visual-regression handoff entries have no generated code (`fixedCode` is
 * required/non-empty by the schema) and are intentionally skipped here;
 * they're already fully represented in the consolidated PR body.
 */
export async function notifyShorkyCloudBatch(
  fixes: HealedFixEntry[],
  runId: string
) {
  const notifiable = fixes.filter((fix) => !fix.isVisualRegression && !!fix.fixedCode && !!fix.specPath);

  // [DIAGNOSTIC] Print the aggregated batch structure right before any
  // network calls are made — this is the single choke point every batch
  // notification passes through, so if Neon ever shows split run IDs again,
  // this log immediately reveals whether the bug is upstream (multiple
  // distinct runIds reaching this function) or downstream (this function
  // failing to propagate the shared runId into individual dispatches).
  console.log(
    `📋 [Diagnostic] notifyShorkyCloudBatch: dispatching ${notifiable.length}/${fixes.length} fix(es) under shared runId="${runId}":`,
    JSON.stringify(
      notifiable.map((fix) => ({ specPath: fix.specPath, testName: fix.testName, hasFixedCode: !!fix.fixedCode, isVisualRegression: !!fix.isVisualRegression })),
      null,
      2
    )
  );

  // [DIAGNOSTIC] Explicitly call out any fix entries EXCLUDED from
  // `notifiable`, and why, so a future "N/(N+1) fix(es)" log line is never
  // a silent mystery again — every drop is now individually accounted for.
  const skipped = fixes.filter((fix) => !notifiable.includes(fix));
  if (skipped.length > 0) {
    console.log(
      `📋 [Diagnostic] notifyShorkyCloudBatch: ${skipped.length} fix(es) excluded from this dispatch:`,
      JSON.stringify(
        skipped.map((fix) => ({
          specPath: fix.specPath,
          testName: fix.testName,
          reason: fix.isVisualRegression
            ? 'isVisualRegression=true (already represented in the PR body, no webhook needed)'
            : !fix.fixedCode
            ? 'missing fixedCode'
            : !fix.specPath
            ? 'missing specPath'
            : 'unknown',
        })),
        null,
        2
      )
    );
  }

  if (notifiable.length === 0) {
    console.log('ℹ️ No code-fix entries with fixedCode to report to shorky-cloud for this batch.');
    return;
  }

  for (const fix of notifiable) {
    console.log(`➡️  [Diagnostic] Notifying shorky-cloud for "${fix.specPath}" using shared batch runId="${runId}" (consolidated path — no per-fix runId is generated here).`);
    await notifyShorkyCloud(
      fix.specPath,
      { fixedCode: fix.fixedCode as string, explanation: fix.explanation },
      fix.traceZipPath,
      fix.errorLog,
      runId,
      fix.testName,
      fix.tokensUsed
    );
  }

  // Single summary CTA for the whole batch, printed once after every fix in
  // this run has been dispatched (rather than per-fix, which would spam the
  // log with the same line N times for an N-fix batch).
  logDashboardCallToAction();
}

// --- Playwright JSON Report Parsing (--report support) ---

interface ReportAttachment {
  name: string;
  path?: string;
  contentType?: string;
}

interface ReportResultError {
  message?: string;
  stack?: string;
}

interface ReportResult {
  status?: string;
  error?: ReportResultError;
  errors?: ReportResultError[];
  attachments?: ReportAttachment[];
}

interface ReportTest {
  results?: ReportResult[];
}

interface ReportSpec {
  file?: string;
  /** The Playwright test title for this spec entry (e.g. "user should be able to log in"). */
  title?: string;
  tests?: ReportTest[];
}

interface ReportSuite {
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}

interface PlaywrightJsonReport {
  suites?: ReportSuite[];
}

/** Expected/actual/diff PNG paths Playwright generates for a failed visual snapshot comparison. */
export interface VisualDiffArtifacts {
  expectedPath?: string;
  actualPath?: string;
  diffPath?: string;
}

/**
 * "Auto-Accept Visual Baselines": overwrites the local baseline PNG
 * (`visualDiff.expectedPath`, which is the exact on-disk path under
 * `__snapshots__/` that Playwright's `toHaveScreenshot()` compares against
 * — see `extractVisualDiffArtifacts`) with the newly captured "actual"
 * screenshot from the failing run (`visualDiff.actualPath`, written by
 * Playwright to `test-results/<test-dir>/`).
 *
 * Returns true when the write succeeded (both paths were present and the
 * actual screenshot existed on disk), false otherwise — callers must treat
 * a false return as "leave this as a manual-review visual diff handoff"
 * rather than silently claiming the baseline was updated.
 */
export function updateVisualBaseline(visualDiff: VisualDiffArtifacts | undefined): boolean {
  if (!visualDiff?.expectedPath || !visualDiff?.actualPath) {
    console.warn(
      '⚠️ [Auto-Accept Visual Baselines] Missing expected/actual PNG path(s) — cannot overwrite the baseline. Falling back to manual review.'
    );
    return false;
  }

  if (!fs.existsSync(visualDiff.actualPath)) {
    console.warn(
      `⚠️ [Auto-Accept Visual Baselines] Actual screenshot not found on disk: ${visualDiff.actualPath}. Falling back to manual review.`
    );
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(visualDiff.expectedPath), { recursive: true });
    fs.copyFileSync(visualDiff.actualPath, visualDiff.expectedPath);
    console.log(
      `🖼️ [Auto-Accept Visual Baselines] Overwrote baseline "${visualDiff.expectedPath}" with the new actual screenshot from this run.`
    );
    return true;
  } catch (err: any) {
    console.warn(
      `⚠️ [Auto-Accept Visual Baselines] Failed to overwrite baseline "${visualDiff.expectedPath}":`,
      err.message || err
    );
    return false;
  }
}

export interface FailedSpecInfo {
  specPath: string;
  /**
   * The Playwright test title for this specific failing test (e.g. "user
   * should be able to log in"), extracted from the JSON report entry's
   * `spec.title`. Used to key each failure uniquely (see
   * `collectFailedSpecsFromReport`) so multiple DISTINCT failing tests
   * inside the SAME spec file are never dropped/overwritten, and to
   * populate `HealedFixEntry.testName` / the shorky-cloud telemetry
   * payload's `testName` for each one.
   */
  testTitle?: string;
  traceZipPath?: string;
  errorLog?: string;
  /** True when this failure is a visual regression (screenshot/pixel) mismatch, not a DOM/action failure. */
  isVisualRegression?: boolean;
  /** Populated only when isVisualRegression is true. */
  visualDiff?: VisualDiffArtifacts;
}

/**
 * Extracts the expected/actual/diff PNG attachment paths Playwright records
 * for a failed `toHaveScreenshot`/`toMatchSnapshot` assertion. Playwright
 * names these attachments `<snapshotName>-expected.png`,
 * `<snapshotName>-actual.png`, and `<snapshotName>-diff.png` respectively.
 */
function extractVisualDiffArtifacts(attachments: ReportAttachment[] | undefined): VisualDiffArtifacts {
  const artifacts: VisualDiffArtifacts = {};
  for (const attachment of attachments || []) {
    if (!attachment.path) continue;
    if (/-expected\.png$/i.test(attachment.name)) {
      artifacts.expectedPath = attachment.path;
    } else if (/-actual\.png$/i.test(attachment.name)) {
      artifacts.actualPath = attachment.path;
    } else if (/-diff\.png$/i.test(attachment.name)) {
      artifacts.diffPath = attachment.path;
    }
  }
  return artifacts;
}

/**
 * Extracted for testability: parses a Playwright JSON report and returns the
 * list of distinct failing tests. Exported so unit tests can exercise the
 * composite-key dedup logic directly without going through the full
 * `runReportFix()` CLI flow.
 */
export function collectFailedSpecsFromReport(report: PlaywrightJsonReport): FailedSpecInfo[] {
  // Keyed by a COMPOSITE `${resolvedSpecPath}::${testTitle}` key so that
  // (a) multiple retries of the exact same test never produce duplicate
  // entries, but (b) multiple DISTINCT failing tests inside the same spec
  // file (e.g. two failing `test(...)` blocks in dynamic-form-elements.spec.ts)
  // are each preserved as their own entry rather than the second one being
  // silently dropped. Keying by specPath alone here was the root cause of
  // failing tests going missing from both the healing pass and the
  // telemetry payload whenever a single file had more than one failure.
  const failuresBySpec = new Map<string, FailedSpecInfo>();

  function walk(suite: ReportSuite) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        if (results.length === 0) continue;

        // Playwright records one entry per attempt (initial run + each
        // retry) in chronological order. The *last* entry reflects the
        // final/terminal outcome of the test and is what determines whether
        // the test is considered failed overall.
        const finalResult = results[results.length - 1];

        if (finalResult.status !== 'failed' && finalResult.status !== 'timedOut') {
          continue;
        }

        // Depending on the configured `trace` mode (e.g. 'on-first-retry'),
        // the *final* attempt is not guaranteed to carry its own trace.zip
        // attachment — only an earlier retry might have one. Search every
        // attempt from most-recent to oldest and use the first trace.zip we
        // find, so we never report a false "N/A" when a usable trace exists
        // on an earlier attempt. (With trace: 'retain-on-failure'/'on', every
        // failed attempt has its own trace, so this simply picks the final
        // attempt's trace in that case.)
        let traceAttachment: ReportAttachment | undefined;
        for (let i = results.length - 1; i >= 0; i--) {
          traceAttachment = results[i].attachments?.find((a) => a.name === 'trace' && !!a.path);
          if (traceAttachment) break;
        }

        // Map the raw report entry back to the exact original source test
        // file path on disk (see resolveSpecSourcePath in traceParser.ts),
        // so the in-place healing overwrite always targets the same file
        // Playwright actually ran and failed.
        const resolvedSpecPath = resolveSpecSourcePath(spec.file) || spec.file || 'unknown-spec';
        const testTitle = spec.title || undefined;

        // Deduplicate by a COMPOSITE `specPath::testTitle` key: keep the
        // first failure recorded for a given (file, test) pair so retries of
        // the exact same test never produce duplicate entries, while still
        // preserving every DISTINCT failing test within the same spec file.
        const dedupeKey = `${resolvedSpecPath}::${testTitle || ''}`;
        if (failuresBySpec.has(dedupeKey)) {
          continue;
        }

        const errorLog = finalResult.error?.message || finalResult.errors?.[0]?.message;

        // Detect visual regression (screenshot/pixel-diff) failures so they
        // can be routed into "Visual Diff Handoff" mode instead of the
        // normal LLM code-repair flow — adjusting selectors/actions can
        // never fix a genuine pixel discrepancy.
        const isVisual = isVisualRegressionFailure(errorLog);
        let visualDiff: VisualDiffArtifacts | undefined;
        if (isVisual) {
          // Scan every attempt (most-recent first) for the expected/actual/
          // diff PNGs, mirroring the trace-attachment lookup above, in case
          // they don't happen to live on the final result entry.
          for (let i = results.length - 1; i >= 0; i--) {
            const candidate = extractVisualDiffArtifacts(results[i].attachments);
            if (candidate.expectedPath || candidate.actualPath || candidate.diffPath) {
              visualDiff = candidate;
              break;
            }
          }
        }

        failuresBySpec.set(dedupeKey, {
          specPath: resolvedSpecPath,
          testTitle,
          traceZipPath: traceAttachment?.path,
          errorLog,
          isVisualRegression: isVisual,
          visualDiff,
        });
      }
    }

    for (const child of suite.suites || []) {
      walk(child);
    }
  }

  for (const suite of report.suites || []) {
    walk(suite);
  }

  return Array.from(failuresBySpec.values());
}

/**
 * Resolves the single shared run identifier that every worker/spec in this
 * Playwright execution should be tagged with, so that a multi-worker run
 * (see `shorky-test-consumer`'s `workers` config) still produces ONE batch
 * report / consolidated PR / telemetry dispatch instead of fragmenting per
 * worker.
 *
 * Resolution order (first match wins):
 *   1. `SHORKY_RUN_ID` env var — set directly by the caller (e.g. an
 *      orchestrating CI step), or inherited from the Playwright test
 *      process if `fixTrace.ts` happens to run as a child of it.
 *   2. `<reportDir>/.shorky-run-id` — the file written by the consuming
 *      project's `global-setup.ts` *before* Playwright forks any worker
 *      process. Since `globalSetup` runs once in the parent process prior
 *      to worker spawn, every worker inherits the same in-memory
 *      `SHORKY_RUN_ID`, and this file lets that identifier survive across
 *      process boundaries into this separate `fixTrace.ts` invocation
 *      (which typically runs as its own GitHub Actions step/process, after
 *      the Playwright process has already exited).
 *   3. A freshly minted UUID — used only when neither of the above is
 *      available (e.g. local ad-hoc runs without global-setup.ts wired up),
 *      preserving the previous behavior for those cases.
 */
function resolveSuiteRunId(reportPath: string): string {
  // Delegates to the shared getExecutionId() util (see executionId.ts) so
  // this CLI process and the separate Playwright reporter process
  // (cloudReporter.ts) always resolve to the SAME identifier —
  // prioritizing GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT (numeric, automatically
  // shared by GitHub Actions across every step), then SHORKY_RUN_ID, then
  // the `.shorky-run-id` deterministic file handoff located next to the
  // report file (matching where global-setup.ts/cloudReporter.ts write it).
  return getExecutionId(path.dirname(path.resolve(reportPath)));
}

export interface RunReportFixOptions {
  reportPath: string;
  /**
   * "Auto-Accept Visual Baselines": when true, every visual regression
   * failure discovered in this report has its local baseline PNG
   * automatically overwritten with the newly captured "actual" screenshot
   * (via `updateVisualBaseline()`) and staged into the consolidated PR,
   * instead of being left as a manual-review-only handoff entry. Defaults
   * to false (existing "flag for human review" behavior), opted into via
   * the CLI's `--update-baselines` flag / the GitHub Action's
   * `update-visual-baselines` input.
   */
  updateBaselines?: boolean;
}

export async function runReportFix({ reportPath, updateBaselines = false }: RunReportFixOptions) {
  // Pre-flight budget guard: abort BEFORE any LLM repair loop starts if the
  // org's subscription is inactive (402) or its monthly token budget is
  // exhausted (429). This gates the entire batch report run, since every
  // failure in the report would otherwise trigger its own billable
  // generateSpecFix() call. Fails the CI job normally (non-zero exit) with
  // the reason logged, rather than proceeding into the LLM loop.
  const preflight = await runPreflightCheck();
  if (!preflight.ok) {
    console.error(`🛑 [Shorky] Aborting self-healing run: ${preflight.message}`);
    process.exit(1);
  }

  const absoluteReportPath = path.resolve(reportPath);

  if (!fs.existsSync(absoluteReportPath)) {
    console.error(`❌ Report file not found: ${absoluteReportPath}`);
    process.exit(1);
  }

  // Resolve (not mint) a single suite-wide runId to group all healed traces
  // under one run card — reusing the exact identifier established by
  // global-setup.ts before Playwright spawned its parallel workers whenever
  // one is available, so a multi-worker run still produces one batch/PR.
  // Every failure discovered in this report is processed with batchMode:
  // true (see the runOfflineFix() call below) and shares this exact
  // suiteRunId — no per-fix runId is ever minted while inside this function.
  const suiteRunId = resolveSuiteRunId(reportPath);
  console.log(`🔍 Resolving failed specs and traces from Playwright JSON report: ${reportPath} (Run ID: ${suiteRunId})...`);
  // [DIAGNOSTIC] Explicitly print the execution mode and generated run ID at
  // the very start of the batch run, before any spec is touched, so it's
  // trivially clear in the logs which mode this invocation is running in
  // and which single runId every fix in this run should be tagged with.
  console.log(`🧭 [Diagnostic] runReportFix() starting — batchMode=true (enforced) for all specs in this report, suiteRunId="${suiteRunId}".`);

  const report: PlaywrightJsonReport = JSON.parse(fs.readFileSync(absoluteReportPath, 'utf-8'));
  const failures = collectFailedSpecsFromReport(report);

  if (failures.length === 0) {
    console.log('✅ No failed tests found in report. Nothing to do.');
    return;
  }

  console.log(`🎯 Found ${failures.length} failed test(s) in report.`);

  // Group failures by resolved specPath: a single spec file may have
  // multiple distinct failing tests (see `collectFailedSpecsFromReport`'s
  // composite-key dedup), but there is only one file on disk to repair. All
  // failures sharing a specPath are processed together as a single group —
  // one `runOfflineFix()` call per file (using the FIRST failure's trace as
  // the "primary" one parsed for DOM/selector context, with every other
  // failing test's title/error passed along via `additionalFailingTests` so
  // the LLM prompt explicitly covers all of them) — while still producing
  // one distinct `HealedFixEntry`/telemetry record per originally-failing
  // test.
  const failuresBySpecPath = new Map<string, FailedSpecInfo[]>();
  for (const failure of failures) {
    const group = failuresBySpecPath.get(failure.specPath);
    if (group) {
      group.push(failure);
    } else {
      failuresBySpecPath.set(failure.specPath, [failure]);
    }
  }

  console.log(
    `🗂️ [Diagnostic] Grouped ${failures.length} failing test(s) into ${failuresBySpecPath.size} spec file(s) to repair: ` +
      JSON.stringify(
        Array.from(failuresBySpecPath.entries()).map(([specPath, group]) => ({
          specPath,
          testCount: group.length,
          testTitles: group.map((f) => f.testTitle || '(untitled)'),
        }))
      )
  );

  // Every fix generated during this run is staged (committed) onto the
  // same shared healing branch (batchMode: true below) rather than each
  // opening its own branch/PR. Once all failures have been processed, a
  // single consolidated pull request is pushed containing every fix.
  const healedFixes: HealedFixEntry[] = [];

  const specGroups = Array.from(failuresBySpecPath.entries());

  for (const [groupIndex, [groupSpecPath, group]] of specGroups.entries()) {
    console.log(
      `\n🔗 [Diagnostic] Spec group ${groupIndex + 1}/${specGroups.length} ("${groupSpecPath}", ${group.length} failing test(s)) entering the CONSOLIDATED batch path — batchMode=true, runId="${suiteRunId}" (no individual PR or unique runId will be generated for this spec).`
    );

    // Visual regressions are never LLM-repaired, so each one in this group
    // is handled independently and produces its own HealedFixEntry
    // immediately, regardless of how many other (code-fixable) failures
    // share the same spec file.
    const visualFailures = group.filter((f) => f.isVisualRegression);
    const codeFailures = group.filter((f) => !f.isVisualRegression);

    for (const failure of visualFailures) {
      console.log(`🖼️ Detected a visual regression failure for ${failure.specPath} ("${failure.testTitle || 'unknown test'}").`);
      if (failure.visualDiff?.expectedPath) console.log(`   - Expected: ${failure.visualDiff.expectedPath}`);
      if (failure.visualDiff?.actualPath) console.log(`   - Actual:   ${failure.visualDiff.actualPath}`);
      if (failure.visualDiff?.diffPath) console.log(`   - Diff:     ${failure.visualDiff.diffPath}`);

      // "Auto-Accept Visual Baselines": opted-in via --update-baselines /
      // update-visual-baselines. Bypasses LLM code repair either way (a
      // genuine pixel discrepancy can never be fixed by adjusting
      // selectors/actions) — the only difference is whether the new
      // screenshot is automatically accepted as the baseline or left for a
      // human to review.
      const baselineUpdated = updateBaselines && updateVisualBaseline(failure.visualDiff);

      const visualHandoffFix: HealedFixEntry = {
        specPath: failure.specPath,
        explanation: baselineUpdated
          ? 'Visual regression detected — the new screenshot was automatically accepted as the updated baseline (--update-baselines / update-visual-baselines enabled).'
          : 'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
        errorLog: failure.errorLog,
        isVisualRegression: true,
        baselineUpdated,
        visualDiff: failure.visualDiff,
        testName: failure.testTitle || path.basename(failure.specPath),
      };

      if (!baselineUpdated) {
        console.log(`🖼️ Bypassing LLM code repair (Visual Diff Handoff) for "${failure.specPath}".`);
      }

      try {
        stageHealingFix(visualHandoffFix);
        console.log(
          baselineUpdated
            ? `🌿 [Diagnostic] Staged auto-updated visual baseline for "${failure.specPath}" onto the shared consolidated healing branch (no PR opened yet).`
            : `🌿 [Diagnostic] Staged visual diff handoff entry for "${failure.specPath}" onto the shared consolidated healing branch (no PR opened yet).`
        );
      } catch (err: any) {
        console.warn(`⚠️ Failed to stage the visual regression entry for ${failure.specPath}:`, err.message || err);
      }
      healedFixes.push(visualHandoffFix);
    }

    if (codeFailures.length === 0) {
      continue;
    }

    // Every code-fixable failure in this group targets the SAME file on
    // disk — there is exactly one repair pass to make. The first failure
    // with a usable trace.zip becomes the "primary" one (its trace is
    // parsed for DOM/selector context); every OTHER code-fixable failure in
    // the group is passed along as `additionalFailingTests` so the LLM
    // prompt explicitly covers every failing test, not just the primary
    // one — see `runOfflineFix`'s `additionalFailingTests` option.
    const primaryFailure = codeFailures.find(
      (f) => f.traceZipPath && fs.existsSync(path.resolve(f.traceZipPath))
    );

    console.log(`\n🎯 Target Spec: ${groupSpecPath} (${codeFailures.length} failing test(s) in this file)`);
    for (const f of codeFailures) {
      console.log(`💥 [${f.testTitle || 'unknown test'}] ${f.errorLog || 'No error message captured'}`);
    }

    if (!primaryFailure) {
      console.warn(`⚠️ Skipping offline fix for ${groupSpecPath} — none of its ${codeFailures.length} failing test(s) have a usable trace.zip on disk. [Diagnostic] No individual fallback path is taken here; this spec is simply omitted from the batch.`);
      continue;
    }

    const resolvedTraceZipPath = path.resolve(primaryFailure.traceZipPath as string);
    const resolvedSpecFsPath = path.resolve(groupSpecPath);

    if (fs.existsSync(resolvedSpecFsPath)) {
      const otherCodeFailures = codeFailures.filter((f) => f !== primaryFailure);

      try {
        const healedFixesForSpec = await runOfflineFix({
          tracePath: resolvedTraceZipPath,
          specPath: groupSpecPath,
          batchMode: true,
          runId: suiteRunId,
          additionalFailingTests: otherCodeFailures.map((f) => ({
            testTitle: f.testTitle,
            errorLog: f.errorLog,
            traceZipPath: f.traceZipPath,
          })),
        });
        if (healedFixesForSpec) {
          healedFixes.push(...healedFixesForSpec);
          console.log(`✅ [Diagnostic] ${healedFixesForSpec.length} fix record(s) for "${groupSpecPath}" collected into the batch (total staged so far: ${healedFixes.length}). Still no PR/webhook fired — deferred until the batch loop completes.`);
        }
      } catch (err) {
        console.error(`❌ Error running fixTrace for ${groupSpecPath}:`, err instanceof Error ? err.message : err);
      }
    } else {
      console.warn(`⚠️ Skipping offline fix for ${groupSpecPath} — missing on disk: spec file (${resolvedSpecFsPath}). [Diagnostic] No individual fallback path is taken here; this spec is simply omitted from the batch.`);
    }
  }

  if (healedFixes.length === 0) {
    console.log('ℹ️ No fixes were successfully generated. Skipping pull request creation.');
    return;
  }

  // [DIAGNOSTIC] Print the full aggregated batch structure exactly once,
  // right before it is handed to the GitHub API (pushConsolidatedHealingBranch)
  // and to notifyShorkyCloudBatch. This is the definitive proof point that
  // all N fixes collected during the loop above are being aggregated into a
  // single call rather than leaking into per-fix PR/webhook calls.
  console.log(
    `📦 [Diagnostic] Aggregated batch payload (${healedFixes.length} fix(es), suiteRunId="${suiteRunId}") about to be sent as ONE consolidated branch push / GitHub API PR call:`,
    JSON.stringify(
      healedFixes.map((fix) => ({ specPath: fix.specPath, testName: fix.testName, isVisualRegression: !!fix.isVisualRegression, hasFixedCode: !!fix.fixedCode })),
      null,
      2
    )
  );

  console.log(`\n📦 Pushing consolidated healing branch with ${healedFixes.length} fix(es)...`);
  const prUrl = await pushConsolidatedHealingBranch(healedFixes);

  if (!prUrl) {
    console.warn(
      `⚠️ No pull request was opened for ${healedFixes.length} healed spec(s). Ensure GITHUB_TOKEN and GITHUB_REPOSITORY are set, and that the workflow grants "contents: write" and "pull-requests: write" permissions.`
    );
  } else {
    console.log(`✅ [Diagnostic] Exactly one consolidated pull request handled for this batch run: ${prUrl}`);
  }

  // Notify shorky-cloud of every code fix in this batch. Each dispatch uses
  // the schema-required flat { specPath, fixedCode, explanation } shape (see
  // notifyShorkyCloudBatch's doc comment for why a single nested payload
  // isn't viable against shorky-cloud's current Zod schema), but all share
  // the same suiteRunId so they're grouped under a single run card rather
  // than registering a separate run per spec.
  await notifyShorkyCloudBatch(healedFixes, suiteRunId);
}

/**
 * A failing test in the SAME spec file as the "primary" trace being
 * repaired, discovered during a batch `runReportFix()` run — see
 * `RunOfflineFixOptions.additionalFailingTests`.
 */
export interface AdditionalFailingTest {
  /** The Playwright test title for this additional failing test. */
  testTitle?: string;
  /** This test's own captured error message/log. */
  errorLog?: string;
  /** This test's own trace.zip path, if one was captured (for reference/telemetry only — not re-parsed). */
  traceZipPath?: string;
}

export interface RunOfflineFixOptions {
  tracePath: string;
  specPath: string;
  batchMode?: boolean;
  runId?: string;
  /**
   * Set by callers (e.g. `src/cli/index.ts`'s `handleHealOnFailure()`) that
   * have already performed `runPreflightCheck()` themselves immediately
   * before invoking this function, so it isn't repeated as a redundant
   * network call. Defaults to false so any other caller (including
   * `fixTrace.ts` invoked directly as its own CLI entrypoint, per
   * `action.yml`) is still guarded even if it forgets to check first.
   */
  skipPreflightCheck?: boolean;
  /**
   * Other tests that failed in the SAME spec file during this batch run
   * (see `runReportFix`'s per-specPath grouping step). When present, their
   * titles/error logs are combined with the primary trace's own failure
   * context into a single prompt sent to `generateSpecFix()`, so the LLM is
   * explicitly told it must repair every failing test in the file — not
   * just the one whose trace happens to be used for DOM/selector analysis.
   * The single resulting fix is written to disk exactly once, but a
   * separate `HealedFixEntry` is returned for the primary test AND for
   * each entry here, so telemetry accurately reflects one repair record
   * per originally-failing test.
   */
  additionalFailingTests?: AdditionalFailingTest[];
  /**
   * "Auto-Accept Visual Baselines" (see `RunReportFixOptions.updateBaselines`).
   * NOTE: the standalone (`--trace`/`--spec`) flow parses only the raw
   * trace.zip (`parsePlaywrightTrace()`), which does not carry the
   * expected/actual/diff PNG attachment paths Playwright only records on
   * the JSON report (`--report`) — see `extractVisualDiffArtifacts` in this
   * file. Without a resolvable baseline path, enabling this flag here has
   * no effect beyond a logged warning; the report-driven batch flow
   * (`runReportFix`) is the fully-supported path for this feature.
   */
  updateBaselines?: boolean;
}

export async function runOfflineFix({
  tracePath,
  specPath,
  batchMode = false,
  runId,
  skipPreflightCheck = false,
  additionalFailingTests,
  updateBaselines = false,
}: RunOfflineFixOptions): Promise<HealedFixEntry[] | null> {
  // Pre-flight budget guard: only run here for the standalone (non-batch)
  // --trace/--spec invocation. Batch runs (runReportFix) already perform
  // this check exactly once before the loop that calls runOfflineFix() for
  // each failure — re-checking per-spec here would be redundant network
  // calls and could abort mid-batch after some fixes already succeeded.
  if (!batchMode && !skipPreflightCheck) {
    const preflight = await runPreflightCheck();
    if (!preflight.ok) {
      console.error(`🛑 [Shorky] Aborting self-healing run: ${preflight.message}`);
      process.exit(1);
    }
  }

  const absoluteTracePath = path.resolve(tracePath);
  const absoluteSpecPath = path.resolve(specPath);

  // Hard invariant: in batch mode, the caller (runReportFix) MUST supply the
  // shared suiteRunId explicitly. Silently falling through to a fresh
  // randomUUID() here — even just once — would mint a unique run ID for
  // this single fix, which is the exact root cause of split Neon run
  // records across a single batch report run. Fail loudly instead of
  // silently generating a divergent runId.
  if (batchMode && !runId) {
    throw new Error(
      `runOfflineFix() invariant violation: batchMode=true but no runId was supplied for "${specPath}". Every fix processed during a batch run must reuse the caller's shared suiteRunId — refusing to fall back to a freshly generated UUID.`
    );
  }

  // Standalone (non-batch) invocation with no explicit runId supplied:
  // resolve the shared execution ID the SAME way cloudReporter.ts does
  // (GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT, then SHORKY_RUN_ID, then the
  // `.shorky-run-id` file handoff, only falling back to a freshly minted
  // UUID as a last resort) — rather than unconditionally minting a new
  // UUID here, which is what previously caused this CLI process and the
  // Playwright reporter process to disagree on the run identifier.
  const effectiveRunId = runId || getExecutionId();

  // [DIAGNOSTIC] Print the evaluated batchMode flag and the runId this
  // invocation will actually use. When called from runReportFix(), batchMode
  // must always be `true` and `runId` must always equal the caller's
  // suiteRunId — if effectiveRunId ever differs from a passed-in `runId`,
  // that means `runId` was falsy and a brand-new UUID was minted here,
  // which is exactly the root cause of split Neon run IDs.
  console.log(
    `🧪 [Diagnostic] runOfflineFix("${specPath}") — batchMode=${batchMode}, incoming runId=${runId ? `"${runId}"` : 'undefined'}, effectiveRunId="${effectiveRunId}"` +
      (runId && runId !== effectiveRunId ? ' ⚠️ MISMATCH — a new UUID was generated instead of reusing the shared runId!' : '')
  );

  if (!fs.existsSync(absoluteTracePath)) {
    console.error(`❌ Trace file not found: ${absoluteTracePath}`);
    if (!batchMode) process.exit(1);
    return null;
  }

  if (!fs.existsSync(absoluteSpecPath)) {
    console.error(`❌ Spec file not found: ${absoluteSpecPath}`);
    if (!batchMode) process.exit(1);
    return null;
  }

  console.log(`🔍 Unpacking and analyzing trace: ${tracePath}...`);
  const failureContext = await parsePlaywrightTrace(absoluteTracePath);

  if (!failureContext.failedSelector && !failureContext.errorMessage) {
    console.warn('⚠️ No explicit failure event found in the trace.');
  } else {
    console.log(`💡 Detected Failure:`);
    console.log(`   - Action: ${failureContext.actionMethod}`);
    console.log(`   - Selector: ${failureContext.failedSelector}`);
    console.log(`   - Error: ${failureContext.errorMessage}`);
  }

  if (isVisualRegressionFailure(failureContext.errorMessage)) {
    console.log(`🖼️ Detected a visual regression failure for ${specPath}. Bypassing LLM code repair (Visual Diff Handoff).`);

    if (updateBaselines) {
      console.warn(
        `⚠️ [Auto-Accept Visual Baselines] --update-baselines has no effect on the standalone (--trace/--spec) flow for "${specPath}" — the raw trace.zip doesn't carry the expected/actual PNG attachment paths needed to locate the baseline. Use the --report / runReportFix batch flow instead. Falling back to manual review.`
      );
    }

    const visualHandoffFix: HealedFixEntry = {
      specPath,
      explanation:
        'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
      errorLog: failureContext.errorMessage,
      isVisualRegression: true,
      testName: failureContext.testTitle || path.basename(specPath),
    };

    if (batchMode) {
      console.log(`🔗 [Diagnostic] "${specPath}" (visual regression) entering the CONSOLIDATED path — staging only, no individual PR.`);
      try {
        stageHealingFix(visualHandoffFix);
      } catch (err: any) {
        console.warn(`⚠️ Failed to stage the visual diff handoff entry for ${specPath}:`, err.message || err);
      }
    } else {
      // [DIAGNOSTIC] This is the INDIVIDUAL PR fallback path. It must only
      // ever be reached for the standalone (--trace/--spec) CLI flow, never
      // from a batch runReportFix() run — that's what causes the "split
      // run IDs" / duplicate individual PR bug (e.g. PR #42, #43) when it
      // fires per spec during batch processing.
      console.warn(`🚨 [Diagnostic] "${specPath}" (visual regression) is entering the INDIVIDUAL PR fallback path (batchMode=false). This must never happen during a batch report run.`);
      assertIndividualPrAllowed(specPath, batchMode);
      const prUrl = await openHealingPullRequest(visualHandoffFix);
      if (!prUrl) {
        console.warn(`⚠️ No pull request was opened for the visual regression review entry for ${specPath}.`);
      }
    }

    return [visualHandoffFix];
  }

  console.log(`\n🤖 Sending failure context & ${specPath} to LLM Fixer...`);
  const originalSpecCode = fs.readFileSync(absoluteSpecPath, 'utf-8');

  // The trace's own testTitle (if any) identifies the "primary" failing
  // test whose trace we actually parsed for DOM/selector context. When
  // other tests in the SAME spec file also failed (see
  // `additionalFailingTests`, populated by runReportFix()'s per-specPath
  // grouping step), combine every failing test's title + error message
  // into a single prompt so the LLM is explicitly told it must repair ALL
  // of them — not just the one whose trace happens to be available. This
  // does NOT change how many HealedFixEntry records are ultimately
  // produced/reported (still one per originally-failing test); it only
  // changes what's sent to generateSpecFix() so the single resulting fix
  // actually addresses every failure in the file.
  const primaryTestTitle = failureContext.testTitle || path.basename(specPath);
  const promptFailureContext =
    additionalFailingTests && additionalFailingTests.length > 0
      ? {
          ...failureContext,
          errorMessage: [
            `This spec file has ${additionalFailingTests.length + 1} FAILING TESTS that must ALL be fixed by this single repair:`,
            `1. "${primaryTestTitle}": ${failureContext.errorMessage || 'No error message captured'}`,
            ...additionalFailingTests.map(
              (extra, i) => `${i + 2}. "${extra.testTitle || 'Unknown test'}": ${extra.errorLog || 'No error message captured'}`
            ),
          ].join('\n'),
        }
      : failureContext;

  if (additionalFailingTests && additionalFailingTests.length > 0) {
    console.log(
      `🧩 [Diagnostic] Combining ${additionalFailingTests.length + 1} failing tests' error contexts for "${specPath}" into a single generateSpecFix() prompt.`
    );
  }

  const fixResult = await generateSpecFix(originalSpecCode, promptFailureContext);

  console.log(`\n✅ Fix Generated!`);
  console.log(`📝 Explanation: ${fixResult.explanation}`);
  console.log(`\n--- Code Diff Preview ---`);
  console.log(fixResult.fixedCode);

  const overwriteResult = overwriteSpecInPlace({
    specPath: absoluteSpecPath,
    rawFixedCode: fixResult.fixedCode,
  });

  if (!overwriteResult.written) {
    console.error(`❌ Error: ${overwriteResult.reason}`);
    return null;
  }

  console.log(`\n🎉 Successfully patched: ${specPath}`);

  // Prefer the test title actually extracted from the trace's own metadata
  // (matches the exact `TestCase.title` format cloudReporter.ts sends via
  // `/api/v1/telemetry`); fall back to the spec's basename only when the
  // trace didn't carry a title (e.g. an unexpected/older trace layout), so
  // the webhook payload's `testName` is never left empty.
  const resolvedTestName = primaryTestTitle;

  const healedFix: HealedFixEntry = {
    specPath,
    explanation: fixResult.explanation,
    errorLog: failureContext.errorMessage,
    fixedCode: overwriteResult.cleanedCode,
    traceZipPath: absoluteTracePath,
    testName: resolvedTestName,
    // Extracted from generateSpecFix()'s FixResult (response.usage.total_tokens
    // in codeFixer.ts) -- carried through so the webhook dispatch below
    // (standalone path) / notifyShorkyCloudBatch (batch path) can report it
    // to shorky-cloud's /api/webhook for the tokensUsedThisMonth budget guard.
    tokensUsed: fixResult.tokensUsed,
  };

  // One additional HealedFixEntry per OTHER failing test that shared this
  // spec file (see `additionalFailingTests`). These reuse the SAME
  // generated fixedCode/explanation (there is only one file, patched once)
  // but carry their own testName/errorLog, so telemetry accurately reports
  // one repair record per originally-failing test rather than collapsing
  // them into a single entry (or dropping them entirely).
  const additionalHealedFixes: HealedFixEntry[] = (additionalFailingTests || []).map((extra) => ({
    specPath,
    explanation: fixResult.explanation,
    errorLog: extra.errorLog,
    fixedCode: overwriteResult.cleanedCode,
    traceZipPath: extra.traceZipPath || absoluteTracePath,
    testName: extra.testTitle || path.basename(specPath),
    tokensUsed: fixResult.tokensUsed,
  }));

  const allHealedFixes = [healedFix, ...additionalHealedFixes];

  if (batchMode) {
    // Batch report mode: only stage the fix onto the shared consolidated
    // healing branch — and only ONCE per spec file, regardless of how many
    // failing tests it contains, since there is only one file/commit to
    // stage. Individual PR creation and per-spec webhook dispatch are
    // intentionally skipped here — `runReportFix` pushes exactly one
    // consolidated branch/PR and fires exactly one consolidated webhook
    // once every failure in the report has been processed.
    console.log(`🔗 [Diagnostic] "${specPath}" entering the CONSOLIDATED path — staging only (batchMode=true, runId="${effectiveRunId}"). openHealingPullRequest() will NOT be called for this spec.`);
    try {
      stageHealingFix(healedFix);
      console.log(`🌿 Staged fix for ${specPath} on the consolidated healing branch.`);
    } catch (err: any) {
      console.warn(`⚠️ Failed to stage the auto-healing fix for ${specPath}:`, err.message || err);
    }
  } else {
    // [DIAGNOSTIC] This is the INDIVIDUAL PR fallback path — reachable only
    // from the standalone (--trace/--spec) CLI invocation, never from
    // runReportFix()'s batch loop (which always passes batchMode: true).
    // If this ever logs during a batch/report-driven CI run, that is the
    // exact root cause of duplicate individual PRs (#42, #43, ...) and
    // per-spec runIds splitting the Neon run record.
    console.warn(`🚨 [Diagnostic] "${specPath}" is entering the INDIVIDUAL PR fallback path (batchMode=false) with its own runId="${effectiveRunId}". This must never happen during a batch report run.`);
    assertIndividualPrAllowed(specPath, batchMode);
    const prUrl = await openHealingPullRequest(healedFix);
    if (!prUrl) {
      console.warn(
        `⚠️ No pull request was opened for ${specPath}. Ensure GITHUB_TOKEN and GITHUB_REPOSITORY are set, and that the workflow grants "contents: write" and "pull-requests: write" permissions.`
      );
    }

    // Dispatch a per-spec webhook for EVERY originally-failing test in this
    // file (standalone (non-batch) single-fix flow only — batch runs are
    // notified once, in aggregate, from `runReportFix` after the
    // consolidated PR is opened).
    for (const fix of allHealedFixes) {
      await notifyShorkyCloud(
        specPath,
        { fixedCode: overwriteResult.cleanedCode, explanation: fixResult.explanation },
        fix.traceZipPath,
        fix.errorLog,
        effectiveRunId,
        fix.testName,
        fixResult.tokensUsed
      );
    }
    logDashboardCallToAction();
  }

  return allHealedFixes;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/cli/fixTrace.ts')) {
  const args = process.argv.slice(2);
  let tracePath = '';
  let specPath = '';
  let reportPath = '';
  // "Auto-Accept Visual Baselines": --update-baselines, forwarded here by
  // action.yml (from the `update-visual-baselines` input) and by
  // src/cli/index.ts's `shorky run --heal --update-baselines` invocation.
  let updateBaselines = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trace' && args[i + 1]) {
      tracePath = args[i + 1];
      i++;
    } else if (args[i] === '--spec' && args[i + 1]) {
      specPath = args[i + 1];
      i++;
    } else if (args[i] === '--report' && args[i + 1]) {
      reportPath = args[i + 1];
      i++;
    } else if (args[i] === '--update-baselines') {
      updateBaselines = true;
    }
  }

  if (reportPath) {
    runReportFix({ reportPath, updateBaselines }).catch((err) => {
      console.error('❌ Unhandled error in runReportFix:', err);
      process.exit(1);
    });
  } else if (tracePath && specPath) {
    runOfflineFix({ tracePath, specPath, updateBaselines }).catch((err) => {
      console.error('❌ Unhandled error in runOfflineFix:', err);
      process.exit(1);
    });
  } else {
    console.error('❌ Usage: npx tsx src/cli/fixTrace.ts --report <path> OR --trace <path> --spec <path> [--update-baselines]');
    process.exit(1);
  }
}