import fs from 'fs';
import path from 'path';
import { parsePlaywrightTrace, resolveSpecSourcePath, isVisualRegressionFailure } from '../engine/traceParser';
import { generateSpecFix, FixResult } from '../engine/codeFixer';
import { getShorkyCloudApiKey, getShorkyCloudWebhookUrl } from '../config/shorkyCloud';
import { HealedFixEntry, openHealingPullRequest, pushConsolidatedHealingBranch, stageHealingFix } from '../utils/githubPr';
import { overwriteSpecInPlace } from '../agent/generator';

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

/** Expected/actual/diff PNG paths Playwright generates for a failed visual snapshot comparison. */
export interface VisualDiffArtifacts {
  expectedPath?: string;
  actualPath?: string;
  diffPath?: string;
}

export interface FailedSpecInfo {
  specPath: string;
  traceZipPath?: string;
  errorLog?: string;
  /** True when this failure is a visual regression (screenshot/pixel) mismatch, not a DOM/action failure. */
  isVisualRegression?: boolean;
  /** Populated only when isVisualRegression is true. */
  visualDiff?: VisualDiffArtifacts;
}

/**
 * Extracts the expected/actual/diff PNG attachment paths Playwright records
 * for a failed `toHaveScreenshot`/`toMatchSnapshot` assertion. Playwright
 * names these attachments `<snapshotName>-expected.png`,
 * `<snapshotName>-actual.png`, and `<snapshotName>-diff.png` respectively.
 */
function extractVisualDiffArtifacts(attachments: ReportAttachment[] | undefined): VisualDiffArtifacts {
  const artifacts: VisualDiffArtifacts = {};
  for (const attachment of attachments || []) {
    if (!attachment.path) continue;
    if (/-expected\.png$/i.test(attachment.name)) {
      artifacts.expectedPath = attachment.path;
    } else if (/-actual\.png$/i.test(attachment.name)) {
      artifacts.actualPath = attachment.path;
    } else if (/-diff\.png$/i.test(attachment.name)) {
      artifacts.diffPath = attachment.path;
    }
  }
  return artifacts;
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

        // Map the raw report entry back to the exact original source test
        // file path on disk (see resolveSpecSourcePath in traceParser.ts),
        // so the in-place healing overwrite always targets the same file
        // Playwright actually ran and failed.
        const resolvedSpecPath = resolveSpecSourcePath(spec.file) || spec.file || 'unknown-spec';

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
        const isVisual = isVisualRegressionFailure(errorLog);
        let visualDiff: VisualDiffArtifacts | undefined;
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

  // Every fix generated during this run is staged (committed) onto the
  // same shared healing branch (batchMode: true below) rather than each
  // opening its own branch/PR. Once all failures have been processed, a
  // single consolidated pull request is pushed containing every fix.
  const healedFixes: HealedFixEntry[] = [];

  for (const failure of failures) {
    console.log(`\n🎯 Target Spec: ${failure.specPath}`);
    console.log(`📦 Trace Zip: ${failure.traceZipPath || 'N/A'}`);
    if (failure.errorLog) {
      console.log(`💥 Error: ${failure.errorLog}`);
    }

    // Completely removed duplicate pre-telemetry ping (`dispatchFailureTelemetry`) 
    // to stop the triplet job expansion. Only run the offline fix cycle.

    // --- Visual Diff Handoff ---
    // Shorky's ReAct agent only synthesizes DOM/action-level code (selector
    // and interaction fixes) — it has no way to adjust pixelmatch
    // thresholds, rewrite baseline snapshots, or otherwise resolve a
    // genuine visual discrepancy. Previously, attempting an LLM code repair
    // for these failures caused the agent to "fix" unrelated selectors,
    // which never resolves the pixel mismatch and triggers a re-fail /
    // re-heal loop. Instead, bypass code generation entirely for visual
    // regressions and hand the diagnostic artifacts straight to the PR for
    // human review.
    if (failure.isVisualRegression) {
      console.log(`🖼️ Detected a visual regression failure for ${failure.specPath}. Bypassing LLM code repair (Visual Diff Handoff).`);
      if (failure.visualDiff?.expectedPath) console.log(`   - Expected: ${failure.visualDiff.expectedPath}`);
      if (failure.visualDiff?.actualPath) console.log(`   - Actual:   ${failure.visualDiff.actualPath}`);
      if (failure.visualDiff?.diffPath) console.log(`   - Diff:     ${failure.visualDiff.diffPath}`);

      const visualHandoffFix: HealedFixEntry = {
        specPath: failure.specPath,
        explanation:
          'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
        errorLog: failure.errorLog,
        isVisualRegression: true,
        visualDiff: failure.visualDiff,
      };

      try {
        stageHealingFix(visualHandoffFix);
      } catch (err: any) {
        console.warn(`⚠️ Failed to stage the visual diff handoff entry for ${failure.specPath}:`, err.message || err);
      }
      healedFixes.push(visualHandoffFix);
      continue;
    }

    // Playwright's JSON reporter emits absolute attachment paths by default,
    // but resolve defensively (relative to cwd) in case a report was
    // generated with relative paths or moved between machines.
    const resolvedTraceZipPath = failure.traceZipPath ? path.resolve(failure.traceZipPath) : undefined;
    const resolvedSpecFsPath = path.resolve(failure.specPath);

    if (resolvedTraceZipPath && fs.existsSync(resolvedTraceZipPath) && fs.existsSync(resolvedSpecFsPath)) {
      try {
        const healedFix = await runOfflineFix({
          tracePath: resolvedTraceZipPath,
          specPath: failure.specPath,
          batchMode: true,
        });
        if (healedFix) {
          healedFixes.push(healedFix);
        }
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

  if (healedFixes.length === 0) {
    console.log('ℹ️ No fixes were successfully generated. Skipping pull request creation.');
    return;
  }

  console.log(`\n📦 Pushing consolidated healing branch with ${healedFixes.length} fix(es)...`);
  const prUrl = await pushConsolidatedHealingBranch(healedFixes);

  if (!prUrl) {
    console.warn(
      `⚠️ No pull request was opened for ${healedFixes.length} healed spec(s). Ensure GITHUB_TOKEN and GITHUB_REPOSITORY are set, and that the workflow grants "contents: write" and "pull-requests: write" permissions.`
    );
  }
}

export interface RunOfflineFixOptions {
  tracePath: string;
  specPath: string;
  /**
   * When true, the healed fix is staged onto the shared consolidated
   * healing branch (via stageHealingFix) instead of immediately pushing
   * its own branch and opening its own pull request. Used by
   * runReportFix() to batch multiple fixes from the same run into a
   * single PR. Defaults to false for backward-compatible standalone use
   * (--trace/--spec CLI invocation).
   */
  batchMode?: boolean;
}

export async function runOfflineFix({ tracePath, specPath, batchMode = false }: RunOfflineFixOptions): Promise<HealedFixEntry | null> {
  const absoluteTracePath = path.resolve(tracePath);
  const absoluteSpecPath = path.resolve(specPath);

  if (!fs.existsSync(absoluteTracePath)) {
    console.error(`❌ Trace file not found: ${absoluteTracePath}`);
    if (!batchMode) process.exit(1);
    return null;
  }

  if (!fs.existsSync(absoluteSpecPath)) {
    console.error(`❌ Spec file not found: ${absoluteSpecPath}`);
    if (!batchMode) process.exit(1);
    return null;
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

  // --- Visual Diff Handoff ---
  // See runReportFix() for the full rationale: Shorky's ReAct agent only
  // synthesizes DOM/action-level code and cannot resolve genuine pixel
  // discrepancies, so bypass the LLM code repair entirely for visual
  // regression failures and hand the diagnostics off for human review
  // instead of risking an invalid "fix" that re-fails and loops.
  if (isVisualRegressionFailure(failureContext.errorMessage)) {
    console.log(`🖼️ Detected a visual regression failure for ${specPath}. Bypassing LLM code repair (Visual Diff Handoff).`);

    const visualHandoffFix: HealedFixEntry = {
      specPath,
      explanation:
        'Visual regression detected — code-level repair skipped. Review the pixel diff artifacts and update the baseline snapshot or fix the UI as appropriate.',
      errorLog: failureContext.errorMessage,
      isVisualRegression: true,
    };

    if (batchMode) {
      try {
        stageHealingFix(visualHandoffFix);
      } catch (err: any) {
        console.warn(`⚠️ Failed to stage the visual diff handoff entry for ${specPath}:`, err.message || err);
      }
    } else {
      const prUrl = await openHealingPullRequest(visualHandoffFix);
      if (!prUrl) {
        console.warn(`⚠️ No pull request was opened for the visual regression review entry for ${specPath}.`);
      }
    }

    return visualHandoffFix;
  }

  console.log(`\n🤖 Sending failure context & ${specPath} to LLM Fixer...`);
  const originalSpecCode = fs.readFileSync(absoluteSpecPath, 'utf-8');

  const fixResult = await generateSpecFix(originalSpecCode, failureContext);

  console.log(`\n✅ Fix Generated!`);
  console.log(`📝 Explanation: ${fixResult.explanation}`);
  console.log(`\n--- Code Diff Preview ---`);
  console.log(fixResult.fixedCode);

  // Code synthesis step: overwrite the *original* broken spec file in-place
  // (rather than writing to a new, unreferenced file) so that CI on the
  // healing branch actually re-runs and passes the very same spec file
  // Playwright discovered and failed on.
  const overwriteResult = overwriteSpecInPlace({
    specPath: absoluteSpecPath,
    rawFixedCode: fixResult.fixedCode,
  });

  if (!overwriteResult.written) {
    console.error(`❌ Error: ${overwriteResult.reason}`);
    return null;
  }

  console.log(`\n🎉 Successfully patched: ${specPath}`);

  const healedFix: HealedFixEntry = {
    specPath,
    explanation: fixResult.explanation,
    errorLog: failureContext.errorMessage,
  };

  if (batchMode) {
    // Stage this fix's commit onto the shared consolidated healing branch;
    // the caller (runReportFix) is responsible for pushing once after all
    // fixes in the run have been staged, so multiple failures land in a
    // single pull request instead of one PR per failing spec.
    try {
      stageHealingFix(healedFix);
      console.log(`🌿 Staged fix for ${specPath} on the consolidated healing branch.`);
    } catch (err: any) {
      console.warn(`⚠️ Failed to stage the auto-healing fix for ${specPath}:`, err.message || err);
    }
  } else {
    // Standalone invocation (--trace/--spec): commit, push, and open the
    // pull request immediately for this single fix.
    const prUrl = await openHealingPullRequest(healedFix);
    if (!prUrl) {
      console.warn(
        `⚠️ No pull request was opened for ${specPath}. Ensure GITHUB_TOKEN and GITHUB_REPOSITORY are set, and that the workflow grants "contents: write" and "pull-requests: write" permissions.`
      );
    }
  }

  // Single unified webhook dispatch containing the genuine fix payload
  await notifyShorkyCloud(
    specPath,
    { fixedCode: overwriteResult.cleanedCode, explanation: fixResult.explanation },
    absoluteTracePath,
    failureContext.errorMessage
  );

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