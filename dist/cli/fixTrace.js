"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runReportFix = runReportFix;
exports.runOfflineFix = runOfflineFix;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const traceParser_1 = require("../engine/traceParser");
const codeFixer_1 = require("../engine/codeFixer");
const shorkyCloud_1 = require("../config/shorkyCloud");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
/**
 * Sends the final repaired code and trace context to shorky-cloud,
 * ensuring it only triggers once per successful offline fix.
 */
async function notifyShorkyCloud(specPath, fixResult, traceZipPath, errorLog) {
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
    };
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
                // retry) in chronological order. Only the *last* entry reflects the
                // final outcome of the test and points at the trace.zip/attachments
                // from the final retry directory — earlier entries refer to stale
                // retry-numbered directories (e.g. "-retry1") that may have already
                // been cleaned up or don't represent the terminal failure state.
                const finalResult = results[results.length - 1];
                if (finalResult.status !== 'failed' && finalResult.status !== 'timedOut') {
                    continue;
                }
                // spec.file may already be relative (as emitted by the Playwright
                // JSON reporter for most configs) or absolute (e.g. when the report
                // is generated from a different working directory). Only apply
                // path.relative() when we actually have an absolute path so we
                // don't mangle an already-correct relative path.
                let relativeSpecPath = '';
                if (spec.file) {
                    relativeSpecPath = path_1.default.isAbsolute(spec.file)
                        ? path_1.default.relative(process.cwd(), spec.file)
                        : spec.file;
                }
                if (relativeSpecPath && !relativeSpecPath.startsWith('tests/') && !relativeSpecPath.startsWith('tests' + path_1.default.sep)) {
                    relativeSpecPath = path_1.default.join('tests', relativeSpecPath);
                }
                const resolvedSpecPath = relativeSpecPath || spec.file || 'unknown-spec';
                // Deduplicate by specPath: keep the first failure recorded for a
                // given spec file so we never re-process (and re-fix) the same file
                // multiple times in a single report.
                if (failuresBySpec.has(resolvedSpecPath)) {
                    continue;
                }
                const traceAttachment = finalResult.attachments?.find((a) => a.name === 'trace');
                const errorLog = finalResult.error?.message || finalResult.errors?.[0]?.message;
                failuresBySpec.set(resolvedSpecPath, {
                    specPath: resolvedSpecPath,
                    traceZipPath: traceAttachment?.path,
                    errorLog,
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
    console.log(`🔍 Resolving failed specs and traces from Playwright JSON report: ${reportPath}...`);
    const report = JSON.parse(fs_1.default.readFileSync(absoluteReportPath, 'utf-8'));
    const failures = collectFailedSpecsFromReport(report);
    if (failures.length === 0) {
        console.log('✅ No failed tests found in report. Nothing to do.');
        return;
    }
    console.log(`🎯 Found ${failures.length} failed test(s) in report.`);
    for (const failure of failures) {
        console.log(`\n🎯 Target Spec: ${failure.specPath}`);
        console.log(`📦 Trace Zip: ${failure.traceZipPath || 'N/A'}`);
        if (failure.errorLog) {
            console.log(`💥 Error: ${failure.errorLog}`);
        }
        // Completely removed duplicate pre-telemetry ping (`dispatchFailureTelemetry`) 
        // to stop the triplet job expansion. Only run the offline fix cycle.
        if (failure.traceZipPath && fs_1.default.existsSync(failure.traceZipPath) && fs_1.default.existsSync(failure.specPath)) {
            try {
                await runOfflineFix({ tracePath: failure.traceZipPath, specPath: failure.specPath });
            }
            catch (err) {
                console.error(`❌ Error running fixTrace for ${failure.specPath}:`, err instanceof Error ? err.message : err);
            }
        }
        else {
            console.warn(`⚠️ Skipping offline fix for ${failure.specPath} — trace.zip or spec file not found on disk.`);
        }
    }
}
async function runOfflineFix({ tracePath, specPath }) {
    const absoluteTracePath = path_1.default.resolve(tracePath);
    const absoluteSpecPath = path_1.default.resolve(specPath);
    if (!fs_1.default.existsSync(absoluteTracePath)) {
        console.error(`❌ Trace file not found: ${absoluteTracePath}`);
        process.exit(1);
    }
    if (!fs_1.default.existsSync(absoluteSpecPath)) {
        console.error(`❌ Spec file not found: ${absoluteSpecPath}`);
        process.exit(1);
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
    console.log(`\n🤖 Sending failure context & ${specPath} to LLM Fixer...`);
    const originalSpecCode = fs_1.default.readFileSync(absoluteSpecPath, 'utf-8');
    const fixResult = await (0, codeFixer_1.generateSpecFix)(originalSpecCode, failureContext);
    console.log(`\n✅ Fix Generated!`);
    console.log(`📝 Explanation: ${fixResult.explanation}`);
    console.log(`\n--- Code Diff Preview ---`);
    console.log(fixResult.fixedCode);
    const cleaned = sanitizeGeneratedCode(fixResult.fixedCode);
    // Guardrail: Prevent wiping out test code with empty or truncated outputs
    if (!cleaned || cleaned.length < 30 || !cleaned.includes('test(')) {
        console.error(`❌ Error: LLM generated invalid or empty spec code for ${specPath}. Aborting file write to protect test file.`);
        return;
    }
    fs_1.default.writeFileSync(absoluteSpecPath, cleaned, 'utf-8');
    console.log(`\n🎉 Successfully patched: ${specPath}`);
    // Single unified webhook dispatch containing the genuine fix payload
    await notifyShorkyCloud(specPath, { fixedCode: cleaned, explanation: fixResult.explanation }, absoluteTracePath, failureContext.errorMessage);
}
function sanitizeGeneratedCode(rawCode) {
    return rawCode
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/i, '')
        .replace(/^\/\/\s*[^\n]*\.spec\.[tj]s\n?/i, '')
        .replace(/\r\n/g, '\n')
        .trim() + '\n';
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
