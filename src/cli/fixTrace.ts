import fs from 'fs';
import path from 'path';
import { parsePlaywrightTrace } from '../engine/traceParser';
import { generateSpecFix, FixResult } from '../engine/codeFixer';

import dotenv from 'dotenv';
dotenv.config();

/**
 * Notifies shorky-cloud that a spec fix has been generated so it can be
 * tracked/surfaced in the dashboard. Failures (e.g. shorky-cloud not
 * running locally) are swallowed and logged as warnings so this never
 * crashes the local CLI workflow.
 */
async function notifyShorkyCloud(specFilePath: string, result: FixResult): Promise<void> {
  const webhookUrl = process.env.SHORKY_CLOUD_URL || 'http://localhost:3000/api/webhook';

  const payload = {
    repoOwner: process.env.GITHUB_REPOSITORY_OWNER || 'whoff77',
    repoName: process.env.GITHUB_REPOSITORY_NAME || 'shorky',
    branch: process.env.GITHUB_REF_NAME || 'main',
    specPath: specFilePath,
    fixedCode: result.fixedCode,
    explanation: result.explanation,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shorky-api-key': process.env.SHORKY_CLOUD_API_KEY || '',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn(`⚠️ shorky-cloud webhook responded with status ${response.status}. Skipping.`);
    }
  } catch (error) {
    console.warn(
      `⚠️ Unable to reach shorky-cloud webhook (${webhookUrl}). Is shorky-cloud running? Continuing offline.`,
      error instanceof Error ? error.message : error
    );
  }
}

export interface RunOfflineFixOptions {
  tracePath: string;
  specPath: string;
}

export async function runOfflineFix({ tracePath, specPath }: RunOfflineFixOptions) {
  const absoluteTracePath = path.resolve(tracePath);
  const absoluteSpecPath = path.resolve(specPath);

  if (!fs.existsSync(absoluteTracePath)) {
    console.error(`❌ Trace file not found: ${absoluteTracePath}`);
    process.exit(1);
  }

  if (!fs.existsSync(absoluteSpecPath)) {
    console.error(`❌ Spec file not found: ${absoluteSpecPath}`);
    process.exit(1);
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

  console.log(`\n🤖 Sending failure context & ${specPath} to LLM Fixer...`);
  const originalSpecCode = fs.readFileSync(absoluteSpecPath, 'utf-8');

  const fixResult = await generateSpecFix(originalSpecCode, failureContext);

  console.log(`\n✅ Fix Generated!`);
  console.log(`📝 Explanation: ${fixResult.explanation}`);
  console.log(`\n--- Code Diff Preview ---`);
  console.log(fixResult.fixedCode);

  // Write updated spec back to disk
  fs.writeFileSync(absoluteSpecPath, fixResult.fixedCode, 'utf-8');
  console.log(`\n🎉 Successfully patched: ${specPath}`);

  // Notify shorky-cloud of the successful fix (non-blocking / best-effort)
  await notifyShorkyCloud(absoluteSpecPath, fixResult);
}