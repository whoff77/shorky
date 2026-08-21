import fs from 'fs';
import path from 'path';
import { AgentRunResult } from './agentRunner';

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
