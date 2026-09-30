#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const traceParser_1 = require("../engine/traceParser");
const fixTrace_1 = require("./fixTrace");
const preflight_1 = require("./preflight");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const program = new commander_1.Command();
program
    .name('shorky')
    .description('🤖 Shorky - Autonomous AI-powered Playwright testing framework CLI')
    .version('1.0.0');
/**
 * Prints a styled banner summarizing the active run configuration.
 *
 * Also runs a lightweight governance pre-check (`runPreflightCheck()`)
 * purely to surface a free-tier cloud telemetry storage-quota warning
 * (e.g. "⚠️ 8,200/10,000 free telemetry events used") up front, before
 * Playwright even starts — independent of `--heal`/pass-fail outcome,
 * since telemetry (`cloudReporter.ts`) is sent for every run regardless of
 * whether self-healing triggers. This is purely informational: it never
 * blocks the run (the actual `allowExecution` budget-guard enforcement
 * still only happens in `handleHealOnFailure()`, right before an LLM call
 * would be made).
 */
async function printBanner(options) {
    const heal = options.heal ? 'ON' : 'OFF';
    const vision = options.vision ? 'ON' : 'OFF';
    const headed = options.headed ? 'ON' : 'OFF';
    const generateOnly = options.generateOnly ? 'ON' : 'OFF';
    const updateBaselines = options.updateBaselines ? 'ON' : 'OFF';
    const projectLabel = options.project ?? 'all projects (playwright.config.ts matrix)';
    const banner = `
 ____  _                 _
/ ___|| |__   ___  _ __ | | ___   _
\\___ \\| '_ \\ / _ \\| '__|| |/ / | | |
 ___) | | | | (_) | |   |   <| |_| |
|____/|_| |_|\\___/|_|   |_|\\_\\\\__, |
                               |___/
`;
    console.log(banner);
    console.log(`🤖 [Shorky] Launching test run -> [${projectLabel}] ` +
        `[Self-Healing: ${heal}] [Vision: ${vision}] [Headed: ${headed}] [Generate-Only: ${generateOnly}] [Auto-Accept Visual Baselines: ${updateBaselines}]`);
    const preflight = await (0, preflight_1.runPreflightCheck)();
    const storageBanner = (0, preflight_1.formatStorageBanner)(preflight.storage);
    if (storageBanner) {
        console.log(storageBanner);
    }
    console.log('———————————————————————————————————————————————————————————\n');
}
/**
 * Locates the most recently created trace.zip under test-results/, resolves
 * its associated failing spec file, and runs the offline self-healing fixer
 * against it. Used as a fallback when Playwright exits non-zero and
 * `--heal` is enabled.
 *
 * Before any LLM repair loop is started, this function (not
 * `runOfflineFix()`, which is called with `skipPreflightCheck: true` since
 * the check already happened here) performs a pre-flight governance check
 * against shorky-cloud's always-200 `/api/v1/governance/preflight`
 * endpoint (see `src/cli/preflight.ts`). If the response body's
 * `allowExecution` is `false` (a Pro-tier project that has exhausted its
 * monthly token budget), the fixer aborts immediately with a logged error
 * and a non-zero exit code — no OpenAI call is ever made, and the CI job
 * fails normally. The same check's `storage` figures (if present) are also
 * re-logged here as a fresh confirmation of free-tier telemetry quota
 * usage, in case it changed since `printBanner()`'s earlier check.
 */
async function handleHealOnFailure(options = {}) {
    console.log('\n🩹 [Shorky] --heal enabled. Attempting automatic self-healing fix...');
    const tracePath = (0, traceParser_1.findLatestTraceZip)();
    if (!tracePath) {
        console.warn('⚠️ [Shorky] No trace.zip found under test-results/. Skipping self-healing.');
        return;
    }
    const specPath = (0, traceParser_1.extractSpecPathFromTrace)(tracePath);
    if (!specPath) {
        console.warn(`⚠️ [Shorky] Could not resolve failing spec path for trace: ${tracePath}. Skipping self-healing.`);
        return;
    }
    console.log(`🔎 [Shorky] Found trace: ${tracePath}`);
    console.log(`🔎 [Shorky] Resolved failing spec: ${specPath}`);
    // Pre-flight governance guard: run this BEFORE the LLM repair loop
    // starts. If `allowExecution` is false (Pro-tier monthly token budget
    // exceeded), abort the self-healing attempt immediately, log the
    // reason, and fail the CI job normally (non-zero exit) rather than
    // proceeding into an LLM call.
    const preflight = await (0, preflight_1.runPreflightCheck)();
    const storageBanner = (0, preflight_1.formatStorageBanner)(preflight.storage);
    if (storageBanner) {
        console.log(storageBanner);
    }
    if (!preflight.ok) {
        console.error(`🛑 [Shorky] Aborting self-healing run: ${preflight.message}`);
        process.exit(1);
    }
    try {
        await (0, fixTrace_1.runOfflineFix)({ tracePath, specPath, skipPreflightCheck: true, updateBaselines: options.updateBaselines });
    }
    catch (error) {
        console.error('❌ [Shorky] Self-healing attempt failed:', error instanceof Error ? error.message : error);
    }
}
program
    .command('run')
    .description('Run Shorky/Playwright tests with AI-powered self-healing and vision capabilities')
    .argument('[test-pattern]', 'Optional Playwright test file/pattern filter')
    .option('--project <name>', 'Browser project name to execute against (defaults to running the full ' +
    'playwright.config.ts projects matrix — Google Chrome, firefox, webkit)')
    .option('--heal', 'Enable automatic multi-tier selector self-healing', false)
    .option('--vision', 'Enable AI vision-based DOM evaluation and audit checks', false)
    .option('--generate-only', 'Generate standard Playwright specs without persisting cloud telemetry', false)
    .option('--headed', 'Run browser instances in headed mode for visual debugging', false)
    .option('--update-baselines', '"Auto-Accept Visual Baselines": when a visual regression is detected during --heal, automatically ' +
    'overwrite the local baseline PNG with the newly captured actual screenshot and stage it in the ' +
    'auto-heal PR instead of only flagging it for manual review', false)
    .action(async (testPattern, options) => {
    // Map CLI flags -> Shorky runtime environment/config
    process.env.SHORKY_HEAL = options.heal ? 'true' : 'false';
    process.env.SHORKY_VISION = options.vision ? 'true' : 'false';
    process.env.SHORKY_GENERATE_ONLY = options.generateOnly ? 'true' : 'false';
    if (options.project) {
        process.env.SHORKY_PROJECT_NAME = options.project;
    }
    await printBanner(options);
    const args = ['playwright', 'test'];
    if (testPattern) {
        args.push(testPattern);
    }
    // No --project flag by default: delegate to playwright.config.ts's
    // projects array, which runs the full Chromium/firefox/webkit matrix.
    // Pass --project explicitly only when the caller opts into a single
    // browser (e.g. local hardware constraints preventing firefox/webkit).
    if (options.project) {
        args.push('--project', options.project);
    }
    if (options.headed) {
        args.push('--headed');
    }
    if (options.heal) {
        args.push('--trace=on');
    }
    console.log(`⚡ [Shorky] Executing: npx ${args.join(' ')}\n`);
    const child = (0, child_process_1.spawn)('npx', args, {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
        shell: process.platform === 'win32',
    });
    child.on('exit', (code) => {
        if (code === 0) {
            console.log('\n✅ [Shorky] Test run completed successfully.');
            process.exit(code);
        }
        console.error(`\n⚠️ [Shorky] Test run exited with code ${code}.`);
        if (options.heal) {
            void handleHealOnFailure({ updateBaselines: options.updateBaselines }).finally(() => process.exit(code ?? 1));
        }
        else {
            process.exit(code ?? 1);
        }
    });
    child.on('error', (err) => {
        console.error('❌ [Shorky] Failed to launch Playwright test runner:', err);
        process.exit(1);
    });
});
program.parse(process.argv);
