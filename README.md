# Shorky

> **Autonomous Agentic SDET Framework**<br>
> Deterministic, high-integrity Playwright CI suites with AI-powered self-healing.

## Overview

Flaky tests and broken selectors are the biggest sources of CI noise and wasted engineering time. Traditional AI testing tools try to solve this by intercepting clicks at runtime, which hides the real bug and introduces massive LLM latency into every test run.

**Shorky completely rejects runtime healing.** 

Instead, Shorky uses a **"Fail-and-Rewrite"** architecture. Your tests execute at native browser speeds with zero LLM API overhead. When a test fails in CI, Shorky kicks in *after* the run: it parses the Playwright trace, uses an LLM to diagnose the failure using the DOM snapshot, **permanently rewrites the underlying `.spec.ts` source code**, and opens a single consolidated pull request for a human to review.

The core self-healing engine is **BYOK (Bring Your Own OpenAI Key) and open-source**.

---

## The Shorky Ecosystem

Shorky is designed as a three-part ecosystem, separating the core open-source engine from the optional, monetized governance and observability layer.

1. **`shorky` (The Core Engine):** This repository. Shipped as a local CLI and a composite GitHub Action. It processes failed Playwright JSON reports, orchestrates the LLM code-fixes, overwrites local files, and handles GitHub PR creation. 
2. **`shorky-cloud` (The SaaS):** The hosted telemetry and governance dashboard. It provides a per-project API key to track run history, self-healing trace timelines, and LLM token spend. For paying "Pro" tier users, it enforces a monthly token budget guardrail to prevent runaway LLM costs in CI.
3. **`shorky-test-consumer` (The Proving Ground):** A live sample repository configured with intentionally broken specs to validate the end-to-end GitHub Action batching loop and Cloud governance gates.

---

## Architecture Flow

```text
[ Standard Playwright CI Run ]
           │
           ▼
┌─────────────────────────────┐
│  Test Fails (Timeout/DOM)   │
│  Generates JSON + trace.zip │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Shorky CLI (fixTrace.ts)   │
│  Extracts DOM / Error Log   │
└──────────┬──────────────────┘
           │ (Pre-flight governance check via Shorky Cloud)
           ▼
┌─────────────────────────────┐
│ OpenAI LLM (codeFixer.ts)   │
│ Identifies correct selector │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Shorky Overwrites Source   │
│  (*.spec.ts patched locally)│
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Shorky Opens GitHub PR      │
│ (One batched PR per CI run) │
└─────────────────────────────┘
```

---

## Key Features

* **Fail-and-Rewrite Engine:** Fixes the actual source code instead of masking failures at runtime.
* **Batch PR Generation:** Aggregates all AI fixes from a single CI run into exactly *one* consolidated pull request.
* **Zero CI Latency:** Tests run normally. The LLM is only invoked if a test actually fails.
* **Pre-Flight Governance Guard:** Before starting any LLM repair loop, Shorky queries `shorky-cloud`'s tier-aware `/api/v1/governance/preflight` endpoint to confirm the organization's monthly token budget hasn't been exceeded, gracefully aborting (via `allowExecution: false`) to prevent unbounded OpenAI spend. The same check also reports free-tier cloud telemetry storage-quota usage, letting the CLI skip a wasted `/api/v1/telemetry` upload once quota is exhausted and surface a "⚠️ 8,200/10,000 free telemetry events used" warning in the run banner.
* **Visual Regression Fallbacks:** Handles pixelmatch diffs safely by flagging them for human review rather than hallucinating code changes for intentional UI updates.
* **Auto-Accept Visual Baselines (opt-in):** When enabled (`--update-baselines` / `update-visual-baselines`), Shorky automatically overwrites the local baseline PNG with the new "actual" screenshot from the failing run and stages it into the batched PR under its own "🖼️ Auto-Updated Visual Baselines" section — no manual review step required. Defaults to off, preserving the flag-for-review behavior above.

---

## Getting Started

### Prerequisites

* Node.js v18+
* An OpenAI API Key (`OPENAI_API_KEY`)
* (Optional) A `shorky-cloud` API key (`SHORKY_CLOUD_API_KEY`) to enable telemetry, dashboard run history, and the pre-flight governance/budget guard. That's the only secret needed to opt into cloud features — Shorky talks to the hosted production instance (`https://shorky-cloud.vercel.app`) by default.
* **GitHub Repository Settings:** If running Shorky as a GitHub Action, navigate to your repository **Settings > Actions > General > Workflow permissions** and ensure **"Allow GitHub Actions to create and approve pull requests"** is checked.

### Usage in CI (GitHub Actions)

Add the Shorky action to your Playwright workflow directly after your test step. It will automatically detect failures, heal the code, and open a PR.

```yaml
      - name: Run Playwright Tests
        run: npx playwright test
        
      - name: Run Shorky Auto-Healer
        if: failure()
        uses: whoff77/shorky@vX.Y.Z
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          shorky-cloud-api-key: ${{ secrets.SHORKY_CLOUD_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          report-path: "test-results/report.json"
          # Optional: "Auto-Accept Visual Baselines". By default (omitted/false),
          # visual regressions are only flagged for manual review in the PR body.
          # Set to 'true' to have Shorky automatically overwrite the local
          # baseline PNG with the new "actual" screenshot and stage it into the
          # auto-heal PR instead.
          update-visual-baselines: "false"
```

Locally, the equivalent CLI flag is `--update-baselines` (e.g. `shorky run --heal --update-baselines`).

### Usage Locally (CLI)

You can run Shorky manually against a broken trace file on your local machine:

```bash
# 1. Run your test and let it fail to generate a trace
npx playwright test tests/broken-login.spec.ts

# 2. Point Shorky at the generated trace and tell it which file to patch
npx tsx src/cli/fixTrace.ts \
  --trace test-results/broken-login/trace.zip \
  --spec tests/broken-login.spec.ts
```

### Advanced: Self-Hosting / Local Tunnel

`SHORKY_CLOUD_URL` is an **optional** environment variable, only needed if you're running your own `shorky-cloud` instance locally or via a tunnel (e.g. `http://localhost:3000` or an `ngrok` URL). It defaults to the hosted production origin (`https://shorky-cloud.vercel.app`) and does not need a path — Shorky normalizes whatever value it's given down to just the base origin before constructing each endpoint. Most consumer repos never need to set this.

---

## Tech Stack

* **Core Runtime:** TypeScript, Node.js
* **Automation Engine:** Playwright
* **AI Engine:** OpenAI API (Structured Tool / Function Calling)
* **Telemetry & SaaS:** Next.js, NextAuth v5, Neon (Postgres), Stripe

---

## License

This project is licensed under the MIT License.