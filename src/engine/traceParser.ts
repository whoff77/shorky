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
 */
export function extractSpecPathFromTrace(traceZipPath: string, testDir = 'tests'): string | null {
  const traceDir = path.dirname(traceZipPath);

  // 1. Prefer explicit "Location:" reference inside error-context.md
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

/**
 * Maps a raw `spec.file` value from a Playwright JSON report entry back to
 * the exact original source test file path on disk, so downstream healing
 * logic (fixTrace.ts) always overwrites the *same* file that Playwright
 * actually ran and failed — never a differently-named or unreferenced file.
 *
 * Handles both of the shapes the JSON reporter can emit:
 *  - an absolute path (resolved relative to `process.cwd()`)
 *  - an already-relative path (used as-is)
 *
 * and normalizes it so it is rooted at `testDir` (default "tests"), matching
 * how Playwright's `testDir` config option lays out spec files, without
 * double-prefixing paths that already include it.
 */
export function resolveSpecSourcePath(rawSpecFile: string | undefined, testDir = 'tests'): string {
  if (!rawSpecFile) return '';

  let relativeSpecPath = path.isAbsolute(rawSpecFile)
    ? path.relative(process.cwd(), rawSpecFile)
    : rawSpecFile;

  const normalizedTestDir = testDir.replace(/[\\/]+$/, '');
  const testDirPrefix = normalizedTestDir + path.sep;
  const testDirPrefixPosix = normalizedTestDir + '/';

  if (
    relativeSpecPath &&
    !relativeSpecPath.startsWith(testDirPrefix) &&
    !relativeSpecPath.startsWith(testDirPrefixPosix) &&
    relativeSpecPath !== normalizedTestDir
  ) {
    relativeSpecPath = path.join(normalizedTestDir, relativeSpecPath);
  }

  return relativeSpecPath || rawSpecFile;
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

    // 1. Always inspect runner's error-context.md first (populated on timeout)
    const traceDir = path.dirname(traceZipPath);
    let runnerErrorMessage: string | undefined;
    const errorContextPath = path.join(traceDir, 'error-context.md');
    
    if (fs.existsSync(errorContextPath)) {
      runnerErrorMessage = fs.readFileSync(errorContextPath, 'utf-8');
      
      const selectorMatch =
        runnerErrorMessage.match(/waiting for locator\(['"]([^'"]+)['"]\)/i) ||
        runnerErrorMessage.match(/locator\(['"]([^'"]+)['"]\)/i);
      
      if (selectorMatch) {
        failureContext.failedSelector = selectorMatch[1];
      }

      const actionMatch = runnerErrorMessage.match(/Error:\s*page\.(\w+):/i);
      if (actionMatch) {
        failureContext.actionMethod = `page.${actionMatch[1]}`;
        failureContext.failedAction = failureContext.actionMethod;
      }

      failureContext.errorMessage = runnerErrorMessage;
    }

    // 2. Extract detailed trace actions from trace.trace
    const traceEventsPath = path.join(extractDir, 'trace.trace');
    if (fs.existsSync(traceEventsPath)) {
      const rawTrace = fs.readFileSync(traceEventsPath, 'utf-8');
      const lines = rawTrace.split('\n').filter(Boolean);

      const actionMap = new Map<string, any>();
      const actionsSequence: any[] = [];
      let explicitErrorEvent: any = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          if (
            event.callId &&
            (event.type === 'action' || event.type === 'before' || event.apiName || event.method)
          ) {
            const existing = actionMap.get(event.callId) || {};
            const merged = { ...existing, ...event };
            actionMap.set(event.callId, merged);

            if (!actionsSequence.some((a) => a.callId === event.callId)) {
              actionsSequence.push(merged);
            }
          }

          if (event.error || event.errorContext) {
            explicitErrorEvent = event;
          }
        } catch {
          // ignore non-json lines
        }
      }

      let targetAction: any = null;

      if (explicitErrorEvent) {
        if (explicitErrorEvent.callId && actionMap.has(explicitErrorEvent.callId)) {
          targetAction = { ...actionMap.get(explicitErrorEvent.callId), ...explicitErrorEvent };
        } else {
          targetAction = explicitErrorEvent;
        }
      } else {
        const unfinishedAction = [...actionsSequence].reverse().find((a) => !a.endTime || a.endTime < 0);
        targetAction = unfinishedAction || (actionsSequence.length > 0 ? actionsSequence[actionsSequence.length - 1] : null);
      }

      if (targetAction) {
        const method = targetAction.method || targetAction.apiName || failureContext.actionMethod || 'unknown';
        const selector = targetAction.params?.selector || targetAction.selector || failureContext.failedSelector;
        const msg =
          targetAction.error?.error?.message ||
          targetAction.error?.message ||
          targetAction.errorContext?.error?.message ||
          failureContext.errorMessage ||
          `Timeout executing action: ${method}`;

        failureContext.actionMethod = method;
        failureContext.failedAction = method;
        failureContext.failedSelector = selector;
        failureContext.errorMessage = msg;
      }
    }

    // 3. Extract DOM snapshot HTML from resources directory
    const resourcesDir = path.join(extractDir, 'resources');
    if (fs.existsSync(resourcesDir)) {
      const files = fs.readdirSync(resourcesDir);
      const htmlFile = files.find((f) => f.endsWith('.html') || f.endsWith('.htm'));
      if (htmlFile) {
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