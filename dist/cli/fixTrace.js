"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runReportFix = runReportFix;
exports.runOfflineFix = runOfflineFix;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const traceParser_1 = require("../engine/traceParser");
const codeFixer_1 = require("../engine/codeFixer");
const shorkyCloud_1 = require("../config/shorkyCloud");
const githubPr_1 = require("../utils/githubPr");
const generator_1 = require("../agent/generator");
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
async function notifyShorkyCloud(specPath, fixResult, traceZipPath, errorLog, runId) {
    const [repoOwner, repoName] = (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/');
    const sanitizedSpecPath = specPath.replace(/^\/+/, '');
    const payload = {
        repoOwner,
        repoName,
        branch: process.env.GITHUB_REF_NAME || process.env.BRANCH || 'main',
        specPath: sanitizedSpecPath,
        traceZipPath: traceZipPath || null,
        errorLog: errorLog || null,
        fixedCode: fixResult.fixedCode,
        explanation: fixResult.explanation,
        runId: runId || undefined,
    };
    // [DIAGNOSTIC] Print the exact outgoing webhook payload (minus the API
    // key, which is sent as a header, not in the body) right before the
    // request is dispatched. This is the single source of truth for
    // confirming which runId a given spec's telemetry was actually tagged
    // with — critical for tracing down split/duplicate Neon run IDs.
    console.log(`📤 [Diagnostic] shorky-cloud webhook payload for "${sanitizedSpecPath}":`, JSON.stringify(payload, null, 2));
    const webhookUrl = (0, shorkyCloud_1.getShorkyCloudWebhookUrl)(process.env.SHORKY_CLOUD_URL);
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
    console.log(`📋 [Diagnostic] notifyShorkyCloudBatch: dispatching ${notifiable.length}/${fixes.length} fix(es) under shared runId="${runId}":`, JSON.stringify(notifiable.map((fix) => ({ specPath: fix.specPath, hasFixedCode: !!fix.fixedCode, isVisualRegression: !!fix.isVisualRegression })), null, 2));
    if (notifiable.length === 0) {
        console.log('ℹ️ No code-fix entries with fixedCode to report to shorky-cloud for this batch.');
        return;
    }
    for (const fix of notifiable) {
        console.log(`➡️  [Diagnostic] Notifying shorky-cloud for "${fix.specPath}" using shared batch runId="${runId}" (consolidated path — no per-fix runId is generated here).`);
        await notifyShorkyCloud(fix.specPath, { fixedCode: fix.fixedCode, explanation: fix.explanation }, fix.traceZipPath, fix.errorLog, runId);
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
function collectFailedSpecsFromReport(report) {
    // Keyed by resolved specPath so that (a) multiple retries of the same test
    // never produce duplicate entries, and (b) multiple failing tests inside
    // the same spec file only trigger a single offline-fix pass for that file.
    const failuresBySpec = new Map();
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
                // Deduplicate by specPath: keep the first failure recorded for a
                // given spec file so we never re-process (and re-fix) the same file
                // multiple times in a single report.
                if (failuresBySpec.has(resolvedSpecPath)) {
                    continue;
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
                failuresBySpec.set(resolvedSpecPath, {
                    specPath: resolvedSpecPath,
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
async function runReportFix({ reportPath }) {
    const absoluteReportPath = path_1.default.resolve(reportPath);
    if (!fs_1.default.existsSync(absoluteReportPath)) {
        console.error(`❌ Report file not found: ${absoluteReportPath}`);
        process.exit(1);
    }
    // Generate a single suite-wide runId to group all healed traces under one run card.
    // Every failure discovered in this report is processed with batchMode: true
    // (see the runOfflineFix() call below) and shares this exact suiteRunId —
    // no per-fix runId is ever minted while inside this function.
    const suiteRunId = (0, crypto_1.randomUUID)();
    console.log(`🔍 Resolving failed specs and traces from Playwright JSON report: ${reportPath} (Run ID: ${suiteRunId})...`);
    // [DIAGNOSTIC] Explicitly print the execution mode and generated run ID at
    // the very start of the batch run, before any spec is touched, so it's
    // trivially clear in the logs which mode this invocation is running in
    // and which single runId every fix in this run should be tagged with.
    console.log(`🧭 [Diagnostic] runReportFix() starting — batchMode=true (enforced) for all specs in this report, suiteRunId="${suiteRunId}".`);
    const report = JSON.parse(fs_1.default.readFileSync(absoluteReportPath, 'utf-8'));
    const failures = collectFailedSpecsFromReport(report);
    if (failures.length === 0) {
        console.log('✅ No failed tests found in report. Nothing to do.');
        return;
    }
    console.log(`🎯 Found ${failures.length} failed test(s) in report.`);
    // Every fix generated during this run is staged (committed) onto the
    // same shared healing branch (batchMode: true below) rather than each
    // opening its own branch/PR. Once all failures have been processed, a
    // single consolidated pull request is pushed containing every fix.
    const healedFixes = [];
    for (const [index, failure] of failures.entries()) {
        console.log(`\n🎯 Target Spec: ${failure.specPath}`);
        console.log(`📦 Trace Zip: ${failure.traceZipPath || 'N/A'}`);
        if (failure.errorLog) {
            console.log(`💥 Error: ${failure.errorLog}`);
        }
        // [DIAGNOSTIC] Announce, per fix, that it is being processed on the
        // consolidated (batch) path with the shared suiteRunId — this makes it
        // trivial to spot in the logs if any given spec were ever (incorrectly)
        // diverted onto an individual/fallback path with its own runId.
        console.log(`🔗 [Diagnostic] Fix ${index + 1}/${failures.length} ("${failure.specPath}") entering the CONSOLIDATED batch path — batchMode=true, runId="${suiteRunId}" (no individual PR or unique runId will be generated for this spec).`);
        if (failure.isVisualRegression) {
            console.log(`🖼️ Detected a visual regression failure for ${failure.specPath}. Bypassing LLM code repair (Visual Diff Handoff).`);
            if (failure.visualDiff?.expectedPath)
                console.log(`   - Expected: ${failure.visualDiff.expectedPath}`);
            if (failure.visualDiff?.actualPath)
                console.log(`   - Actual:   ${failure.visualDiff.actualPath}`);
            if (failure.visualDiff?.diffPath)
                console.log(`   - Diff:     ${failure.visualDiff.diffPath}`);
            const visualHandoffFix = {
                specPath: failure.specPath,
                explanation: 'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
                errorLog: failure.errorLog,
                isVisualRegression: true,
                visualDiff: failure.visualDiff,
            };
            try {
                (0, githubPr_1.stageHealingFix)(visualHandoffFix);
                console.log(`🌿 [Diagnostic] Staged visual diff handoff entry for "${failure.specPath}" onto the shared consolidated healing branch (no PR opened yet).`);
            }
            catch (err) {
                console.warn(`⚠️ Failed to stage the visual diff handoff entry for ${failure.specPath}:`, err.message || err);
            }
            healedFixes.push(visualHandoffFix);
            continue;
        }
        const resolvedTraceZipPath = failure.traceZipPath ? path_1.default.resolve(failure.traceZipPath) : undefined;
        const resolvedSpecFsPath = path_1.default.resolve(failure.specPath);
        if (resolvedTraceZipPath && fs_1.default.existsSync(resolvedTraceZipPath) && fs_1.default.existsSync(resolvedSpecFsPath)) {
            try {
                const healedFix = await runOfflineFix({
                    tracePath: resolvedTraceZipPath,
                    specPath: failure.specPath,
                    batchMode: true,
                    runId: suiteRunId,
                });
                if (healedFix) {
                    healedFixes.push(healedFix);
                    console.log(`✅ [Diagnostic] Fix for "${failure.specPath}" collected into the batch (total staged so far: ${healedFixes.length}). Still no PR/webhook fired — deferred until the batch loop completes.`);
                }
            }
            catch (err) {
                console.error(`❌ Error running fixTrace for ${failure.specPath}:`, err instanceof Error ? err.message : err);
            }
        }
        else {
            const missing = [];
            if (!resolvedTraceZipPath || !fs_1.default.existsSync(resolvedTraceZipPath)) {
                missing.push(`trace.zip (${resolvedTraceZipPath || 'N/A'})`);
            }
            if (!fs_1.default.existsSync(resolvedSpecFsPath)) {
                missing.push(`spec file (${resolvedSpecFsPath})`);
            }
            console.warn(`⚠️ Skipping offline fix for ${failure.specPath} — missing on disk: ${missing.join(', ')}. [Diagnostic] No individual fallback path is taken here; this spec is simply omitted from the batch.`);
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
    console.log(`📦 [Diagnostic] Aggregated batch payload (${healedFixes.length} fix(es), suiteRunId="${suiteRunId}") about to be sent as ONE consolidated branch push / GitHub API PR call:`, JSON.stringify(healedFixes.map((fix) => ({ specPath: fix.specPath, isVisualRegression: !!fix.isVisualRegression, hasFixedCode: !!fix.fixedCode })), null, 2));
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
async function runOfflineFix({ tracePath, specPath, batchMode = false, runId }) {
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
    const effectiveRunId = runId || (0, crypto_1.randomUUID)();
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
        const visualHandoffFix = {
            specPath,
            explanation: 'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
            errorLog: failureContext.errorMessage,
            isVisualRegression: true,
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
        return visualHandoffFix;
    }
    console.log(`\n🤖 Sending failure context & ${specPath} to LLM Fixer...`);
    const originalSpecCode = fs_1.default.readFileSync(absoluteSpecPath, 'utf-8');
    const fixResult = await (0, codeFixer_1.generateSpecFix)(originalSpecCode, failureContext);
    console.log(`\n✅ Fix Generated!`);
    console.log(`📝 Explanation: ${fixResult.explanation}`);
    console.log(`\n--- Code Diff Preview ---`);
    console.log(fixResult.fixedCode);
    const overwriteResult = (0, generator_1.overwriteSpecInPlace)({
        specPath: absoluteSpecPath,
        rawFixedCode: fixResult.fixedCode,
    });
    if (!overwriteResult.written) {
        console.error(`❌ Error: ${overwriteResult.reason}`);
        return null;
    }
    console.log(`\n🎉 Successfully patched: ${specPath}`);
    const healedFix = {
        specPath,
        explanation: fixResult.explanation,
        errorLog: failureContext.errorMessage,
        fixedCode: overwriteResult.cleanedCode,
        traceZipPath: absoluteTracePath,
    };
    if (batchMode) {
        // Batch report mode: only stage the fix onto the shared consolidated
        // healing branch. Individual PR creation and per-spec webhook dispatch
        // are intentionally skipped here — `runReportFix` pushes exactly one
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
        // Dispatch the per-spec webhook only for the standalone (non-batch)
        // single-fix flow. Batch runs are notified once, in aggregate, from
        // `runReportFix` after the consolidated PR is opened.
        await notifyShorkyCloud(specPath, { fixedCode: overwriteResult.cleanedCode, explanation: fixResult.explanation }, absoluteTracePath, failureContext.errorMessage, effectiveRunId);
    }
    return healedFix;
}
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/cli/fixTrace.ts')) {
    const args = process.argv.slice(2);
    let tracePath = '';
    let specPath = '';
    let reportPath = '';
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
    }
    if (reportPath) {
        runReportFix({ reportPath }).catch((err) => {
            console.error('❌ Unhandled error in runReportFix:', err);
            process.exit(1);
        });
    }
    else if (tracePath && specPath) {
        runOfflineFix({ tracePath, specPath }).catch((err) => {
            console.error('❌ Unhandled error in runOfflineFix:', err);
            process.exit(1);
        });
    }
    else {
        console.error('❌ Usage: npx tsx src/cli/fixTrace.ts --report <path> OR --trace <path> --spec <path>');
        process.exit(1);
    }
}
