"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOfflineFix = runOfflineFix;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const traceParser_1 = require("../engine/traceParser");
const codeFixer_1 = require("../engine/codeFixer");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
/**
 * Notifies shorky-cloud that a spec fix has been generated so it can be
 * tracked/surfaced in the dashboard. Failures (e.g. shorky-cloud not
 * running locally) are swallowed and logged as warnings so this never
 * crashes the local CLI workflow.
 */
async function notifyShorkyCloud(specPath, fixResult) {
    const shorkyCloudBaseUrl = process.env.SHORKY_CLOUD_URL || 'http://localhost:3000';
    const webhookUrl = `${shorkyCloudBaseUrl.replace(/\/api\/v1\/telemetry\/?$/, '')}/api/webhook`;
    // Ensure no leading slash before sending to GitHub API
    const sanitizedSpecPath = specPath.replace(/^\/+/, '');
    const payload = {
        repoOwner: process.env.GITHUB_REPO_OWNER || 'whoff77',
        repoName: process.env.GITHUB_REPO_NAME || 'shorky',
        branch: process.env.GITHUB_BRANCH || 'main',
        specPath: sanitizedSpecPath, // e.g. "tests/broken-login.spec.ts"
        fixedCode: fixResult.fixedCode,
        explanation: fixResult.explanation,
    };
    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-shorky-api-key': process.env.SHORKY_CLOUD_API_KEY || '',
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.warn(`⚠️ shorky-cloud webhook responded with status ${res.status}:`, JSON.stringify(errorData));
        }
        else {
            const data = await res.json();
            console.log(`🎉 Pull Request created: ${data.prUrl || 'PR opened successfully'}`);
        }
    }
    catch (err) {
        console.warn(`⚠️ Failed to trigger shorky-cloud webhook:`, err.message || err);
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
    const cleanCode = sanitizeGeneratedCode(fixResult.fixedCode);
    // Write updated spec back to disk
    fs_1.default.writeFileSync(absoluteSpecPath, cleanCode, 'utf-8');
    console.log(`\n🎉 Successfully patched: ${specPath}`);
    // Notify shorky-cloud of the successful fix (non-blocking / best-effort)
    await notifyShorkyCloud(specPath.replace(/^\/+/, ''), {
        fixedCode: cleanCode,
        explanation: fixResult.explanation,
    });
}
function sanitizeGeneratedCode(rawCode) {
    return rawCode
        // 1. Strip markdown fences (```typescript ... ```)
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/i, '')
        // 2. Strip LLM header comments like "// tests/fixed-login.spec.ts" or "// tests/broken-login.spec.ts"
        .replace(/^\/\/\s*[^\n]*\.spec\.[tj]s\n?/i, '')
        // 3. Normalize CRLF to standard LF
        .replace(/\r\n/g, '\n')
        .trim() + '\n';
}
// --- Direct CLI Execution Guard ---
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/cli/fixTrace.ts')) {
    const args = process.argv.slice(2);
    let tracePath = '';
    let specPath = '';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--trace' && args[i + 1]) {
            tracePath = args[i + 1];
            i++;
        }
        else if (args[i] === '--spec' && args[i + 1]) {
            specPath = args[i + 1];
            i++;
        }
    }
    if (!tracePath || !specPath) {
        console.error('❌ Usage: npx tsx src/cli/fixTrace.ts --trace <path> --spec <path>');
        process.exit(1);
    }
    runOfflineFix({ tracePath, specPath }).catch((err) => {
        console.error('❌ Unhandled error in runOfflineFix:', err);
        process.exit(1);
    });
}
