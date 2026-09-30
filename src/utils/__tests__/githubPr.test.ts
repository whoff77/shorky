// src/utils/__tests__/githubPr.test.ts
//
// Regression tests for githubPr.ts's handling of MULTIPLE HealedFixEntry
// records that share the same specPath (one per originally-failing test in
// that file — see fixTrace.ts's `additionalFailingTests` aggregation):
//
//   1. `buildPrBody` must group them under a single file heading instead of
//      rendering a duplicate/near-duplicate section per test.
//   2. `stageHealingFix` must only `git add`/`git commit` a given spec path
//      ONCE, even when called multiple times for the same file.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
// Imported via `require` (rather than `import * as`) so `mock.method()` can
// patch the exact same module-object reference `../githubPr.ts`'s own
// `require('child_process')` resolves to — an ESM namespace import creates
// a separate binding that `mock.method` cannot intercept.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('child_process');

import { buildPrBody, stageHealingFix, __resetStagedSpecPathsForTests, HealedFixEntry } from '../githubPr';

beforeEach(() => {
  __resetStagedSpecPathsForTests();
});

afterEach(() => {
  mock.restoreAll();
  __resetStagedSpecPathsForTests();
});

// --- buildPrBody: grouping multiple tests under one file heading --------

test('buildPrBody: groups multiple HealedFixEntry records for the SAME file under a single heading', () => {
  const fixes: HealedFixEntry[] = [
    {
      specPath: '/repo/tests/dynamic-form-elements.spec.ts',
      explanation: 'Fixed both the checkbox and dropdown selectors.',
      errorLog: 'Checkbox not found',
      fixedCode: 'test(...)',
      testName: 'checkbox should toggle correctly',
    },
    {
      specPath: '/repo/tests/dynamic-form-elements.spec.ts',
      explanation: 'Fixed both the checkbox and dropdown selectors.',
      errorLog: 'Dropdown option missing',
      fixedCode: 'test(...)',
      testName: 'dropdown should select an option',
    },
    {
      specPath: '/repo/tests/broken-login-flow.spec.ts',
      explanation: 'Fixed the login flow.',
      errorLog: 'Login button not found',
      fixedCode: 'test(...)',
      testName: 'user should be able to log in',
    },
  ];

  const body = buildPrBody(fixes, '/repo');

  const occurrences = body.split('dynamic-form-elements.spec.ts').length - 1;
  assert.equal(occurrences, 1, 'the file heading for a multi-test spec should only appear once');

  assert.match(body, /checkbox should toggle correctly/);
  assert.match(body, /dropdown should select an option/);
  assert.match(body, /user should be able to log in/);
  assert.match(body, /broken-login-flow\.spec\.ts/);
});

// --- stageHealingFix: commit-once-per-file dedup guard -------------------

test('stageHealingFix: only runs `git add`/`git commit` ONCE for a spec path healed by multiple HealedFixEntry records', () => {
  const execCalls: string[][] = [];
  mock.method(childProcess, 'execFileSync', (_cmd: string, args: string[]) => {
    execCalls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from('shorky/auto-heal-fixes');
    return Buffer.from('');
  });

  const fixA: HealedFixEntry = {
    specPath: 'tests/dynamic-form-elements.spec.ts',
    explanation: 'Fixed both failing tests.',
    fixedCode: 'test(...)',
    testName: 'checkbox should toggle correctly',
  };
  const fixB: HealedFixEntry = {
    specPath: 'tests/dynamic-form-elements.spec.ts',
    explanation: 'Fixed both failing tests.',
    fixedCode: 'test(...)',
    testName: 'dropdown should select an option',
  };

  stageHealingFix(fixA);
  stageHealingFix(fixB);

  const commitCalls = execCalls.filter((args) => args[0] === 'commit');
  const addCalls = execCalls.filter((args) => args[0] === 'add');

  assert.equal(addCalls.length, 1, 'git add should only run once for the same spec path');
  assert.equal(commitCalls.length, 1, 'git commit should only run once for the same spec path');
});

test('stageHealingFix: does not attempt to commit visual-regression entries (no file was modified)', () => {
  const execCalls: string[][] = [];
  mock.method(childProcess, 'execFileSync', (_cmd: string, args: string[]) => {
    execCalls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from('shorky/auto-heal-fixes');
    return Buffer.from('');
  });

  stageHealingFix({
    specPath: 'tests/visual.spec.ts',
    explanation: 'Visual regression detected.',
    isVisualRegression: true,
    testName: 'visual test',
  });

  const commitCalls = execCalls.filter((args) => args[0] === 'commit');
  assert.equal(commitCalls.length, 0);
});

// --- stageHealingFix / buildPrBody: "Auto-Accept Visual Baselines" -------

test('stageHealingFix: git add/commits the updated baseline PNG when baselineUpdated is true', () => {
  const execCalls: string[][] = [];
  mock.method(childProcess, 'execFileSync', (_cmd: string, args: string[]) => {
    execCalls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from('shorky/auto-heal-fixes');
    return Buffer.from('');
  });

  stageHealingFix({
    specPath: 'tests/visual.spec.ts',
    explanation: 'Visual regression auto-accepted.',
    isVisualRegression: true,
    baselineUpdated: true,
    visualDiff: {
      expectedPath: 'tests/__snapshots__/visual.spec.ts/sample.png',
      actualPath: 'test-results/visual/sample-actual.png',
    },
    testName: 'visual test',
  });

  const addCalls = execCalls.filter((args) => args[0] === 'add');
  const commitCalls = execCalls.filter((args) => args[0] === 'commit');

  assert.equal(addCalls.length, 1, 'git add should stage the updated baseline PNG');
  assert.deepEqual(addCalls[0], ['add', 'tests/__snapshots__/visual.spec.ts/sample.png']);
  assert.equal(commitCalls.length, 1, 'git commit should run once for the updated baseline');
});

test('buildPrBody: lists baselineUpdated visual fixes under the "Auto-Updated Visual Baselines" section, separate from manual-review visual fixes', () => {
  const fixes: HealedFixEntry[] = [
    {
      specPath: '/repo/tests/auto-updated.spec.ts',
      explanation: 'Baseline auto-accepted.',
      isVisualRegression: true,
      baselineUpdated: true,
      visualDiff: { expectedPath: '/repo/tests/__snapshots__/auto-updated.spec.ts/sample.png', actualPath: '/tmp/actual.png' },
      testName: 'auto updated test',
    },
    {
      specPath: '/repo/tests/manual-review.spec.ts',
      explanation: 'Visual regression detected.',
      isVisualRegression: true,
      testName: 'manual review test',
    },
  ];

  const body = buildPrBody(fixes, '/repo');

  assert.match(body, /Auto-Updated Visual Baselines/);
  assert.match(body, /auto-updated\.spec\.ts/);
  assert.match(body, /\[Visual Review Required\]/);
  assert.match(body, /manual-review\.spec\.ts/);

  // The auto-updated entry must NOT also appear under the manual-review section.
  const visualReviewSectionIndex = body.indexOf('[Visual Review Required]');
  const manualSectionText = body.slice(visualReviewSectionIndex);
  assert.doesNotMatch(manualSectionText, /auto-updated\.spec\.ts/);
});
