import fs from 'fs';
import path from 'path';
import { AgentRunResult } from './agentRunner';

/**
 * Strips markdown code fences and stray leading file-path header comments
 * that LLMs sometimes include in generated spec code, and normalizes line
 * endings, so the output is clean, directly-runnable TypeScript.
 */
function sanitizeSpecCode(rawCode: string): string {
  return (
    rawCode
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/i, '')
      .replace(/^\/\/\s*[^\n]*\.spec\.[tj]s\n?/i, '')
      .replace(/\r\n/g, '\n')
      .trim() + '\n'
  );
}

export interface OverwriteSpecInPlaceOptions {
  /** Absolute or cwd-relative path of the original broken spec file to overwrite. */
  specPath: string;
  /** The raw LLM-generated replacement code for that spec file. */
  rawFixedCode: string;
}

export interface OverwriteSpecInPlaceResult {
  /** Whether the file was actually written. */
  written: boolean;
  /** The sanitized code that was (or would have been) written. */
  cleanedCode: string;
  /** Populated when `written` is false, explaining why the write was skipped. */
  reason?: string;
}

/**
 * Core "code synthesis" step of the healing pipeline: takes the LLM's raw
 * fix for a failing spec and overwrites the *original* broken test file
 * in-place at `specPath` — rather than writing to a new, unreferenced file
 * — so that when CI re-runs the suite on the healing branch, the very same
 * spec file Playwright discovers and executes now contains the corrected
 * code, and the run actually passes.
 *
 * Includes a guardrail that refuses to write empty, truncated, or otherwise
 * clearly-invalid output, protecting the original test file from being
 * wiped out by a malformed LLM response.
 */
export function overwriteSpecInPlace({
  specPath,
  rawFixedCode,
}: OverwriteSpecInPlaceOptions): OverwriteSpecInPlaceResult {
  const cleanedCode = sanitizeSpecCode(rawFixedCode);

  if (!cleanedCode || cleanedCode.length < 30 || !cleanedCode.includes('test(')) {
    return {
      written: false,
      cleanedCode,
      reason: `LLM generated invalid or empty spec code for ${specPath}. Aborting file write to protect the original test file.`,
    };
  }

  const absoluteSpecPath = path.isAbsolute(specPath) ? specPath : path.resolve(specPath);
  fs.mkdirSync(path.dirname(absoluteSpecPath), { recursive: true });
  fs.writeFileSync(absoluteSpecPath, cleanedCode, 'utf-8');

  return { written: true, cleanedCode };
}

/**
 * Safely extracts a quoted JSON string field value from a serialized
 * Action log line, e.g. Action: fillInput({"selector":"#user","value":"tom"}) -> ...
 */
function extractField(step: string, field: string): string | undefined {
  const match = step.match(new RegExp(`"${field}":"([^"]*)"`));
  return match ? match[1] : undefined;
}

function extractArrayField(step: string, field: string): string[] | undefined {
  const match = step.match(new RegExp(`"${field}":\\[([^\\]]*)\\]`));
  if (!match) return undefined;
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

export function generateSpecFromHistory(
  testName: string,
  outputPath: string,
  result: AgentRunResult
): void {
  const codeLines: string[] = [
    `import { test, expect } from '../src/fixtures/autoHealFixture';`,
    ``,
    `test.describe('Generated Agentic Suite', () => {`,
    `  test('${testName}', async ({ page }) => {`,
  ];

  for (const step of result.history) {
    if (step.startsWith('Action: navigate')) {
      const url = extractField(step, 'url');
      if (url) codeLines.push(`    await page.goto('${url}');`);
    } else if (step.startsWith('Action: fillInput')) {
      const selector = extractField(step, 'selector');
      const value = extractField(step, 'value');
      if (selector && value !== undefined) {
        codeLines.push(`    await page.fill('${selector}', '${value}');`);
      }
    } else if (step.startsWith('Action: clickElement')) {
      const selector = extractField(step, 'selector');
      if (selector) codeLines.push(`    await page.click('${selector}');`);
    } else if (step.startsWith('Action: selectOption')) {
      const selector = extractField(step, 'selector');
      const optionLabel = extractField(step, 'optionLabel');
      const optionValue = extractField(step, 'optionValue');
      if (selector && optionValue) {
        codeLines.push(`    await page.selectOption('${selector}', { value: '${optionValue}' });`);
      } else if (selector && optionLabel) {
        codeLines.push(`    await page.selectOption('${selector}', { label: '${optionLabel}' });`);
      }
    } else if (step.startsWith('Action: uploadFile')) {
      const selector = extractField(step, 'selector');
      const filePaths = extractArrayField(step, 'filePaths');
      if (selector && filePaths && filePaths.length > 0) {
        const filesLiteral = filePaths.map((f) => `'${f}'`).join(', ');
        codeLines.push(`    await page.setInputFiles('${selector}', [${filesLiteral}]);`);
      }
    } else if (step.startsWith('Action: keyboardPress')) {
      const key = extractField(step, 'key');
      const selector = extractField(step, 'selector');
      if (key && selector) {
        codeLines.push(`    await page.locator('${selector}').press('${key}');`);
      } else if (key) {
        codeLines.push(`    await page.keyboard.press('${key}');`);
      }
    } else if (step.startsWith('Action: evaluateState')) {
      codeLines.push(`    await expect(page.locator('h2')).toContainText('Secure Area');`);
    }
  }

  codeLines.push(`  });`);
  codeLines.push(`});`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, codeLines.join('\n'), 'utf-8');
  console.log(`📝 [Shorky Spec Generator] Saved static spec to: ${outputPath}`);

  // Persist the full trace log alongside the generated spec for cloudReporter.ts
  // to pick up and enrich the run payload.
  const traceLogPath = outputPath.replace(/\.spec\.ts$/, '.trace.json');
  try {
    fs.writeFileSync(traceLogPath, JSON.stringify(result.traceLogs || [], null, 2), 'utf-8');
    console.log(`🧾 [Shorky Spec Generator] Saved trace log to: ${traceLogPath}`);
  } catch (err) {
    console.warn(`⚠️ [Shorky Spec Generator] Failed to save trace log:`, err);
  }
}
