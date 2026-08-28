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
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const program = new commander_1.Command();
program
    .name('shorky')
    .description('🤖 Shorky - Autonomous AI-powered Playwright testing framework CLI')
    .version('1.0.0');
/**
 * Prints a styled banner summarizing the active run configuration.
 */
function printBanner(options) {
    const heal = options.heal ? 'ON' : 'OFF';
    const vision = options.vision ? 'ON' : 'OFF';
    const headed = options.headed ? 'ON' : 'OFF';
    const generateOnly = options.generateOnly ? 'ON' : 'OFF';
    const banner = `
 ____  _                 _
/ ___|| |__   ___  _ __ | | ___   _
\\___ \\| '_ \\ / _ \\| '__|| |/ / | | |
 ___) | | | | (_) | |   |   <| |_| |
|____/|_| |_|\\___/|_|   |_|\\_\\\\__, |
                               |___/
`;
    console.log(banner);
    console.log(`🤖 [Shorky] Launching test run -> [${options.project}] ` +
        `[Self-Healing: ${heal}] [Vision: ${vision}] [Headed: ${headed}] [Generate-Only: ${generateOnly}]`);
    console.log('———————————————————————————————————————————————————————————\n');
}
/**
 * Locates the most recently created trace.zip under test-results/, resolves
 * its associated failing spec file, and runs the offline self-healing fixer
 * against it. Used as a fallback when Playwright exits non-zero and
 * `--heal` is enabled.
 */
async function handleHealOnFailure() {
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
    try {
        await (0, fixTrace_1.runOfflineFix)({ tracePath, specPath });
    }
    catch (error) {
        console.error('❌ [Shorky] Self-healing attempt failed:', error instanceof Error ? error.message : error);
    }
}
program
    .command('run')
    .description('Run Shorky/Playwright tests with AI-powered self-healing and vision capabilities')
    .argument('[test-pattern]', 'Optional Playwright test file/pattern filter')
    .option('--project <name>', 'Browser project name to execute against', 'Google Chrome')
    .option('--heal', 'Enable automatic multi-tier selector self-healing', false)
    .option('--vision', 'Enable AI vision-based DOM evaluation and audit checks', false)
    .option('--generate-only', 'Generate standard Playwright specs without persisting cloud telemetry', false)
    .option('--headed', 'Run browser instances in headed mode for visual debugging', false)
    .action((testPattern, options) => {
    // Map CLI flags -> Shorky runtime environment/config
    process.env.SHORKY_HEAL = options.heal ? 'true' : 'false';
    process.env.SHORKY_VISION = options.vision ? 'true' : 'false';
    process.env.SHORKY_GENERATE_ONLY = options.generateOnly ? 'true' : 'false';
    process.env.SHORKY_PROJECT_NAME = options.project;
    printBanner(options);
    const args = ['playwright', 'test'];
    if (testPattern) {
        args.push(testPattern);
    }
    args.push('--project', options.project);
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
            void handleHealOnFailure().finally(() => process.exit(code ?? 1));
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
