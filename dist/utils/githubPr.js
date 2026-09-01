"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openHealingPullRequest = openHealingPullRequest;
// src/utils/githubPr.ts
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
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
/** Slugifies a spec path into something safe to embed in a git branch name. */
function slugifySpecPath(specPath) {
    return specPath
        .replace(/^\/+/, '')
        .replace(/\.(spec|test)\.[tj]sx?$/i, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
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
/**
 * Commits the already-written spec fix on a new branch, pushes it using the
 * checked-out GITHUB_TOKEN credentials, and opens a pull request against the
 * base branch via the GitHub REST API.
 *
 * Returns the PR URL on success, or null if the PR could not be created
 * (missing token/repo context, or the operation failed) — failures here are
 * logged but never thrown, so a missing PR-creation capability never crashes
 * the rest of the healing pipeline.
 */
async function openHealingPullRequest(options) {
    const { specPath, explanation, errorLog } = options;
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
        console.warn('⚠️ GITHUB_TOKEN is not set. Skipping automatic PR creation for the healed spec.');
        return null;
    }
    const ownerRepo = resolveOwnerAndRepo();
    if (!ownerRepo) {
        console.warn('⚠️ GITHUB_REPOSITORY is not set. Skipping automatic PR creation for the healed spec.');
        return null;
    }
    const { owner, repo } = ownerRepo;
    const repoRoot = process.cwd();
    const baseBranch = resolveBaseBranch();
    const relativeSpecPath = path_1.default.isAbsolute(specPath) ? path_1.default.relative(repoRoot, specPath) : specPath;
    const branchName = `shorky/auto-heal-${slugifySpecPath(relativeSpecPath)}-${Date.now()}`;
    try {
        console.log(`🌿 Creating healing branch "${branchName}" off "${baseBranch}"...`);
        // Identify the commit author as a bot so it's clear this was automated.
        git(['config', 'user.name', 'shorky-bot'], repoRoot);
        git(['config', 'user.email', 'shorky-bot@users.noreply.github.com'], repoRoot);
        git(['checkout', '-b', branchName], repoRoot);
        git(['add', relativeSpecPath], repoRoot);
        const commitMessage = `fix(auto-heal): repair ${relativeSpecPath}\n\n${explanation}`;
        git(['commit', '-m', commitMessage], repoRoot);
        console.log(`🚀 Pushing branch "${branchName}" to origin...`);
        git(['push', '--set-upstream', 'origin', branchName], repoRoot);
        console.log(`📬 Opening pull request via GitHub REST API (${owner}/${repo})...`);
        const prBody = [
            `🤖 **Shorky** automatically detected a failing test and generated a fix.`,
            '',
            `**Patched file:** \`${relativeSpecPath}\``,
            '',
            `**Explanation:**`,
            explanation || '_No explanation provided by the LLM._',
            errorLog ? `\n**Original failure:**\n\`\`\`\n${errorLog}\n\`\`\`` : '',
            '',
            '_This pull request was opened automatically by the Shorky auto-healing pipeline. Please review the diff before merging._',
        ]
            .filter(Boolean)
            .join('\n');
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                title: `fix(auto-heal): repair ${relativeSpecPath}`,
                head: branchName,
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
        console.warn('⚠️ Failed to create the auto-healing pull request:', err.message || err);
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
