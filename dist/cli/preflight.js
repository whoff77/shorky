"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPreflightCheck = runPreflightCheck;
// src/cli/preflight.ts
//
// Pre-flight budget guard. Called immediately before Shorky starts any
// LLM-driven repair loop (the `shorky run --heal` fallback in
// `src/cli/index.ts`, and the offline/report-driven fixer entrypoints in
// `src/cli/fixTrace.ts`) so a lapsed subscription or an exhausted monthly
// token budget is caught *before* a billable OpenAI call is ever made.
//
// Talks to shorky-cloud's `POST /api/v1/preflight` endpoint (see that
// repo's `src/app/api/v1/preflight/route.ts`), authenticated via the same
// `x-shorky-api-key` header pattern used by the reporter/webhook.
const shorkyCloud_1 = require("../config/shorkyCloud");
/**
 * Performs the pre-flight budget check against shorky-cloud.
 *
 * Behavior:
 *  - Skips (returns `{ ok: true, skipped: true }`) when Shorky Cloud
 *    integration isn't configured (no API key) — matches the existing
 *    offline-friendly behavior of `cloudReporter.ts`, since there is no
 *    budget to enforce for local/unconfigured runs.
 *  - Returns `{ ok: false, status: 402 | 429, message }` when shorky-cloud
 *    explicitly rejects the request because the org subscription is
 *    inactive (402) or the monthly token budget has been exceeded (429).
 *    Callers MUST treat this as a hard stop: abort before starting the LLM
 *    repair loop and fail the CI job normally.
 *  - Fails OPEN (`{ ok: true }`) on network errors/timeouts/unexpected
 *    non-402/429 error responses, so a transient shorky-cloud outage never
 *    blocks a customer's CI pipeline — consistent with how
 *    `cloudReporter.ts` and `fixTrace.ts`'s webhook dispatch already treat
 *    connectivity failures as non-fatal.
 */
async function runPreflightCheck() {
    const apiKey = (0, shorkyCloud_1.getShorkyCloudApiKey)();
    if (!(0, shorkyCloud_1.isShorkyCloudEnabled)() || !apiKey) {
        console.log('ℹ️ [Shorky] SHORKY_CLOUD_API_KEY not configured. Skipping pre-flight budget check.');
        return { ok: true, skipped: true };
    }
    const preflightUrl = (0, shorkyCloud_1.getShorkyCloudPreflightUrl)(process.env.SHORKY_CLOUD_URL);
    try {
        console.log(`🚦 [Shorky] Running pre-flight budget check against ${preflightUrl}...`);
        const response = await fetch(preflightUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-shorky-api-key': apiKey,
            },
            body: JSON.stringify({}),
            // Short timeout so a slow/offline cloud endpoint never stalls CI.
            signal: AbortSignal.timeout(5000),
        });
        if (response.status === 402 || response.status === 429) {
            const data = await response.json().catch(() => ({}));
            const message = data?.error ||
                (response.status === 402
                    ? 'Organization subscription is not active.'
                    : 'Monthly LLM token budget exceeded.');
            console.error(`❌ [Shorky] Pre-flight check failed (HTTP ${response.status}): ${message}`);
            return { ok: false, skipped: false, status: response.status, message };
        }
        if (!response.ok) {
            // Any other non-2xx (401 invalid key, 500, etc.) — log a warning but
            // fail open rather than blocking the pipeline on an ambiguous error.
            const data = await response.json().catch(() => ({}));
            console.warn(`⚠️ [Shorky] Pre-flight check returned unexpected status ${response.status}: ${data?.error || 'Unknown error'}. Continuing without blocking.`);
            return { ok: true, skipped: false, status: response.status };
        }
        console.log('✅ [Shorky] Pre-flight budget check passed.');
        return { ok: true, skipped: false, status: response.status };
    }
    catch (error) {
        // Network error, timeout, DNS failure, etc. — fail open.
        console.warn(`ℹ️ [Shorky] Pre-flight check unavailable (${error?.message || error}). Continuing offline without blocking the run.`);
        return { ok: true, skipped: false };
    }
}
