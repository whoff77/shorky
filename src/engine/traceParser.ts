// src/engine/traceParser.ts
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';

interface TraceZipFile {
  filePath: string;
  mtimeMs: number;
}

export interface TraceFailureContext {
  failedAction?: string;
  failedSelector?: string;
  errorMessage?: string;
  actionMethod?: string;
  domSnapshot?: string;
}

/**
 * Recursively locates the newest trace.zip file in test-results if no explicit path is given
 */
// src/engine/traceParser.ts

export function findLatestTraceZip(baseDir = 'test-results'): string | null {
  if (!fs.existsSync(baseDir)) return null;

  const zipFiles: TraceZipFile[] = [];

  function collectZips(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        collectZips(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.zip')) {
        const stat = fs.statSync(fullPath);
        zipFiles.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }

  collectZips(baseDir);

  if (zipFiles.length === 0) return null;

  // Sort by newest modified time
  zipFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return zipFiles[0].filePath;
}


/**
 * Attempts to determine the failing spec file path associated with a given
 * trace.zip artifact.
 *
 * Strategy:
 * 1. Look for an `error-context.md` file alongside the trace.zip (Playwright
 *    writes one per failing test into the same test-results subfolder) and
 *    parse its `Location: <path>:<line>:<col>` line.
 * 2. Fall back to inferring the spec file from the trace folder name (e.g.
 *    `broken-login-user-should-be-able-to-log-in-Google-Chrome`) by matching
 *    its slug prefix against the spec files present in `testDir`.
 */
export function extractSpecPathFromTrace(traceZipPath: string, testDir = 'tests'): string | null {
  const traceDir = path.dirname(traceZipPath);

  // 1. Prefer the explicit "Location:" reference inside error-context.md
  const errorContextPath = path.join(traceDir, 'error-context.md');
  if (fs.existsSync(errorContextPath)) {
    const contents = fs.readFileSync(errorContextPath, 'utf-8');
    const match = contents.match(/Location:\s*([^\s:]+):\d+:\d+/);
    if (match) {
      return match[1];
    }
  }

  // 2. Fall back to matching the trace folder name against known spec files
  if (fs.existsSync(testDir)) {
    const folderName = path.basename(traceDir);
    const specFiles = fs
      .readdirSync(testDir)
      .filter((f) => f.endsWith('.spec.ts') || f.endsWith('.test.ts'));

    const slugify = (value: string) =>
      value.replace(/\.(spec|test)\.ts$/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

    const normalizedFolder = folderName.toLowerCase();
    const bestMatch = specFiles.find((file) => normalizedFolder.startsWith(slugify(file)));

    if (bestMatch) {
      return path.join(testDir, bestMatch);
    }
  }

  return null;
}

export async function parsePlaywrightTrace(traceZipPath: string): Promise<TraceFailureContext> {
  const extractDir = path.join(process.cwd(), '.shorky-temp-trace');

  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await fs
      .createReadStream(traceZipPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    const failureContext: TraceFailureContext = {};

    // 1. Extract error details from trace.trace
    const traceEventsPath = path.join(extractDir, 'trace.trace');
    if (fs.existsSync(traceEventsPath)) {
      const rawTrace = fs.readFileSync(traceEventsPath, 'utf-8');
      const lines = rawTrace.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'action' && event.error) {
            failureContext.actionMethod = event.method;
            failureContext.failedSelector = event.params?.selector;
            failureContext.errorMessage = event.error?.error?.message || event.error?.message;
          }
        } catch {
          // ignore non-json lines
        }
      }
    }

    // 2. Extract DOM snapshot HTML from resources directory
    const resourcesDir = path.join(extractDir, 'resources');
    if (fs.existsSync(resourcesDir)) {
      const files = fs.readdirSync(resourcesDir);
      const htmlFile = files.find((f) => f.endsWith('.html') || f.endsWith('.htm'));
      if (htmlFile) {
        // Cap length at 15k chars to keep prompt concise
        failureContext.domSnapshot = fs
          .readFileSync(path.join(resourcesDir, htmlFile), 'utf-8')
          .slice(0, 15000);
      }
    }

    return failureContext;
  } finally {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
}