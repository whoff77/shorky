// src/utils/githubPr.ts
import { execFileSync } from 'child_process';
import path from 'path';

/** A single healed spec file to include in the consolidated healing PR. */
export interface HealedFixEntry {
  /** Path (absolute or relative to the repo root / cwd) of the spec file that was patched. */
  specPath: string;
  /** Short human-readable explanation of the fix, from the LLM. */
  explanation: string;
  /** The original failing error message, if available (used in the PR body). */
  errorLog?: string | null;
}

/** @deprecated kept as an alias for HealedFixEntry for backward compatibility. */
export type OpenHealingPrOptions = HealedFixEntry;

/** The fixed name for the single consolidated healing branch/PR used across a run. */
export const HEALING_BRANCH_NAME = 'shorky/auto-heal-fixes';

/**
 * Resolves the "owner/repo" slug that the GitHub REST API expects, from the
 * standard GITHUB_REPOSITORY env var GitHub Actions always sets.
 */
function resolveOwnerAndRepo(): { owner: string; repo: string } | null {
  const slug = process.env.GITHUB_REPOSITORY;
  if (!slug || !slug.includes('/')) return null;
  const [owner, repo] = slug.split('/');
  return { owner, repo };
}

/**
 * Determines the base branch a healing PR should target. Prefers the actual
 * branch checked out for pull_request events (GITHUB_HEAD_REF), falls back
 * to the pushed ref (GITHUB_REF_NAME), then to 'main'.
 */
function resolveBaseBranch(): string {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_HEAD_REF) {
    return process.env.GITHUB_HEAD_REF;
  }
  return process.env.GITHUB_REF_NAME || process.env.BRANCH || 'main';
}

/** Runs a git command in `cwd`, throwing with readable output on failure. */
function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf-8')
      .trim();
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.('utf-8') || err?.message || String(err);
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

/** Returns true if an open pull request already exists for `head` -> `base`. */
async function findExistingOpenPr(
  owner: string,
  repo: string,
  headBranch: string,
  baseBranch: string,
  githubToken: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${headBranch}&base=${baseBranch}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );
    if (!response.ok) return null;
    const prs = await response.json();
    return Array.isArray(prs) && prs.length > 0 ? prs[0].html_url : null;
  } catch {
    return null;
  }
}

/** Builds the aggregated PR body describing every healed fix in this run. */
function buildPrBody(fixes: HealedFixEntry[], repoRoot: string): string {
  const sections = fixes.map((fix) => {
    const relativeSpecPath = path.isAbsolute(fix.specPath) ? path.relative(repoRoot, fix.specPath) : fix.specPath;

    return [
      `### \`${relativeSpecPath}\``,
      '',
      fix.explanation || '_No explanation provided by the LLM._',
      fix.errorLog ? `\n**Original failure:**\n\`\`\`\n${fix.errorLog}\n\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    `🤖 **Shorky** automatically detected ${fixes.length} failing test(s) and generated fixes for all of them.`,
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
export function stageHealingFix(fix: HealedFixEntry): void {
  const repoRoot = process.cwd();
  const baseBranch = resolveBaseBranch();
  const relativeSpecPath = path.isAbsolute(fix.specPath) ? path.relative(repoRoot, fix.specPath) : fix.specPath;

  git(['config', 'user.name', 'shorky-bot'], repoRoot);
  git(['config', 'user.email', 'shorky-bot@users.noreply.github.com'], repoRoot);

  // Create the shared branch off the base branch the first time it's
  // needed in this process; reuse it (already checked out) afterward.
  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (currentBranch !== HEALING_BRANCH_NAME) {
    try {
      git(['checkout', '-b', HEALING_BRANCH_NAME], repoRoot);
    } catch {
      // Branch may already exist locally from a previous fix in this run.
      git(['checkout', HEALING_BRANCH_NAME], repoRoot);
    }
  }

  git(['add', relativeSpecPath], repoRoot);

  const commitMessage = `fix(auto-heal): repair ${relativeSpecPath}\n\n${fix.explanation}`;
  git(['commit', '-m', commitMessage], repoRoot);
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
export async function pushConsolidatedHealingBranch(fixes: HealedFixEntry[]): Promise<string | null> {
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

  try {
    console.log(`🚀 Pushing consolidated healing branch "${HEALING_BRANCH_NAME}" (${fixes.length} fix(es)) to origin...`);
    git(['push', '--force-with-lease', '--set-upstream', 'origin', HEALING_BRANCH_NAME], repoRoot);

    const existingPrUrl = await findExistingOpenPr(owner, repo, HEALING_BRANCH_NAME, baseBranch, githubToken);
    if (existingPrUrl) {
      console.log(`🎉 Updated existing consolidated pull request: ${existingPrUrl}`);
      return existingPrUrl;
    }

    console.log(`📬 Opening consolidated pull request via GitHub REST API (${owner}/${repo})...`);
    const prBody = buildPrBody(fixes, repoRoot);
    const title =
      fixes.length === 1
        ? `fix(auto-heal): repair ${path.isAbsolute(fixes[0].specPath) ? path.relative(repoRoot, fixes[0].specPath) : fixes[0].specPath}`
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
        head: HEALING_BRANCH_NAME,
        base: baseBranch,
        body: prBody,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.warn(
        `⚠️ GitHub REST API responded with status ${response.status} when opening the pull request:`,
        JSON.stringify(errorData)
      );
      return null;
    }

    const pr = await response.json();
    console.log(`🎉 Pull request opened: ${pr.html_url}`);
    return pr.html_url as string;
  } catch (err: any) {
    console.warn('⚠️ Failed to create the consolidated auto-healing pull request:', err.message || err);
    return null;
  } finally {
    // Best-effort: return to the base branch so the working tree is left in
    // a sane state for any subsequent steps in the workflow.
    try {
      git(['checkout', baseBranch], repoRoot);
    } catch {
      // Ignore — nothing else in the job depends on the branch we end up on.
    }
  }
}

/**
 * Convenience single-fix wrapper preserved for backward compatibility with
 * callers that only ever heal one spec at a time: stages the fix and
 * immediately pushes/opens the (single-entry) consolidated pull request.
 */
export async function openHealingPullRequest(fix: HealedFixEntry): Promise<string | null> {
  try {
    stageHealingFix(fix);
  } catch (err: any) {
    console.warn('⚠️ Failed to stage the auto-healing fix:', err.message || err);
    return null;
  }
  return pushConsolidatedHealingBranch([fix]);
}
