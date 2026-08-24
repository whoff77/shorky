// scripts/test-fixer.ts
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { findLatestTraceZip, parsePlaywrightTrace } from '../src/engine/traceParser';
import { generateSpecFix } from '../src/engine/codeFixer';
import fs from 'fs';

async function main() {
  const specPath = path.join(__dirname, '../tests/broken-login.spec.ts');
  const tracePath = findLatestTraceZip();

  if (!tracePath) {
    console.error('❌ Could not locate any trace.zip in test-results directory.');
    process.exit(1);
  }

  console.log(`🔍 Found trace artifact at: ${tracePath}`);
  console.log('📦 Parsing trace events and DOM snapshot...');
  
  const failureContext = await parsePlaywrightTrace(tracePath);
  const specCode = fs.readFileSync(specPath, 'utf-8');

  console.log('🤖 Sending DOM state and failure trace to LLM...');
  const fix = await generateSpecFix(specCode, failureContext);

  fs.writeFileSync(specPath, fix.fixedCode, 'utf-8');

  console.log('\n✅ Fix Generated with DOM Context!');
  console.log(`📝 Explanation: ${fix.explanation}\n`);
  console.log('--- Updated Spec ---');
  console.log(fix.fixedCode);
}

main().catch(console.error);