#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'child_process';

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
      } else {
        console.error(`\n⚠️ [Shorky] Test run exited with code ${code}.`);
      }
      process.exit(code ?? 1);
    });

    child.on('error', (err) => {
      console.error('❌ [Shorky] Failed to launch Playwright test runner:', err);
      process.exit(1);
    });
  });

program.parse(process.argv);
