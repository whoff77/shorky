// src/utils/__tests__/format.test.ts
//
// Regression coverage for the shared ANSI-stripping utilities extracted out
// of cloudReporter.ts into src/utils/format.ts, so both cloudReporter.ts
// (live TestResult) and fixTrace.ts (static report.json ReportResult) apply
// the EXACT same cleanup before persisting an error message to shorky-cloud
// or injecting it into an LLM prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsiCodes, resolveCleanErrorMessage } from '../format';

test('stripAnsiCodes: removes ANSI/VT100 color escape codes', () => {
  const raw = '\x1b[31mExpected element to be visible\x1b[39m';
  assert.equal(stripAnsiCodes(raw), 'Expected element to be visible');
});

test('stripAnsiCodes: leaves plain text untouched', () => {
  assert.equal(stripAnsiCodes('Timeout exceeded'), 'Timeout exceeded');
});

test('resolveCleanErrorMessage: prefers error.message, ANSI-stripped and trimmed', () => {
  const result = { error: { message: '  \x1b[31mLocator not found\x1b[39m  ' } };
  assert.equal(resolveCleanErrorMessage(result), 'Locator not found');
});

test('resolveCleanErrorMessage: falls back to error.stack when message is absent', () => {
  const result = { error: { stack: '\x1b[31mError: boom\x1b[39m\n    at foo.ts:1:1' } };
  assert.equal(resolveCleanErrorMessage(result), 'Error: boom\n    at foo.ts:1:1');
});

test('resolveCleanErrorMessage: falls back to errors[0].message when error is absent', () => {
  const result = { errors: [{ message: '\x1b[31mSecond chance message\x1b[39m' }] };
  assert.equal(resolveCleanErrorMessage(result), 'Second chance message');
});

test('resolveCleanErrorMessage: falls back to "Unknown error" when nothing is available', () => {
  assert.equal(resolveCleanErrorMessage({}), 'Unknown error');
  assert.equal(resolveCleanErrorMessage(undefined), 'Unknown error');
  assert.equal(resolveCleanErrorMessage(null), 'Unknown error');
});
