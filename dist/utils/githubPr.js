"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEALING_BRANCH_NAME = void 0;
exports.__resetStagedSpecPathsForTests = __resetStagedSpecPathsForTests;
exports.buildPrBody = buildPrBody;
exports.stageHealingFix = stageHealingFix;
exports.pushConsolidatedHealingBranch = pushConsolidatedHealingBranch;
exports.openHealingPullRequest = openHealingPullRequest;
// src/utils/githubPr.ts
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
/** The fixed name for the single consolidated healing branch/PR used across a run. */
exports.HEALING_BRANCH_NAME = 'shorky/auto-heal-fixes';
/**
 * Tracks spec paths already `git add`/`git commit`-ed by `stageHealingFix()`
 * within this process, so that a spec file with multiple healed tests
 * (each producing its own `HealedFixEntry` — see `fixTrace.ts`'s
 * `additionalFailingTests` aggregation) is only ever staged/committed ONCE.
 * Without this guard, the second+ entry for the same file would either
 * `git commit` a no-op (nothing changed since the first commit already
 * captured the write) and fail with a non-zero exit, or — worse — silently
 * create confusing duplicate commits for a single file change.
 */
const stagedSpecPaths = new Set();
/**
 * Test-only helper: clears the `stagedSpecPaths` dedup guard between test
 * cases, since it is process/module-level state that would otherwise leak
 * across unrelated `stageHealingFix()` calls in the same test run.
 */
function __resetStagedSpecPathsForTests() {
    stagedSpecPaths.clear();
}
/**
 * Resolves the "owner/repo" slug that the GitHub REST API expects, from the
 * standard GITHUB_REPOSITORY env var GitHub Actions always sets.
 */
function resolveOwnerAndRepo() {
    const slug = process.env.GITHUB_REPOSITORY;
    if (!slug || !slug.includes('/'))
        return null;
    const [owner, repo] = slug.split('/');
    return { owner, repo };
}
/**
 * Determines the base branch a healing PR should target. Prefers the actual
 * branch checked out for pull_request events (GITHUB_HEAD_REF), falls back
 * to the pushed ref (GITHUB_REF_NAME), then to 'main'.
 */
function resolveBaseBranch() {
    if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_HEAD_REF) {
        return process.env.GITHUB_HEAD_REF;
    }
    return process.env.GITHUB_REF_NAME || process.env.BRANCH || 'main';
}
/** Runs a git command in `cwd`, throwing with readable output on failure. */
function git(args, cwd) {
    try {
        return (0, child_process_1.execFileSync)('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
            .toString('utf-8')
            .trim();
    }
    catch (err) {
        const stderr = err?.stderr?.toString?.('utf-8') || err?.message || String(err);
        throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
    }
}
/** Returns true if an open pull request already exists for `head` -> `base`. */
async function findExistingOpenPr(owner, repo, headBranch, baseBranch, githubToken) {
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${headBranch}&base=${baseBranch}`, {
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        if (!response.ok)
            return null;
        const prs = await response.json();
        return Array.isArray(prs) && prs.length > 0 ? prs[0].html_url : null;
    }
    catch {
        return null;
    }
}
/** Builds the aggregated PR body describing every healed fix in this run. */
function buildPrBody(fixes, repoRoot) {
    const toRelative = (specPath) => path_1.default.isAbsolute(specPath) ? path_1.default.relative(repoRoot, specPath) : specPath;
    const codeFixes = fixes.filter((fix) => !fix.isVisualRegression);
    // "Auto-Accept Visual Baselines" entries (baselineUpdated: true) are
    // rendered in their own distinct PR section below, separate from
    // visual regressions still awaiting manual human review.
    const visualFixes = fixes.filter((fix) => fix.isVisualRegression && !fix.baselineUpdated);
    const autoUpdatedBaselineFixes = fixes.filter((fix) => fix.isVisualRegression && fix.baselineUpdated);
    // Group code fixes by specPath: a single file can now have multiple
    // HealedFixEntry records — one per originally-failing test (see
    // fixTrace.ts's `additionalFailingTests` aggregation) — but they all
    // share the SAME generated fixedCode/explanation for that one file. List
    // each healed test as its own sub-bullet under a single file heading
    // instead of rendering a duplicate/near-duplicate section per test.
    const codeFixesBySpec = new Map();
    for (const fix of codeFixes) {
        const group = codeFixesBySpec.get(fix.specPath);
        if (group) {
            group.push(fix);
        }
        else {
            codeFixesBySpec.set(fix.specPath, [fix]);
        }
    }
    const codeSections = Array.from(codeFixesBySpec.entries()).map(([specPath, entries]) => {
        const [primary] = entries;
        const testNames = entries.map((e) => e.testName).filter((n) => !!n);
        return [
            `### \`${toRelative(specPath)}\``,
            '',
            testNames.length > 0 ? `**Repaired test(s):** ${testNames.map((n) => `\`${n}\``).join(', ')}` : '',
            '',
            primary.explanation || '_No explanation provided by the LLM._',
            entries.length > 1
                ? '\n**Original failures:**\n' +
                    entries
                        .map((e) => `- \`${e.testName || 'unknown test'}\`:\n  \`\`\`\n  ${(e.errorLog || 'No error message captured').replace(/\n/g, '\n  ')}\n  \`\`\``)
                        .join('\n')
                : primary.errorLog
                    ? `\n**Original failure:**\n\`\`\`\n${primary.errorLog}\n\`\`\``
                    : '',
        ]
            .filter(Boolean)
            .join('\n');
    });
    const visualSections = visualFixes.map((fix) => {
        const diff = fix.visualDiff || {};
        const artifactLines = [
            diff.expectedPath ? `- **Expected:** \`${diff.expectedPath}\`` : null,
            diff.actualPath ? `- **Actual:** \`${diff.actualPath}\`` : null,
            diff.diffPath ? `- **Diff:** \`${diff.diffPath}\`` : null,
        ].filter(Boolean);
        return [
            `### \`${toRelative(fix.specPath)}\``,
            '',
            'Shorky detected a **visual regression** (screenshot/pixel-diff mismatch) for this test. ' +
                'Code-level repairs (selectors, actions, locators) cannot fix a genuine pixel discrepancy, ' +
                'so this test was intentionally left unmodified — please review the diff artifacts below and ' +
                'either update the baseline snapshot or fix the underlying visual issue manually.',
            '',
            artifactLines.length > 0 ? artifactLines.join('\n') : '_No diff artifact paths were found in the report._',
            fix.errorLog ? `\n**Original failure:**\n\`\`\`\n${fix.errorLog}\n\`\`\`` : '',
        ]
            .filter(Boolean)
            .join('\n');
    });
    // "Auto-Accept Visual Baselines" — entries where update-baselines was
    // enabled and Shorky successfully overwrote the local baseline PNG with
    // the newly captured "actual" screenshot. Rendered distinctly from both
    // LLM code fixes and unresolved visual regressions, since no code was
    // changed and no manual review decision is required — just a visual
    // confirmation that the new baseline is correct.
    const autoUpdatedBaselineSections = autoUpdatedBaselineFixes.map((fix) => {
        const diff = fix.visualDiff || {};
        return [
            `### \`${toRelative(fix.specPath)}\``,
            '',
            'Shorky detected a **visual regression** for this test and automatically accepted the new ' +
                'screenshot as the updated baseline (opted in via `--update-baselines` / `update-visual-baselines`). ' +
                'The baseline PNG below has been overwritten and is included in this PR — please give it a quick ' +
                'visual look before merging.',
            '',
            diff.expectedPath ? `- **Updated baseline:** \`${toRelative(diff.expectedPath)}\`` : null,
            diff.actualPath ? `- **Source (actual) screenshot:** \`${diff.actualPath}\`` : null,
            fix.errorLog ? `\n**Original failure:**\n\`\`\`\n${fix.errorLog}\n\`\`\`` : '',
        ]
            .filter((line) => line !== null && line !== undefined)
            .filter(Boolean)
            .join('\n');
    });
    const sections = [];
    if (codeSections.length > 0) {
        sections.push('## 🩹 Code Fixes', '', ...codeSections);
    }
    if (autoUpdatedBaselineSections.length > 0) {
        if (sections.length > 0)
            sections.push('');
        sections.push('## 🖼️ Auto-Updated Visual Baselines', '', 'The following visual regression(s) were automatically accepted as the new baseline — the ' +
            '"actual" screenshot from the failing run was written over the local baseline PNG and is ' +
            'staged in this PR for review.', '', ...autoUpdatedBaselineSections);
    }
    if (visualSections.length > 0) {
        if (sections.length > 0)
            sections.push('');
        sections.push('## 🖼️ [Visual Review Required]', '', 'The following test(s) failed due to visual regressions and were **not** auto-repaired. ' +
            'They require a human to review the pixel diff and either accept the new UI (update the ' +
            'baseline snapshot) or fix the visual bug.', '', ...visualSections);
    }
    const summaryParts = [];
    if (codeFixes.length > 0)
        summaryParts.push(`${codeFixes.length} code fix(es)`);
    if (autoUpdatedBaselineFixes.length > 0)
        summaryParts.push(`${autoUpdatedBaselineFixes.length} visual baseline(s) auto-updated`);
    if (visualFixes.length > 0)
        summaryParts.push(`${visualFixes.length} visual regression(s) flagged for review`);
    return [
        `🤖 **Shorky** automatically processed ${fixes.length} failing test(s): ${summaryParts.join(' and ')}.`,
        '',
        ...sections,
        '',
        '_This pull request was opened automatically by the Shorky auto-healing pipeline. Please review the diff before merging._',
    ].join('\n');
}
/**
 * Stages one healed spec fix onto the shared consolidated healing branch.
 * Creates the branch (off the base branch) on first use within a process,
 * or reuses/checks-out the existing local branch on subsequent calls so
 * that multiple fixes from the same run land as a single commit history on
 * one branch rather than one branch/commit per spec.
 *
 * This only stages + commits locally; call `pushConsolidatedHealingBranch`
 * once after all fixes have been staged to push and open (or update) the
 * single pull request.
 */
function stageHealingFix(fix) {
    const repoRoot = process.cwd();
    const baseBranch = resolveBaseBranch();
    const relativeSpecPath = path_1.default.isAbsolute(fix.specPath) ? path_1.default.relative(repoRoot, fix.specPath) : fix.specPath;
    git(['config', 'user.name', 'shorky-bot'], repoRoot);
    git(['config', 'user.email', 'shorky-bot@users.noreply.github.com'], repoRoot);
    // Create the shared branch off the base branch the first time it's
    // needed in this process; reuse it (already checked out) afterward. This
    // still happens for visual-regression entries so the branch exists and
    // the entry can be surfaced in the consolidated PR body, even though no
    // file is modified/committed for it.
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    if (currentBranch !== exports.HEALING_BRANCH_NAME) {
        try {
            git(['checkout', '-b', exports.HEALING_BRANCH_NAME], repoRoot);
        }
        catch {
            // Branch may already exist locally from a previous fix in this run.
            git(['checkout', exports.HEALING_BRANCH_NAME], repoRoot);
        }
    }
    if (fix.isVisualRegression) {
        if (fix.baselineUpdated && fix.visualDiff?.expectedPath) {
            // "Auto-Accept Visual Baselines": fixTrace.ts has already overwritten
            // the local baseline PNG (visualDiff.expectedPath) on disk with the
            // newly captured "actual" screenshot. Stage + commit that binary PNG
            // just like a code fix, so it's included in the consolidated PR. `git
            // add` handles binary files (including PNGs) transparently — no
            // special flags are required, unlike a manual diff/patch-based
            // staging approach.
            const relativeBaselinePath = path_1.default.isAbsolute(fix.visualDiff.expectedPath)
                ? path_1.default.relative(repoRoot, fix.visualDiff.expectedPath)
                : fix.visualDiff.expectedPath;
            if (!stagedSpecPaths.has(relativeBaselinePath)) {
                git(['add', relativeBaselinePath], repoRoot);
                const commitMessage = `fix(auto-heal): auto-accept visual baseline for ${relativeSpecPath}\n\n${fix.explanation}`;
                git(['commit', '-m', commitMessage], repoRoot);
                stagedSpecPaths.add(relativeBaselinePath);
            }
            return;
        }
        // Visual Diff Handoff (no auto-accept): no code was generated or file
        // modified for this failure, so there is nothing to git-add/commit.
        // It's still included in the consolidated PR body (via buildPrBody)
        // under the "[Visual Review Required]" section for human review.
        return;
    }
    // A single spec file can now produce multiple HealedFixEntry records —
    // one per originally-failing test (see fixTrace.ts's
    // `additionalFailingTests` aggregation) — but there is only ONE file
    // write/commit to make per file. Skip re-staging/committing a spec path
    // that was already committed earlier in this run, so a file with N
    // healed tests never attempts N git commits for what is really a single
    // change.
    if (stagedSpecPaths.has(relativeSpecPath)) {
        return;
    }
    git(['add', relativeSpecPath], repoRoot);
    const commitMessage = `fix(auto-heal): repair ${relativeSpecPath}\n\n${fix.explanation}`;
    git(['commit', '-m', commitMessage], repoRoot);
    stagedSpecPaths.add(relativeSpecPath);
}
/**
 * Pushes the consolidated healing branch (containing every commit staged
 * via `stageHealingFix`) and opens a single pull request against the base
 * branch via the GitHub REST API, aggregating all fixes into one PR body.
 * If a PR already exists for this branch, the push simply updates it
 * instead of creating a duplicate.
 *
 * Returns the PR URL on success, or null if the PR could not be created
 * (missing token/repo context, no fixes staged, or the operation failed) —
 * failures here are logged but never thrown, so a missing PR-creation
 * capability never crashes the rest of the healing pipeline.
 */
async function pushConsolidatedHealingBranch(fixes) {
    if (fixes.length === 0) {
        console.log('ℹ️ No healed fixes were staged. Skipping pull request creation.');
        return null;
    }
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
        console.warn('⚠️ GITHUB_TOKEN is not set. Skipping automatic PR creation for the healed specs.');
        return null;
    }
    const ownerRepo = resolveOwnerAndRepo();
    if (!ownerRepo) {
        console.warn('⚠️ GITHUB_REPOSITORY is not set. Skipping automatic PR creation for the healed specs.');
        return null;
    }
    const { owner, repo } = ownerRepo;
    const repoRoot = process.cwd();
    const baseBranch = resolveBaseBranch();
    // If every staged fix was a visual regression (Visual Diff Handoff mode),
    // no files were modified and no commits exist beyond the base branch.
    // GitHub rejects pull requests with an identical head/base, so in that
    // case skip PR creation and instead print the visual diagnostics
    // directly to the console/workflow logs for visibility.
    let commitsAhead = 0;
    try {
        const countOutput = git(['rev-list', '--count', `${baseBranch}..${exports.HEALING_BRANCH_NAME}`], repoRoot);
        commitsAhead = parseInt(countOutput, 10) || 0;
    }
    catch {
        // If we can't determine this (e.g. base branch ref unavailable locally),
        // fall through and let the push/PR attempt below surface any real error.
        // Both plain code fixes AND auto-accepted visual baselines (which stage
        // a real PNG commit — see stageHealingFix) count as real commits here;
        // only un-updated visual-regression handoff entries produce no commit.
        commitsAhead = fixes.some((f) => !f.isVisualRegression || f.baselineUpdated) ? 1 : 0;
    }
    if (commitsAhead === 0) {
        console.log(`ℹ️ No code changes to commit — ${fixes.length} fix(es) were all visual regressions flagged for human review:`);
        for (const fix of fixes) {
            const relPath = path_1.default.isAbsolute(fix.specPath) ? path_1.default.relative(repoRoot, fix.specPath) : fix.specPath;
            console.log(`   🖼️ [Visual Review Required] ${relPath}`);
            if (fix.visualDiff?.expectedPath)
                console.log(`      - Expected: ${fix.visualDiff.expectedPath}`);
            if (fix.visualDiff?.actualPath)
                console.log(`      - Actual:   ${fix.visualDiff.actualPath}`);
            if (fix.visualDiff?.diffPath)
                console.log(`      - Diff:     ${fix.visualDiff.diffPath}`);
        }
        console.log('ℹ️ Skipping pull request creation since there are no code changes to review.');
        return null;
    }
    try {
        // Use a hard --force push rather than --force-with-lease: CI runners
        // typically perform a shallow/fresh checkout with no remote-tracking
        // ref for a pre-existing shorky/auto-heal-fixes branch, which causes
        // --force-with-lease's stale-info safety check to reject the push
        // (`! [rejected] ... (stale info)`) even though there's no real
        // conflict. This branch is an automated, bot-managed branch that only
        // exists to aggregate the current run's fixes, so it is always safe
        // and correct to unconditionally overwrite it on every run.
        console.log(`🚀 Pushing consolidated healing branch "${exports.HEALING_BRANCH_NAME}" (${fixes.length} fix(es)) to origin...`);
        git(['push', '--force', '--set-upstream', 'origin', exports.HEALING_BRANCH_NAME], repoRoot);
        const existingPrUrl = await findExistingOpenPr(owner, repo, exports.HEALING_BRANCH_NAME, baseBranch, githubToken);
        if (existingPrUrl) {
            console.log(`🎉 Updated existing consolidated pull request: ${existingPrUrl}`);
            return existingPrUrl;
        }
        console.log(`📬 Opening consolidated pull request via GitHub REST API (${owner}/${repo})...`);
        const prBody = buildPrBody(fixes, repoRoot);
        const title = fixes.length === 1
            ? `fix(auto-heal): repair ${path_1.default.isAbsolute(fixes[0].specPath) ? path_1.default.relative(repoRoot, fixes[0].specPath) : fixes[0].specPath}`
            : `fix(auto-heal): repair ${fixes.length} failing tests`;
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                title,
                head: exports.HEALING_BRANCH_NAME,
                base: baseBranch,
                body: prBody,
            }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.warn(`⚠️ GitHub REST API responded with status ${response.status} when opening the pull request:`, JSON.stringify(errorData));
            return null;
        }
        const pr = await response.json();
        console.log(`🎉 Pull request opened: ${pr.html_url}`);
        return pr.html_url;
    }
    catch (err) {
        console.warn('⚠️ Failed to create the consolidated auto-healing pull request:', err.message || err);
        return null;
    }
    finally {
        // Best-effort: return to the base branch so the working tree is left in
        // a sane state for any subsequent steps in the workflow.
        try {
            git(['checkout', baseBranch], repoRoot);
        }
        catch {
            // Ignore — nothing else in the job depends on the branch we end up on.
        }
    }
}
/**
 * Convenience single-fix wrapper preserved for backward compatibility with
 * callers that only ever heal one spec at a time: stages the fix and
 * immediately pushes/opens the (single-entry) consolidated pull request.
 */
async function openHealingPullRequest(fix) {
    try {
        stageHealingFix(fix);
    }
    catch (err) {
        console.warn('⚠️ Failed to stage the auto-healing fix:', err.message || err);
        return null;
    }
    return pushConsolidatedHealingBranch([fix]);
}
