"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyShorkyCloudBatch = notifyShorkyCloudBatch;
exports.updateVisualBaseline = updateVisualBaseline;
exports.collectFailedSpecsFromReport = collectFailedSpecsFromReport;
exports.computeStage1Telemetry = computeStage1Telemetry;
exports.dispatchStage1Telemetry = dispatchStage1Telemetry;
exports.runReportFix = runReportFix;
exports.runOfflineFix = runOfflineFix;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const traceParser_1 = require("../engine/traceParser");
const codeFixer_1 = require("../engine/codeFixer");
const shorkyCloud_1 = require("../config/shorkyCloud");
const preflight_1 = require("./preflight");
const githubPr_1 = require("../utils/githubPr");
const specWriter_1 = require("../utils/specWriter");
const gitContext_1 = require("../utils/gitContext");
const executionId_1 = require("../utils/executionId");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
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
function assertIndividualPrAllowed(specPath, batchMode) {
    if (batchMode) {
        throw new Error(`Invariant violation: attempted to call openHealingPullRequest() for "${specPath}" while batchMode=true. Individual PR creation is strictly forbidden during batch report runs — only the single consolidated pull request (via pushConsolidatedHealingBranch) may be created.`);
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
async function notifyShorkyCloud(specPath, fixResult, traceZipPath, errorLog, runId, testName, tokensUsed) {
    const [repoOwner, repoName] = (0, gitContext_1.resolveRepositoryName)().split('/');
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
    const webhookUrl = (0, shorkyCloud_1.getShorkyCloudWebhookUrl)();
    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-shorky-api-key': (0, shorkyCloud_1.getShorkyCloudApiKey)(),
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.warn(`⚠️ shorky-cloud webhook responded with status ${res.status}:`, JSON.stringify(errorData));
        }
        else {
            const data = await res.json();
            console.log(`🎉 Webhook dispatched successfully: ${data.prUrl || data.message || 'OK'}`);
        }
    }
    catch (err) {
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
async function notifyShorkyCloudBatch(fixes, runId) {
    const notifiable = fixes.filter((fix) => !fix.isVisualRegression && !!fix.fixedCode && !!fix.specPath);
    // [DIAGNOSTIC] Print the aggregated batch structure right before any
    // network calls are made — this is the single choke point every batch
    // notification passes through, so if Neon ever shows split run IDs again,
    // this log immediately reveals whether the bug is upstream (multiple
    // distinct runIds reaching this function) or downstream (this function
    // failing to propagate the shared runId into individual dispatches).
    console.log(`📋 [Diagnostic] notifyShorkyCloudBatch: dispatching ${notifiable.length}/${fixes.length} fix(es) under shared runId="${runId}":`, JSON.stringify(notifiable.map((fix) => ({ specPath: fix.specPath, testName: fix.testName, hasFixedCode: !!fix.fixedCode, isVisualRegression: !!fix.isVisualRegression })), null, 2));
    // [DIAGNOSTIC] Explicitly call out any fix entries EXCLUDED from
    // `notifiable`, and why, so a future "N/(N+1) fix(es)" log line is never
    // a silent mystery again — every drop is now individually accounted for.
    const skipped = fixes.filter((fix) => !notifiable.includes(fix));
    if (skipped.length > 0) {
        console.log(`📋 [Diagnostic] notifyShorkyCloudBatch: ${skipped.length} fix(es) excluded from this dispatch:`, JSON.stringify(skipped.map((fix) => ({
            specPath: fix.specPath,
            testName: fix.testName,
            reason: fix.isVisualRegression
                ? 'isVisualRegression=true (already represented in the PR body, no webhook needed)'
                : !fix.fixedCode
                    ? 'missing fixedCode'
                    : !fix.specPath
                        ? 'missing specPath'
                        : 'unknown',
        })), null, 2));
    }
    if (notifiable.length === 0) {
        console.log('ℹ️ No code-fix entries with fixedCode to report to shorky-cloud for this batch.');
        return;
    }
    for (const fix of notifiable) {
        console.log(`➡️  [Diagnostic] Notifying shorky-cloud for "${fix.specPath}" using shared batch runId="${runId}" (consolidated path — no per-fix runId is generated here).`);
        await notifyShorkyCloud(fix.specPath, { fixedCode: fix.fixedCode, explanation: fix.explanation }, fix.traceZipPath, fix.errorLog, runId, fix.testName, fix.tokensUsed);
    }
    // Single summary CTA for the whole batch, printed once after every fix in
    // this run has been dispatched (rather than per-fix, which would spam the
    // log with the same line N times for an N-fix batch).
    (0, shorkyCloud_1.logDashboardCallToAction)();
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
function updateVisualBaseline(visualDiff) {
    if (!visualDiff?.expectedPath || !visualDiff?.actualPath) {
        console.warn('⚠️ [Auto-Accept Visual Baselines] Missing expected/actual PNG path(s) — cannot overwrite the baseline. Falling back to manual review.');
        return false;
    }
    if (!fs_1.default.existsSync(visualDiff.actualPath)) {
        console.warn(`⚠️ [Auto-Accept Visual Baselines] Actual screenshot not found on disk: ${visualDiff.actualPath}. Falling back to manual review.`);
        return false;
    }
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(visualDiff.expectedPath), { recursive: true });
        fs_1.default.copyFileSync(visualDiff.actualPath, visualDiff.expectedPath);
        console.log(`🖼️ [Auto-Accept Visual Baselines] Overwrote baseline "${visualDiff.expectedPath}" with the new actual screenshot from this run.`);
        return true;
    }
    catch (err) {
        console.warn(`⚠️ [Auto-Accept Visual Baselines] Failed to overwrite baseline "${visualDiff.expectedPath}":`, err.message || err);
        return false;
    }
}
/**
 * Extracts the expected/actual/diff PNG attachment paths Playwright records
 * for a failed `toHaveScreenshot`/`toMatchSnapshot` assertion. Playwright
 * names these attachments `<snapshotName>-expected.png`,
 * `<snapshotName>-actual.png`, and `<snapshotName>-diff.png` respectively.
 */
function extractVisualDiffArtifacts(attachments) {
    const artifacts = {};
    for (const attachment of attachments || []) {
        if (!attachment.path)
            continue;
        if (/-expected\.png$/i.test(attachment.name)) {
            artifacts.expectedPath = attachment.path;
        }
        else if (/-actual\.png$/i.test(attachment.name)) {
            artifacts.actualPath = attachment.path;
        }
        else if (/-diff\.png$/i.test(attachment.name)) {
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
/**
 * True when `projectName` looks like Playwright's Chromium-based project
 * (e.g. "chromium", "Google Chrome", "Microsoft Edge") — the one browser
 * whose trace.zip is guaranteed to parse cleanly for DOM/selector context
 * (see runOfflineFix()'s trace-parsing path), so it's always preferred as
 * the "primary" browser instance when the SAME test fails across multiple
 * browsers in the matrix.
 */
function isChromiumLikeProject(projectName) {
    if (!projectName)
        return false;
    return /chrom|edge/i.test(projectName);
}
function collectFailedSpecsFromReport(report) {
    // Keyed by a COMPOSITE `${resolvedSpecPath}::${testTitle}` key so that
    // (a) multiple retries of the exact same test never produce duplicate
    // entries, (b) multiple DISTINCT failing tests inside the same spec file
    // (e.g. two failing `test(...)` blocks in dynamic-form-elements.spec.ts)
    // are each preserved as their own entry rather than the second one being
    // silently dropped, AND (c) the SAME test failing across multiple
    // browsers in the matrix (Chrome/firefox/webkit — see
    // playwright.config.ts's `projects`) collapses into a SINGLE entry
    // instead of triggering the LLM fixer 3 separate times for one broken
    // spec. Keying by specPath alone here was the root cause of failing
    // tests going missing from both the healing pass and the telemetry
    // payload whenever a single file had more than one failure.
    const failuresBySpec = new Map();
    // Tracks which browser project "won" the dedupeKey slot currently held in
    // `failuresBySpec`, so a later-seen Chromium-based attempt can still
    // DISPLACE an earlier-seen non-Chromium one (webkit/firefox) — Chromium's
    // trace.zip is the one guaranteed to parse cleanly, so it's always
    // preferred as the primary instance regardless of iteration order.
    const winningProjectByKey = new Map();
    function walk(suite) {
        for (const spec of suite.specs || []) {
            for (const test of spec.tests || []) {
                const results = test.results || [];
                if (results.length === 0)
                    continue;
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
                let traceAttachment;
                for (let i = results.length - 1; i >= 0; i--) {
                    traceAttachment = results[i].attachments?.find((a) => a.name === 'trace' && !!a.path);
                    if (traceAttachment)
                        break;
                }
                // Map the raw report entry back to the exact original source test
                // file path on disk (see resolveSpecSourcePath in traceParser.ts),
                // so the in-place healing overwrite always targets the same file
                // Playwright actually ran and failed.
                const resolvedSpecPath = (0, traceParser_1.resolveSpecSourcePath)(spec.file) || spec.file || 'unknown-spec';
                const testTitle = spec.title || undefined;
                // Deduplicate by a COMPOSITE `specPath::testTitle` key: keep the
                // first failure recorded for a given (file, test) pair so retries of
                // the exact same test never produce duplicate entries, while still
                // preserving every DISTINCT failing test within the same spec file.
                // When the SAME (file, test) pair shows up again under a DIFFERENT
                // browser project (the multi-browser matrix), only let a
                // Chromium-based attempt DISPLACE a non-Chromium one already
                // recorded — its trace.zip is guaranteed to parse, so the LLM fixer
                // is invoked exactly once per broken spec using the most reliable
                // trace available, never once per browser.
                const dedupeKey = `${resolvedSpecPath}::${testTitle || ''}`;
                const alreadyRecorded = failuresBySpec.has(dedupeKey);
                if (alreadyRecorded) {
                    const isThisAttemptChromium = isChromiumLikeProject(test.projectName);
                    const winningProjectWasChromium = isChromiumLikeProject(winningProjectByKey.get(dedupeKey));
                    if (winningProjectWasChromium || !isThisAttemptChromium) {
                        continue;
                    }
                    // Fall through: a Chromium-based attempt displaces the
                    // previously-recorded non-Chromium one below.
                }
                const errorLog = finalResult.error?.message || finalResult.errors?.[0]?.message;
                // Detect visual regression (screenshot/pixel-diff) failures so they
                // can be routed into "Visual Diff Handoff" mode instead of the
                // normal LLM code-repair flow — adjusting selectors/actions can
                // never fix a genuine pixel discrepancy.
                const isVisual = (0, traceParser_1.isVisualRegressionFailure)(errorLog);
                let visualDiff;
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
                winningProjectByKey.set(dedupeKey, test.projectName);
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
 * Recursively walks every spec/test in a parsed Playwright JSON report
 * (not just the failures `collectFailedSpecsFromReport()` extracts) and
 * resolves each LOGICAL test's final passed/failed outcome and error
 * message — mirroring `cloudReporter.ts`'s retry-safe,
 * multi-browser-matrix-safe accumulation logic, but sourced from the
 * static `report.json` file instead of live `TestCase`/`TestResult`
 * objects (since this function runs as a separate CLI process, after the
 * Playwright run that produced the report has already exited).
 *
 * Deduplicates by a composite `${file}::${title}` key exactly like
 * `collectFailedSpecsFromReport()`'s `dedupeKey`, so a test that ran across
 * multiple browser projects (see playwright.config.ts's `projects`)
 * contributes exactly ONE entry to `tests[]` — failed if ANY browser
 * ultimately failed it, passed otherwise. Playwright's own `ReportTest`
 * `status` field already reflects the retry-resolved final verdict for
 * each (spec, browser) pair (mirroring `TestCase.outcome()`), so no
 * additional retry-attempt inspection is needed here.
 */
function computeStage1Telemetry(report) {
    const testsByKey = new Map();
    function resolveStatus(test) {
        return test.status === 'unexpected' ? 'failed' : 'passed';
    }
    function resolveErrorMessage(test) {
        const results = test.results || [];
        const finalResult = results[results.length - 1];
        return finalResult?.error?.message || finalResult?.errors?.[0]?.message;
    }
    function buildTraceLogs(message) {
        return message
            ? [
                {
                    step: 1,
                    action: 'test_execution',
                    status: 'failed',
                    timestamp: new Date().toISOString(),
                    message,
                },
            ]
            : [];
    }
    function walk(suite) {
        for (const spec of suite.specs || []) {
            for (const test of spec.tests || []) {
                const resolvedSpecPath = (0, traceParser_1.resolveSpecSourcePath)(spec.file) || spec.file || 'unknown-spec';
                const testTitle = spec.title || 'unknown-test';
                const key = `${resolvedSpecPath}::${testTitle}`;
                const status = resolveStatus(test);
                const errorMessage = status === 'failed' ? resolveErrorMessage(test) : undefined;
                const existing = testsByKey.get(key);
                if (!existing) {
                    testsByKey.set(key, {
                        testName: testTitle,
                        status,
                        traceLogs: buildTraceLogs(errorMessage),
                        selfHealingCount: 0,
                        tokensUsed: 0,
                    });
                    continue;
                }
                // A DIFFERENT browser project running the same logical test: if
                // THIS browser failed, the merged entry must be reported failed
                // even if an earlier browser in iteration order passed — a passing
                // Chrome run must never mask a genuine Firefox/WebKit failure.
                if (status === 'failed' && existing.status !== 'failed') {
                    existing.status = 'failed';
                    existing.traceLogs = buildTraceLogs(errorMessage);
                }
            }
        }
        for (const child of suite.suites || []) {
            walk(child);
        }
    }
    for (const suite of report.suites || []) {
        walk(suite);
    }
    const tests = Array.from(testsByKey.values());
    const passedCount = tests.filter((t) => t.status === 'passed').length;
    const failedCount = tests.filter((t) => t.status === 'failed').length;
    const durationMs = Math.round(report.stats?.duration ?? 0);
    return { passedCount, failedCount, durationMs, tests };
}
/**
 * POSTs Stage 1 run-level telemetry to shorky-cloud's `/api/v1/telemetry`
 * directly from the GitHub Action process — see the comment block above
 * `Stage1TestEntry` for why this is necessary (consumers never load
 * `cloudReporter.ts`). Reuses the EXACT `preflight` result already
 * resolved once at the top of `runReportFix()` rather than issuing a
 * second `/api/v1/governance/preflight` round-trip, and gates the POST the
 * same way `cloudReporter.ts`'s `onEnd()` does: skipped entirely when
 * cloud reporting isn't configured, or when the governance check has
 * explicitly signaled `acceptsTelemetry: false` (a free-tier project over
 * its cloud storage quota).
 */
async function dispatchStage1Telemetry(report, suiteRunId, preflight) {
    if (!(0, shorkyCloud_1.isShorkyCloudEnabled)()) {
        console.log('ℹ️ [Shorky Cloud] Telemetry transmission skipped (SHORKY_CLOUD_API_KEY not configured).');
        return;
    }
    if (preflight.acceptsTelemetry === false) {
        console.log(`ℹ️ [Shorky Cloud] Skipping telemetry transmission: ${preflight.message || 'free tier cloud storage quota reached.'}`);
        return;
    }
    const cloudUrl = (0, shorkyCloud_1.getShorkyCloudTelemetryUrl)();
    try {
        console.log(`📤 [Shorky Cloud] Transmitting run artifacts...`);
        const { passedCount, failedCount, durationMs, tests } = computeStage1Telemetry(report);
        const [repoOwner, repoName] = (0, gitContext_1.resolveRepositoryName)().split('/');
        const telemetryPayload = {
            projectName: process.env.SHORKY_PROJECT_NAME || 'shorky',
            repoOwner,
            repoName,
            runId: suiteRunId,
            status: failedCount > 0 ? 'failed' : 'passed',
            passedCount,
            failedCount,
            durationMs,
            tokensUsed: 0,
            tests,
        };
        const response = await fetch(cloudUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-shorky-api-key': (0, shorkyCloud_1.getShorkyCloudApiKey)(),
            },
            body: JSON.stringify(telemetryPayload),
            // Short timeout so an offline/unreachable cloud endpoint never stalls
            // the CI job this runs inside.
            signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('⚠️ [Shorky Cloud] Backend responded with status:', response.status, JSON.stringify(errorData, null, 2));
        }
        else {
            console.log('✅ [Shorky Cloud] Telemetry successfully transmitted.');
            (0, shorkyCloud_1.logDashboardCallToAction)();
        }
    }
    catch (error) {
        // Gracefully log offline status without throwing an unhandled stack
        // trace — a failed Stage 1 dispatch must never abort the healing run.
        if (error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TimeoutError') {
            console.warn('ℹ️ [Shorky Cloud] Cloud server unavailable. Continuing offline execution.');
        }
        else {
            console.warn('⚠️ [Shorky Cloud] Telemetry warning:', error?.message || error);
        }
    }
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
function resolveSuiteRunId(reportPath) {
    // Delegates to the shared getExecutionId() util (see executionId.ts) so
    // this CLI process and the separate Playwright reporter process
    // (cloudReporter.ts) always resolve to the SAME identifier —
    // prioritizing GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT (numeric, automatically
    // shared by GitHub Actions across every step), then SHORKY_RUN_ID, then
    // the `.shorky-run-id` deterministic file handoff located next to the
    // report file (matching where global-setup.ts/cloudReporter.ts write it).
    return (0, executionId_1.getExecutionId)(path_1.default.dirname(path_1.default.resolve(reportPath)));
}
async function runReportFix({ reportPath, updateBaselines = false }) {
    // Pre-flight budget guard: abort BEFORE any LLM repair loop starts if the
    // org's subscription is inactive (402) or its monthly token budget is
    // exhausted (429). This gates the entire batch report run, since every
    // failure in the report would otherwise trigger its own billable
    // generateSpecFix() call. Fails the CI job normally (non-zero exit) with
    // the reason logged, rather than proceeding into the LLM loop.
    const preflight = await (0, preflight_1.runPreflightCheck)();
    if (!preflight.ok) {
        console.error(`🛑 [Shorky] Aborting self-healing run: ${preflight.message}`);
        process.exit(1);
    }
    const absoluteReportPath = path_1.default.resolve(reportPath);
    if (!fs_1.default.existsSync(absoluteReportPath)) {
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
    const report = JSON.parse(fs_1.default.readFileSync(absoluteReportPath, 'utf-8'));
    // Stage 1 telemetry — dispatched here (rather than relying on
    // cloudReporter.ts, which consumer repos never load — see the comment
    // block above Stage1TestEntry) immediately after the report is parsed,
    // reusing the preflight check already performed above, and BEFORE the
    // LLM repair loop below ever starts.
    await dispatchStage1Telemetry(report, suiteRunId, preflight);
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
    const failuresBySpecPath = new Map();
    for (const failure of failures) {
        const group = failuresBySpecPath.get(failure.specPath);
        if (group) {
            group.push(failure);
        }
        else {
            failuresBySpecPath.set(failure.specPath, [failure]);
        }
    }
    console.log(`🗂️ [Diagnostic] Grouped ${failures.length} failing test(s) into ${failuresBySpecPath.size} spec file(s) to repair: ` +
        JSON.stringify(Array.from(failuresBySpecPath.entries()).map(([specPath, group]) => ({
            specPath,
            testCount: group.length,
            testTitles: group.map((f) => f.testTitle || '(untitled)'),
        }))));
    // Every fix generated during this run is staged (committed) onto the
    // same shared healing branch (batchMode: true below) rather than each
    // opening its own branch/PR. Once all failures have been processed, a
    // single consolidated pull request is pushed containing every fix.
    const healedFixes = [];
    const specGroups = Array.from(failuresBySpecPath.entries());
    for (const [groupIndex, [groupSpecPath, group]] of specGroups.entries()) {
        console.log(`\n🔗 [Diagnostic] Spec group ${groupIndex + 1}/${specGroups.length} ("${groupSpecPath}", ${group.length} failing test(s)) entering the CONSOLIDATED batch path — batchMode=true, runId="${suiteRunId}" (no individual PR or unique runId will be generated for this spec).`);
        // Visual regressions are never LLM-repaired, so each one in this group
        // is handled independently and produces its own HealedFixEntry
        // immediately, regardless of how many other (code-fixable) failures
        // share the same spec file.
        const visualFailures = group.filter((f) => f.isVisualRegression);
        const codeFailures = group.filter((f) => !f.isVisualRegression);
        for (const failure of visualFailures) {
            console.log(`🖼️ Detected a visual regression failure for ${failure.specPath} ("${failure.testTitle || 'unknown test'}").`);
            if (failure.visualDiff?.expectedPath)
                console.log(`   - Expected: ${failure.visualDiff.expectedPath}`);
            if (failure.visualDiff?.actualPath)
                console.log(`   - Actual:   ${failure.visualDiff.actualPath}`);
            if (failure.visualDiff?.diffPath)
                console.log(`   - Diff:     ${failure.visualDiff.diffPath}`);
            // "Auto-Accept Visual Baselines": opted-in via --update-baselines /
            // update-visual-baselines. Bypasses LLM code repair either way (a
            // genuine pixel discrepancy can never be fixed by adjusting
            // selectors/actions) — the only difference is whether the new
            // screenshot is automatically accepted as the baseline or left for a
            // human to review.
            const baselineUpdated = updateBaselines && updateVisualBaseline(failure.visualDiff);
            const visualHandoffFix = {
                specPath: failure.specPath,
                explanation: baselineUpdated
                    ? 'Visual regression detected — the new screenshot was automatically accepted as the updated baseline (--update-baselines / update-visual-baselines enabled).'
                    : 'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
                errorLog: failure.errorLog,
                isVisualRegression: true,
                baselineUpdated,
                visualDiff: failure.visualDiff,
                testName: failure.testTitle || path_1.default.basename(failure.specPath),
            };
            if (!baselineUpdated) {
                console.log(`🖼️ Bypassing LLM code repair (Visual Diff Handoff) for "${failure.specPath}".`);
            }
            try {
                (0, githubPr_1.stageHealingFix)(visualHandoffFix);
                console.log(baselineUpdated
                    ? `🌿 [Diagnostic] Staged auto-updated visual baseline for "${failure.specPath}" onto the shared consolidated healing branch (no PR opened yet).`
                    : `🌿 [Diagnostic] Staged visual diff handoff entry for "${failure.specPath}" onto the shared consolidated healing branch (no PR opened yet).`);
            }
            catch (err) {
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
        const primaryFailure = codeFailures.find((f) => f.traceZipPath && fs_1.default.existsSync(path_1.default.resolve(f.traceZipPath)));
        console.log(`\n🎯 Target Spec: ${groupSpecPath} (${codeFailures.length} failing test(s) in this file)`);
        for (const f of codeFailures) {
            console.log(`💥 [${f.testTitle || 'unknown test'}] ${f.errorLog || 'No error message captured'}`);
        }
        if (!primaryFailure) {
            console.warn(`⚠️ Skipping offline fix for ${groupSpecPath} — none of its ${codeFailures.length} failing test(s) have a usable trace.zip on disk. [Diagnostic] No individual fallback path is taken here; this spec is simply omitted from the batch.`);
            continue;
        }
        const resolvedTraceZipPath = path_1.default.resolve(primaryFailure.traceZipPath);
        const resolvedSpecFsPath = path_1.default.resolve(groupSpecPath);
        if (fs_1.default.existsSync(resolvedSpecFsPath)) {
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
            }
            catch (err) {
                console.error(`❌ Error running fixTrace for ${groupSpecPath}:`, err instanceof Error ? err.message : err);
            }
        }
        else {
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
    console.log(`📦 [Diagnostic] Aggregated batch payload (${healedFixes.length} fix(es), suiteRunId="${suiteRunId}") about to be sent as ONE consolidated branch push / GitHub API PR call:`, JSON.stringify(healedFixes.map((fix) => ({ specPath: fix.specPath, testName: fix.testName, isVisualRegression: !!fix.isVisualRegression, hasFixedCode: !!fix.fixedCode })), null, 2));
    console.log(`\n📦 Pushing consolidated healing branch with ${healedFixes.length} fix(es)...`);
    const prUrl = await (0, githubPr_1.pushConsolidatedHealingBranch)(healedFixes);
    if (!prUrl) {
        console.warn(`⚠️ No pull request was opened for ${healedFixes.length} healed spec(s). Ensure GITHUB_TOKEN and GITHUB_REPOSITORY are set, and that the workflow grants "contents: write" and "pull-requests: write" permissions.`);
    }
    else {
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
async function runOfflineFix({ tracePath, specPath, batchMode = false, runId, skipPreflightCheck = false, additionalFailingTests, updateBaselines = false, }) {
    // Pre-flight budget guard: only run here for the standalone (non-batch)
    // --trace/--spec invocation. Batch runs (runReportFix) already perform
    // this check exactly once before the loop that calls runOfflineFix() for
    // each failure — re-checking per-spec here would be redundant network
    // calls and could abort mid-batch after some fixes already succeeded.
    if (!batchMode && !skipPreflightCheck) {
        const preflight = await (0, preflight_1.runPreflightCheck)();
        if (!preflight.ok) {
            console.error(`🛑 [Shorky] Aborting self-healing run: ${preflight.message}`);
            process.exit(1);
        }
    }
    const absoluteTracePath = path_1.default.resolve(tracePath);
    const absoluteSpecPath = path_1.default.resolve(specPath);
    // Hard invariant: in batch mode, the caller (runReportFix) MUST supply the
    // shared suiteRunId explicitly. Silently falling through to a fresh
    // randomUUID() here — even just once — would mint a unique run ID for
    // this single fix, which is the exact root cause of split Neon run
    // records across a single batch report run. Fail loudly instead of
    // silently generating a divergent runId.
    if (batchMode && !runId) {
        throw new Error(`runOfflineFix() invariant violation: batchMode=true but no runId was supplied for "${specPath}". Every fix processed during a batch run must reuse the caller's shared suiteRunId — refusing to fall back to a freshly generated UUID.`);
    }
    // Standalone (non-batch) invocation with no explicit runId supplied:
    // resolve the shared execution ID the SAME way cloudReporter.ts does
    // (GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT, then SHORKY_RUN_ID, then the
    // `.shorky-run-id` file handoff, only falling back to a freshly minted
    // UUID as a last resort) — rather than unconditionally minting a new
    // UUID here, which is what previously caused this CLI process and the
    // Playwright reporter process to disagree on the run identifier.
    const effectiveRunId = runId || (0, executionId_1.getExecutionId)();
    // [DIAGNOSTIC] Print the evaluated batchMode flag and the runId this
    // invocation will actually use. When called from runReportFix(), batchMode
    // must always be `true` and `runId` must always equal the caller's
    // suiteRunId — if effectiveRunId ever differs from a passed-in `runId`,
    // that means `runId` was falsy and a brand-new UUID was minted here,
    // which is exactly the root cause of split Neon run IDs.
    console.log(`🧪 [Diagnostic] runOfflineFix("${specPath}") — batchMode=${batchMode}, incoming runId=${runId ? `"${runId}"` : 'undefined'}, effectiveRunId="${effectiveRunId}"` +
        (runId && runId !== effectiveRunId ? ' ⚠️ MISMATCH — a new UUID was generated instead of reusing the shared runId!' : ''));
    if (!fs_1.default.existsSync(absoluteTracePath)) {
        console.error(`❌ Trace file not found: ${absoluteTracePath}`);
        if (!batchMode)
            process.exit(1);
        return null;
    }
    if (!fs_1.default.existsSync(absoluteSpecPath)) {
        console.error(`❌ Spec file not found: ${absoluteSpecPath}`);
        if (!batchMode)
            process.exit(1);
        return null;
    }
    console.log(`🔍 Unpacking and analyzing trace: ${tracePath}...`);
    const failureContext = await (0, traceParser_1.parsePlaywrightTrace)(absoluteTracePath);
    if (!failureContext.failedSelector && !failureContext.errorMessage) {
        console.warn('⚠️ No explicit failure event found in the trace.');
    }
    else {
        console.log(`💡 Detected Failure:`);
        console.log(`   - Action: ${failureContext.actionMethod}`);
        console.log(`   - Selector: ${failureContext.failedSelector}`);
        console.log(`   - Error: ${failureContext.errorMessage}`);
    }
    if ((0, traceParser_1.isVisualRegressionFailure)(failureContext.errorMessage)) {
        console.log(`🖼️ Detected a visual regression failure for ${specPath}. Bypassing LLM code repair (Visual Diff Handoff).`);
        if (updateBaselines) {
            console.warn(`⚠️ [Auto-Accept Visual Baselines] --update-baselines has no effect on the standalone (--trace/--spec) flow for "${specPath}" — the raw trace.zip doesn't carry the expected/actual PNG attachment paths needed to locate the baseline. Use the --report / runReportFix batch flow instead. Falling back to manual review.`);
        }
        const visualHandoffFix = {
            specPath,
            explanation: 'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
            errorLog: failureContext.errorMessage,
            isVisualRegression: true,
            testName: failureContext.testTitle || path_1.default.basename(specPath),
        };
        if (batchMode) {
            console.log(`🔗 [Diagnostic] "${specPath}" (visual regression) entering the CONSOLIDATED path — staging only, no individual PR.`);
            try {
                (0, githubPr_1.stageHealingFix)(visualHandoffFix);
            }
            catch (err) {
                console.warn(`⚠️ Failed to stage the visual diff handoff entry for ${specPath}:`, err.message || err);
            }
        }
        else {
            // [DIAGNOSTIC] This is the INDIVIDUAL PR fallback path. It must only
            // ever be reached for the standalone (--trace/--spec) CLI flow, never
            // from a batch runReportFix() run — that's what causes the "split
            // run IDs" / duplicate individual PR bug (e.g. PR #42, #43) when it
            // fires per spec during batch processing.
            console.warn(`🚨 [Diagnostic] "${specPath}" (visual regression) is entering the INDIVIDUAL PR fallback path (batchMode=false). This must never happen during a batch report run.`);
            assertIndividualPrAllowed(specPath, batchMode);
            const prUrl = await (0, githubPr_1.openHealingPullRequest)(visualHandoffFix);
            if (!prUrl) {
                console.warn(`⚠️ No pull request was opened for the visual regression review entry for ${specPath}.`);
            }
        }
        return [visualHandoffFix];
    }
    console.log(`\n🤖 Sending failure context & ${specPath} to LLM Fixer...`);
    const originalSpecCode = fs_1.default.readFileSync(absoluteSpecPath, 'utf-8');
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
    const primaryTestTitle = failureContext.testTitle || path_1.default.basename(specPath);
    const promptFailureContext = additionalFailingTests && additionalFailingTests.length > 0
        ? {
            ...failureContext,
            errorMessage: [
                `This spec file has ${additionalFailingTests.length + 1} FAILING TESTS that must ALL be fixed by this single repair:`,
                `1. "${primaryTestTitle}": ${failureContext.errorMessage || 'No error message captured'}`,
                ...additionalFailingTests.map((extra, i) => `${i + 2}. "${extra.testTitle || 'Unknown test'}": ${extra.errorLog || 'No error message captured'}`),
            ].join('\n'),
        }
        : failureContext;
    if (additionalFailingTests && additionalFailingTests.length > 0) {
        console.log(`🧩 [Diagnostic] Combining ${additionalFailingTests.length + 1} failing tests' error contexts for "${specPath}" into a single generateSpecFix() prompt.`);
    }
    const fixResult = await (0, codeFixer_1.generateSpecFix)(originalSpecCode, promptFailureContext);
    console.log(`\n✅ Fix Generated!`);
    console.log(`📝 Explanation: ${fixResult.explanation}`);
    console.log(`\n--- Code Diff Preview ---`);
    console.log(fixResult.fixedCode);
    const overwriteResult = (0, specWriter_1.overwriteSpecInPlace)({
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
    const healedFix = {
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
    const additionalHealedFixes = (additionalFailingTests || []).map((extra) => ({
        specPath,
        explanation: fixResult.explanation,
        errorLog: extra.errorLog,
        fixedCode: overwriteResult.cleanedCode,
        traceZipPath: extra.traceZipPath || absoluteTracePath,
        testName: extra.testTitle || path_1.default.basename(specPath),
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
            (0, githubPr_1.stageHealingFix)(healedFix);
            console.log(`🌿 Staged fix for ${specPath} on the consolidated healing branch.`);
        }
        catch (err) {
            console.warn(`⚠️ Failed to stage the auto-healing fix for ${specPath}:`, err.message || err);
        }
    }
    else {
        // [DIAGNOSTIC] This is the INDIVIDUAL PR fallback path — reachable only
        // from the standalone (--trace/--spec) CLI invocation, never from
        // runReportFix()'s batch loop (which always passes batchMode: true).
        // If this ever logs during a batch/report-driven CI run, that is the
        // exact root cause of duplicate individual PRs (#42, #43, ...) and
        // per-spec runIds splitting the Neon run record.
        console.warn(`🚨 [Diagnostic] "${specPath}" is entering the INDIVIDUAL PR fallback path (batchMode=false) with its own runId="${effectiveRunId}". This must never happen during a batch report run.`);
        assertIndividualPrAllowed(specPath, batchMode);
        const prUrl = await (0, githubPr_1.openHealingPullRequest)(healedFix);
        if (!prUrl) {
            console.warn(`⚠️ No pull request was opened for ${specPath}. Ensure GITHUB_TOKEN and GITHUB_REPOSITORY are set, and that the workflow grants "contents: write" and "pull-requests: write" permissions.`);
        }
        // Dispatch a per-spec webhook for EVERY originally-failing test in this
        // file (standalone (non-batch) single-fix flow only — batch runs are
        // notified once, in aggregate, from `runReportFix` after the
        // consolidated PR is opened).
        for (const fix of allHealedFixes) {
            await notifyShorkyCloud(specPath, { fixedCode: overwriteResult.cleanedCode, explanation: fixResult.explanation }, fix.traceZipPath, fix.errorLog, effectiveRunId, fix.testName, fixResult.tokensUsed);
        }
        (0, shorkyCloud_1.logDashboardCallToAction)();
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
        }
        else if (args[i] === '--spec' && args[i + 1]) {
            specPath = args[i + 1];
            i++;
        }
        else if (args[i] === '--report' && args[i + 1]) {
            reportPath = args[i + 1];
            i++;
        }
        else if (args[i] === '--update-baselines') {
            updateBaselines = true;
        }
    }
    if (reportPath) {
        runReportFix({ reportPath, updateBaselines }).catch((err) => {
            console.error('❌ Unhandled error in runReportFix:', err);
            process.exit(1);
        });
    }
    else if (tracePath && specPath) {
        runOfflineFix({ tracePath, specPath, updateBaselines }).catch((err) => {
            console.error('❌ Unhandled error in runOfflineFix:', err);
            process.exit(1);
        });
    }
    else {
        console.error('❌ Usage: npx tsx src/cli/fixTrace.ts --report <path> OR --trace <path> --spec <path> [--update-baselines]');
        process.exit(1);
    }
}
