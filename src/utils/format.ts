// src/utils/format.ts
//
// Shared text-formatting utilities for cleaning up raw Playwright error
// strings before they are persisted to shorky-cloud or injected into an
// LLM prompt. Originally lived only inside `cloudReporter.ts`; extracted
// here so `fixTrace.ts` (which parses the static `report.json` file rather
// than live `TestResult` objects) can apply the exact same ANSI-stripping
// behavior to the `/api/webhook` payload and the `generateSpecFix()`
// prompt context, instead of leaking raw `\x1b[31m`-style terminal color
// codes into the dashboard UI or hallucinating the LLM with garbled text.

// Matches ANSI/VT100 escape sequences (e.g. `\u001b[31m`, `\u001b[39m`) that
// Playwright embeds in `error.message`/`error.stack` for terminal color
// highlighting (red for failures, etc.). These render as illegible raw
// codes like "[31m" once persisted as plain text and displayed on the
// shorky-cloud dashboard, so they're stripped before the message is ever
// stored/combined.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_CODE_RE = /\x1b\[[0-9;]*m/g;

/** Strips ANSI/VT100 color escape codes from a Playwright error string. */
export function stripAnsiCodes(value: string): string {
  return value.replace(ANSI_ESCAPE_CODE_RE, '');
}

/**
 * Minimal shape `resolveCleanErrorMessage()` needs from a Playwright test
 * result — satisfied by both the live `TestResult` (from
 * `@playwright/test/reporter`, used by `cloudReporter.ts`) and the
 * statically-parsed `ReportResult` shape `fixTrace.ts` reads out of
 * `report.json`.
 */
export interface CleanableResultSource {
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string; stack?: string }>;
}

/**
 * Resolves the single displayable error message for a given attempt,
 * stripped of ANSI color codes, falling back to the stack trace, then the
 * first entry of `errors[]` (present on both the live `TestResult` and the
 * static JSON report's `ReportResult`), then a generic placeholder when no
 * message is available at all.
 */
export function resolveCleanErrorMessage(result: CleanableResultSource | undefined | null): string {
  const raw = result?.error?.message || result?.error?.stack || result?.errors?.[0]?.message || 'Unknown error';
  return stripAnsiCodes(raw).trim();
}
