# CLINE.md — shorky

## Project Overview

`shorky` is an **autonomous agentic SDET (Software Development Engineer in Test) framework**. It bridges AI-driven exploratory testing with deterministic, low-cost Playwright CI suites, using a two-phase architecture:

1. **Exploratory Phase (Record):** A ReAct-style AI agent (OpenAI tool/function calling) drives a live Playwright browser session, inspecting the DOM, interacting with elements, and verifying goals from natural-language instructions.
2. **Deterministic Phase (Replay):** A code synthesis engine (`generator.ts`) converts the recorded agent trace into a clean, static TypeScript Playwright spec (`*.generated.spec.ts`) that runs in CI without any live LLM calls.

It is also distributed as a **composite GitHub Action** (`action.yml`) — "Shorky AI Test Auto-Healer" — that parses a Playwright JSON report after a CI failure, resolves the failing spec + trace.zip, asks an LLM to generate a code fix (or flags a visual regression for human review), applies the fix, and opens/updates a consolidated pull request. It optionally reports telemetry to a companion SaaS, `shorky-cloud`.

The `shorky` CLI (`dist/cli/index.js`, source `src/cli/index.ts`) wraps `npx playwright test` with flags for self-healing (`--heal`), AI vision assertions (`--vision`), headed mode, and generate-only mode.

## Tech Stack & Core Tools

- **Language/Runtime:** TypeScript (strict mode), Node.js (CommonJS module output)
- **Test/Automation Engine:** Playwright (`@playwright/test`, `playwright-core`)
- **AI/Agentic Logic:** OpenAI SDK (`openai`) — structured tool/function calling for the ReAct loop and code-fix generation
- **CLI Framework:** `commander`
- **Config:** `dotenv` (loads `.env` at repo root)
- **Visual Regression:** Pixelmatch-based diffing (`src/utils/visual-diff.ts`)
- **GitHub Integration:** REST calls in `src/utils/githubPr.ts` for opening/updating auto-heal PRs
- **Build tool:** `tsc` (TypeScript compiler) — compiles `src/` → `dist/`
- **Dev runner:** `tsx` (run TypeScript directly without compiling, used for CLI dev + the GitHub Action entrypoint)
- **Archive handling:** `unzipper` (reads Playwright `trace.zip` files)
- **No database** in this repo — telemetry persistence lives in the sibling `shorky-cloud` repo.

## Key Commands

```bash
# Install dependencies
npm install

# Install Playwright browsers (required once)
npx playwright install --with-deps

# Compile TypeScript src/ -> dist/ (also produces the published CLI bin: dist/cli/index.js)
npm run build

# Run the Shorky CLI directly from source (no compile step) — dev convenience script
npm run shorky           # -> tsx src/cli/index.ts

# Run the CLI's own subcommands (after building, or via tsx)
npx tsx src/cli/index.ts run [test-pattern] --project "Google Chrome" [--heal] [--vision] [--headed] [--generate-only]

# Run Playwright tests directly
npx playwright test --project="Google Chrome"
npx playwright test tests/agent-login.spec.ts --project="Google Chrome"       # Record phase (agent exploration)
npx playwright test tests/generated-login.spec.ts --project="Google Chrome"  # Replay phase (deterministic, no LLM)

# Run the offline trace-fix analyzer manually (what action.yml invokes in CI)
npx tsx src/cli/fixTrace.ts --report test-results/report.json
npx tsx src/cli/fixTrace.ts --trace <path/to/trace.zip> --spec <path/to/spec.ts>
```

There is no dedicated `test` or `lint` npm script defined in `package.json`; tests are run via the Playwright CLI as shown above.

### Required environment variables (`.env`)
- `OPENAI_API_KEY` — required for the ReAct agent and LLM-based auto-fix generation.
- `SHORKY_CLOUD_URL` / `SHORKY_CLOUD_API_KEY` — optional; enables the Playwright reporter + webhook integration with `shorky-cloud` (`isShorkyCloudEnabled()` in `src/config/shorkyCloud.ts`).
- `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_REF_NAME` — used by `src/utils/githubPr.ts` / `fixTrace.ts` when opening auto-heal pull requests (typically provided automatically inside GitHub Actions).

## Architecture & Conventions

- **`src/agent/`** — the ReAct agent core.
  - `agentRunner.ts`: the Reason-Act-Observe loop; drives an OpenAI chat-completion tool-calling session against a live Playwright `Page`.
  - `tools.ts`: structured tool definitions the agent can call (`navigate`, `inspectDOM`, `fillInput`, `clickElement`, `evaluateState`, etc.) plus `AgentTraceEntry` trace logging shape (shared contract with `shorky-cloud`'s `src/lib/types.ts` — keep these in sync).
  - `generator.ts`: Code Synthesis Engine — converts an agent trace into a static Playwright spec file, and exposes `overwriteSpecInPlace()` used by the auto-heal fixer to patch specs in place.
- **`src/cli/`** — CLI entrypoints.
  - `index.ts`: `commander`-based `shorky run` command; spawns `npx playwright test` as a subprocess and, on failure with `--heal`, triggers the offline self-healing flow.
  - `fixTrace.ts`: the GitHub Action's core logic — parses a Playwright JSON report, resolves failing specs/traces, calls the LLM fixer, applies the patch, stages/opens a consolidated healing PR (branch `shorky/auto-heal-fixes`), and optionally notifies `shorky-cloud` via webhook. Distinguishes DOM/locator failures (LLM-fixable) from visual-regression failures (routed to a "Visual Diff Handoff" PR section for human review instead of an LLM rewrite).
- **`src/engine/`** — `traceParser.ts` (locates/parses `trace.zip` and Playwright JSON reports), `codeFixer.ts` (LLM prompt/response wiring for generating a spec fix).
- **`src/fixtures/autoHealFixture.ts`** — a custom Playwright fixture (`test.extend`) providing `autoHealPage` with `clickAndHeal()`, `assertVisual()`, `assertVisualBaseline()`. Persists healed selector mappings to `src/fixtures/healed-selectors.json` (a live cache — do not treat as static data).
- **`src/reporters/cloudReporter.ts`** — custom Playwright reporter, only registered in `playwright.config.ts` when `isShorkyCloudEnabled()` is true; POSTs run/test telemetry to `shorky-cloud`.
- **`src/config/shorkyCloud.ts`** — single source of truth for all shorky-cloud URLs/env resolution; always extend here rather than hardcoding URLs elsewhere.
- **`src/utils/`** — `githubPr.ts` (branch/PR management for auto-heal), `healingEngine.ts` (selector self-healing + AI vision assertions), `visual-diff.ts` (pixelmatch baseline comparison), `llmClient.ts`, `testGenerator.ts`.
- **`scripts/`** — standalone maintenance scripts (`apply-healed-selectors.ts`, `generate-test.ts`, `test-fixer.ts`), run via `tsx`, not part of the npm `scripts` block.
- **`tests/`** — Playwright specs including agent-driven specs (`agent-login.spec.ts`), generated deterministic specs (`generated-login.spec.ts`), and self-healing/baseline demo specs. Snapshots live under `tests/__snapshots__/` and `tests/generated-login.spec.ts-snapshots/` per `playwright.config.ts`'s `snapshotPathTemplate`.
- **CI:** `.github/workflows/playwright.yml` runs the Playwright suite on push/PR, then on `push` failure invokes the local composite action (`uses: ./`) to run the auto-healer against `test-results/report.json`.
- **Distribution:** the npm `bin` (`shorky`) points at `dist/cli/index.js`, so `npm run build` must be run before publishing/tagging a new action version (the GitHub Action referenced elsewhere as `whoff77/shorky@vX.Y.Z` uses the compiled `dist/` output plus `action.yml`).
- **Style:** favor async/await, explicit TypeScript types (avoid `any`), custom fixtures over raw page objects, and descriptive emoji-tagged console logs (e.g. `🤖 [Shorky]`, `⚠️ [Interceptor]`) — see `.cursorrules` for the original convention source.
