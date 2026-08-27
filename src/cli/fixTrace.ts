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
async function notifyShorkyCloud(specPath: string, fixResult: { fixedCode: string; explanation: string }) {
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
    } else {
      const data = await res.json();
      console.log(`🎉 Pull Request created: ${data.prUrl || 'PR opened successfully'}`);
    }
  } catch (err: any) {
    console.warn(`⚠️ Failed to trigger shorky-cloud webhook:`, err.message || err);
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

  const cleanCode = sanitizeGeneratedCode(fixResult.fixedCode);

  // Write updated spec back to disk
  fs.writeFileSync(absoluteSpecPath, cleanCode, 'utf-8');
  console.log(`\n🎉 Successfully patched: ${specPath}`);

  // Notify shorky-cloud of the successful fix (non-blocking / best-effort)
  await notifyShorkyCloud(specPath.replace(/^\/+/, ''), {
    fixedCode: cleanCode,
    explanation: fixResult.explanation,
  });
}

function sanitizeGeneratedCode(rawCode: string): string {
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