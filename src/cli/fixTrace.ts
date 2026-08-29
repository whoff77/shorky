import fs from 'fs';
import path from 'path';
import { parsePlaywrightTrace } from '../engine/traceParser';
import { generateSpecFix, FixResult } from '../engine/codeFixer';
import { getShorkyCloudApiKey, getShorkyCloudWebhookUrl } from '../config/shorkyCloud';

import dotenv from 'dotenv';
dotenv.config();

/**
 * Sends the final repaired code and trace context to shorky-cloud, 
 * ensuring it only triggers once per successful offline fix.
 */
async function notifyShorkyCloud(
  specPath: string, 
  fixResult: { fixedCode: string; explanation: string }, 
  traceZipPath?: string | null,
  errorLog?: string | null
) {
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

  const webhookUrl = getShorkyCloudWebhookUrl(process.env.SHORKY_CLOUD_URL);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shorky-api-key': getShorkyCloudApiKey(),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      console.warn(`⚠️ shorky-cloud webhook responded with status ${res.status}:`, JSON.stringify(errorData));
    } else {
      const data = await res.json();
      console.log(`🎉 Webhook dispatched successfully: ${data.prUrl || data.message || 'OK'}`);
    }
  } catch (err: any) {
    console.warn(`⚠️ Failed to trigger shorky-cloud webhook:`, err.message || err);
  }
}

// --- Playwright JSON Report Parsing (--report support) ---

interface ReportAttachment {
  name: string;
  path?: string;
  contentType?: string;
}

interface ReportResultError {
  message?: string;
  stack?: string;
}

interface ReportResult {
  status?: string;
  error?: ReportResultError;
  errors?: ReportResultError[];
  attachments?: ReportAttachment[];
}

interface ReportTest {
  results?: ReportResult[];
}

interface ReportSpec {
  file?: string;
  tests?: ReportTest[];
}

interface ReportSuite {
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}

interface PlaywrightJsonReport {
  suites?: ReportSuite[];
}

export interface FailedSpecInfo {
  specPath: string;
  traceZipPath?: string;
  errorLog?: string;
}

function collectFailedSpecsFromReport(report: PlaywrightJsonReport): FailedSpecInfo[] {
  // Keyed by resolved specPath so that (a) multiple retries of the same test
  // never produce duplicate entries, and (b) multiple failing tests inside
  // the same spec file only trigger a single offline-fix pass for that file.
  const failuresBySpec = new Map<string, FailedSpecInfo>();

  function walk(suite: ReportSuite) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        if (results.length === 0) continue;

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
        let traceAttachment: ReportAttachment | undefined;
        for (let i = results.length - 1; i >= 0; i--) {
          traceAttachment = results[i].attachments?.find((a) => a.name === 'trace' && !!a.path);
          if (traceAttachment) break;
        }

        // spec.file may already be relative (as emitted by the Playwright
        // JSON reporter for most configs) or absolute (e.g. when the report
        // is generated from a different working directory). Only apply
        // path.relative() when we actually have an absolute path so we
        // don't mangle an already-correct relative path.
        let relativeSpecPath = '';
        if (spec.file) {
          relativeSpecPath = path.isAbsolute(spec.file)
            ? path.relative(process.cwd(), spec.file)
            : spec.file;
        }
        if (relativeSpecPath && !relativeSpecPath.startsWith('tests/') && !relativeSpecPath.startsWith('tests' + path.sep)) {
          relativeSpecPath = path.join('tests', relativeSpecPath);
        }
        const resolvedSpecPath = relativeSpecPath || spec.file || 'unknown-spec';

        // Deduplicate by specPath: keep the first failure recorded for a
        // given spec file so we never re-process (and re-fix) the same file
        // multiple times in a single report.
        if (failuresBySpec.has(resolvedSpecPath)) {
          continue;
        }

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

export interface RunReportFixOptions {
  reportPath: string;
}

export async function runReportFix({ reportPath }: RunReportFixOptions) {
  const absoluteReportPath = path.resolve(reportPath);

  if (!fs.existsSync(absoluteReportPath)) {
    console.error(`❌ Report file not found: ${absoluteReportPath}`);
    process.exit(1);
  }

  console.log(`🔍 Resolving failed specs and traces from Playwright JSON report: ${reportPath}...`);
  const report: PlaywrightJsonReport = JSON.parse(fs.readFileSync(absoluteReportPath, 'utf-8'));
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

    // Playwright's JSON reporter emits absolute attachment paths by default,
    // but resolve defensively (relative to cwd) in case a report was
    // generated with relative paths or moved between machines.
    const resolvedTraceZipPath = failure.traceZipPath ? path.resolve(failure.traceZipPath) : undefined;
    const resolvedSpecFsPath = path.resolve(failure.specPath);

    if (resolvedTraceZipPath && fs.existsSync(resolvedTraceZipPath) && fs.existsSync(resolvedSpecFsPath)) {
      try {
        await runOfflineFix({ tracePath: resolvedTraceZipPath, specPath: failure.specPath });
      } catch (err) {
        console.error(`❌ Error running fixTrace for ${failure.specPath}:`, err instanceof Error ? err.message : err);
      }
    } else {
      const missing: string[] = [];
      if (!resolvedTraceZipPath || !fs.existsSync(resolvedTraceZipPath)) {
        missing.push(`trace.zip (${resolvedTraceZipPath || 'N/A'})`);
      }
      if (!fs.existsSync(resolvedSpecFsPath)) {
        missing.push(`spec file (${resolvedSpecFsPath})`);
      }
      console.warn(`⚠️ Skipping offline fix for ${failure.specPath} — missing on disk: ${missing.join(', ')}.`);
    }
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

  const cleaned = sanitizeGeneratedCode(fixResult.fixedCode);
  
  // Guardrail: Prevent wiping out test code with empty or truncated outputs
  if (!cleaned || cleaned.length < 30 || !cleaned.includes('test(')) {
    console.error(`❌ Error: LLM generated invalid or empty spec code for ${specPath}. Aborting file write to protect test file.`);
    return;
  }

  fs.writeFileSync(absoluteSpecPath, cleaned, 'utf-8');
  console.log(`\n🎉 Successfully patched: ${specPath}`);

  // Single unified webhook dispatch containing the genuine fix payload
  await notifyShorkyCloud(
    specPath,
    { fixedCode: cleaned, explanation: fixResult.explanation },
    absoluteTracePath,
    failureContext.errorMessage
  );
}

function sanitizeGeneratedCode(rawCode: string): string {
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
    } else if (args[i] === '--spec' && args[i + 1]) {
      specPath = args[i + 1];
      i++;
    } else if (args[i] === '--report' && args[i + 1]) {
      reportPath = args[i + 1];
      i++;
    }
  }

  if (reportPath) {
    runReportFix({ reportPath }).catch((err) => {
      console.error('❌ Unhandled error in runReportFix:', err);
      process.exit(1);
    });
  } else if (tracePath && specPath) {
    runOfflineFix({ tracePath, specPath }).catch((err) => {
      console.error('❌ Unhandled error in runOfflineFix:', err);
      process.exit(1);
    });
  } else {
    console.error('❌ Usage: npx tsx src/cli/fixTrace.ts --report <path> OR --trace <path> --spec <path>');
    process.exit(1);
  }
}