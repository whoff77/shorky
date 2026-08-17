import fs from 'fs';
import path from 'path';
import { AgentRunResult } from './agentRunner';

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
      const match = step.match(/url":"([^"]+)"/);
      if (match) codeLines.push(`    await page.goto('${match[1]}');`);
    } else if (step.startsWith('Action: fillInput')) {
      const selectorMatch = step.match(/selector":"([^"]+)"/);
      const valueMatch = step.match(/value":"([^"]+)"/);
      if (selectorMatch && valueMatch) {
        codeLines.push(`    await page.fill('${selectorMatch[1]}', '${valueMatch[1]}');`);
      }
    } else if (step.startsWith('Action: clickElement')) {
      const match = step.match(/selector":"([^"]+)"/);
      if (match) codeLines.push(`    await page.click('${match[1]}');`);
    } else if (step.startsWith('Action: evaluateState')) {
      codeLines.push(`    await expect(page.locator('h2')).toContainText('Secure Area');`);
    }
  }

  codeLines.push(`  });`);
  codeLines.push(`});`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, codeLines.join('\n'), 'utf-8');
  console.log(`📝 [Shorky Spec Generator] Saved static spec to: ${outputPath}`);
}