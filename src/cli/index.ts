#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'child_process';
import { findLatestTraceZip, extractSpecPathFromTrace } from '../engine/traceParser';
import { runOfflineFix } from './fixTrace';
import dotenv from 'dotenv';

dotenv.config();
const program = new Command();

program
  .name('shorky')
  .description('🤖 Shorky - Autonomous AI-powered Playwright testing framework CLI')
  .version('1.0.0');

/**
 * Prints a styled banner summarizing the active run configuration.
 */
function printBanner(options: {
  project: string;
  heal: boolean;
  vision: boolean;
  generateOnly: boolean;
  headed: boolean;
}): void {
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
  console.log(
    `🤖 [Shorky] Launching test run -> [${options.project}] ` +
      `[Self-Healing: ${heal}] [Vision: ${vision}] [Headed: ${headed}] [Generate-Only: ${generateOnly}]`
  );
  console.log('———————————————————————————————————————————————————————————\n');
}

/**
 * Locates the most recently created trace.zip under test-results/, resolves
 * its associated failing spec file, and runs the offline self-healing fixer
 * against it. Used as a fallback when Playwright exits non-zero and
 * `--heal` is enabled.
 */
async function handleHealOnFailure(): Promise<void> {
  console.log('\n🩹 [Shorky] --heal enabled. Attempting automatic self-healing fix...');

  const tracePath = findLatestTraceZip();
  if (!tracePath) {
    console.warn('⚠️ [Shorky] No trace.zip found under test-results/. Skipping self-healing.');
    return;
  }

  const specPath = extractSpecPathFromTrace(tracePath);
  if (!specPath) {
    console.warn(`⚠️ [Shorky] Could not resolve failing spec path for trace: ${tracePath}. Skipping self-healing.`);
    return;
  }

  console.log(`🔎 [Shorky] Found trace: ${tracePath}`);
  console.log(`🔎 [Shorky] Resolved failing spec: ${specPath}`);

  try {
    await runOfflineFix({ tracePath, specPath });
  } catch (error) {
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
  .action((testPattern: string | undefined, options: {
    project: string;
    heal: boolean;
    vision: boolean;
    generateOnly: boolean;
    headed: boolean;
  }) => {
    // Map CLI flags -> Shorky runtime environment/config
    process.env.SHORKY_HEAL = options.heal ? 'true' : 'false';
    process.env.SHORKY_VISION = options.vision ? 'true' : 'false';
    process.env.SHORKY_GENERATE_ONLY = options.generateOnly ? 'true' : 'false';
    process.env.SHORKY_PROJECT_NAME = options.project;

    printBanner(options);

    const args: string[] = ['playwright', 'test'];

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

    const child = spawn('npx', args, {
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
      } else {
        process.exit(code ?? 1);
      }
    });

    child.on('error', (err) => {
      console.error('❌ [Shorky] Failed to launch Playwright test runner:', err);
      process.exit(1);
    });
  });

program.parse(process.argv);
