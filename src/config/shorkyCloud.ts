/**
 * src/config/shorkyCloud.ts
 *
 * Single source of truth for all Shorky Cloud connection settings
 * (base URLs, endpoint construction, and API key resolution) so that the
 * various consumers (Playwright reporter, CLI trace fixer, config loader,
 * etc.) never hardcode or re-derive these values independently.
 */

/** Default endpoint used for local telemetry reporting (Playwright reporter). */
export const DEFAULT_SHORKY_CLOUD_TELEMETRY_URL = 'http://localhost:3000/api/v1/telemetry';

/** Default base URL used for the hosted shorky-cloud webhook (CLI auto-fix flow). */
export const DEFAULT_SHORKY_CLOUD_BASE_URL = 'https://shorky-cloud.vercel.app';

/**
 * Sanitizes a raw SHORKY_CLOUD_URL environment value by trimming whitespace,
 * stripping stray leading/trailing quote characters, and removing any
 * accidental markdown link artifacts (e.g. a value copy-pasted as
 * "[shorky-cloud](https://shorky-cloud.vercel.app)" instead of the bare URL).
 */
export function sanitizeCloudUrl(rawUrl: string): string {
  let sanitized = rawUrl.trim();

  // Strip markdown link syntax, keeping only the URL inside the parentheses:
  // e.g. "[label](https://example.com)" -> "https://example.com"
  const markdownLinkMatch = sanitized.match(/\]\((https?:\/\/[^)]+)\)/);
  if (markdownLinkMatch) {
    sanitized = markdownLinkMatch[1];
  }

  // Strip any remaining stray markdown artifacts like leading "[" / trailing "]"
  sanitized = sanitized.replace(/^\[+/, '').replace(/\]+$/, '');

  // Strip stray surrounding quote characters (single, double, or backtick)
  sanitized = sanitized.trim().replace(/^['"`]+/, '').replace(/['"`]+$/, '');

  return sanitized.trim();
}

/**
 * Returns whether Shorky Cloud reporting/integration should be considered
 * enabled for the current process, based on env configuration.
 */
export function isShorkyCloudEnabled(): boolean {
  return process.env.ENABLE_SHORKY_CLOUD === 'true' || !!process.env.SHORKY_CLOUD_URL;
}

/**
 * Resolves the shorky-cloud API key from the environment. Centralized so
 * every caller shares the exact same fallback ('') and env var name.
 */
export function getShorkyCloudApiKey(): string {
  return process.env.SHORKY_CLOUD_API_KEY || '';
}

/**
 * Resolves the fully-qualified telemetry endpoint used by the Playwright
 * reporter to POST run summaries after each test run.
 */
export function getShorkyCloudTelemetryUrl(): string {
  return sanitizeCloudUrl(process.env.SHORKY_CLOUD_URL || DEFAULT_SHORKY_CLOUD_TELEMETRY_URL);
}

/**
 * Resolves the fully-qualified webhook endpoint (`/api/webhook`) used by
 * the CLI auto-fix flow to notify shorky-cloud of generated fixes or
 * dispatch failure telemetry. Accepts an optional override for the base
 * URL default, since different call sites use different sensible fallbacks.
 */
export function getShorkyCloudWebhookUrl(defaultBaseUrl: string = DEFAULT_SHORKY_CLOUD_BASE_URL): string {
  const base = sanitizeCloudUrl(process.env.SHORKY_CLOUD_URL || defaultBaseUrl);
  const trimmedBase = base.replace(/\/api\/v1\/telemetry\/?$/, '').replace(/\/+$/, '');
  return `${trimmedBase}/api/webhook`;
}
