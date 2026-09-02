"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findLatestTraceZip = findLatestTraceZip;
exports.extractSpecPathFromTrace = extractSpecPathFromTrace;
exports.isVisualRegressionFailure = isVisualRegressionFailure;
exports.resolveSpecSourcePath = resolveSpecSourcePath;
exports.parsePlaywrightTrace = parsePlaywrightTrace;
// src/engine/traceParser.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const unzipper_1 = __importDefault(require("unzipper"));
/**
 * Recursively locates the newest trace.zip file in test-results if no explicit path is given
 */
function findLatestTraceZip(baseDir = 'test-results') {
    if (!fs_1.default.existsSync(baseDir))
        return null;
    const zipFiles = [];
    function collectZips(currentDir) {
        const entries = fs_1.default.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path_1.default.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                collectZips(fullPath);
            }
            else if (entry.isFile() && entry.name.endsWith('.zip')) {
                const stat = fs_1.default.statSync(fullPath);
                zipFiles.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
            }
        }
    }
    collectZips(baseDir);
    if (zipFiles.length === 0)
        return null;
    // Sort by newest modified time
    zipFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return zipFiles[0].filePath;
}
/**
 * Attempts to determine the failing spec file path associated with a given
 * trace.zip artifact.
 */
function extractSpecPathFromTrace(traceZipPath, testDir = 'tests') {
    const traceDir = path_1.default.dirname(traceZipPath);
    // 1. Prefer explicit "Location:" reference inside error-context.md
    const errorContextPath = path_1.default.join(traceDir, 'error-context.md');
    if (fs_1.default.existsSync(errorContextPath)) {
        const contents = fs_1.default.readFileSync(errorContextPath, 'utf-8');
        const match = contents.match(/Location:\s*([^\s:]+):\d+:\d+/);
        if (match) {
            return match[1];
        }
    }
    // 2. Fall back to matching the trace folder name against known spec files
    if (fs_1.default.existsSync(testDir)) {
        const folderName = path_1.default.basename(traceDir);
        const specFiles = fs_1.default
            .readdirSync(testDir)
            .filter((f) => f.endsWith('.spec.ts') || f.endsWith('.test.ts'));
        const slugify = (value) => value.replace(/\.(spec|test)\.ts$/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
        const normalizedFolder = folderName.toLowerCase();
        const bestMatch = specFiles.find((file) => normalizedFolder.startsWith(slugify(file)));
        if (bestMatch) {
            return path_1.default.join(testDir, bestMatch);
        }
    }
    return null;
}
/**
 * Returns true when the provided error message indicates a Playwright
 * visual regression / screenshot comparison failure (e.g. a
 * `toHaveScreenshot`/`toMatchSnapshot` pixel-diff mismatch) rather than a
 * DOM interaction, selector, or navigation failure.
 *
 * This is used to route visual failures into "Visual Diff Handoff" mode
 * instead of attempting invalid, code-level LLM repairs (adjusting
 * selectors/actions can never fix a genuine pixel discrepancy, and doing so
 * previously caused a re-fail -> re-heal infinite loop).
 */
function isVisualRegressionFailure(errorMessage) {
    if (!errorMessage)
        return false;
    return /toHaveScreenshot|toMatchSnapshot|maxDiffPixelRatio|maxDiffPixels|pixelmatch|screenshot comparison failed|pixels?\s*\(ratio [\d.]+ of all image pixels\) are different/i.test(errorMessage);
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
function resolveSpecSourcePath(rawSpecFile, testDir = 'tests') {
    if (!rawSpecFile)
        return '';
    let relativeSpecPath = path_1.default.isAbsolute(rawSpecFile)
        ? path_1.default.relative(process.cwd(), rawSpecFile)
        : rawSpecFile;
    const normalizedTestDir = testDir.replace(/[\\/]+$/, '');
    const testDirPrefix = normalizedTestDir + path_1.default.sep;
    const testDirPrefixPosix = normalizedTestDir + '/';
    if (relativeSpecPath &&
        !relativeSpecPath.startsWith(testDirPrefix) &&
        !relativeSpecPath.startsWith(testDirPrefixPosix) &&
        relativeSpecPath !== normalizedTestDir) {
        relativeSpecPath = path_1.default.join(normalizedTestDir, relativeSpecPath);
    }
    return relativeSpecPath || rawSpecFile;
}
async function parsePlaywrightTrace(traceZipPath) {
    const extractDir = path_1.default.join(process.cwd(), '.shorky-temp-trace');
    if (fs_1.default.existsSync(extractDir)) {
        fs_1.default.rmSync(extractDir, { recursive: true, force: true });
    }
    fs_1.default.mkdirSync(extractDir, { recursive: true });
    try {
        await fs_1.default
            .createReadStream(traceZipPath)
            .pipe(unzipper_1.default.Extract({ path: extractDir }))
            .promise();
        const failureContext = {};
        // 1. Always inspect runner's error-context.md first (populated on timeout)
        const traceDir = path_1.default.dirname(traceZipPath);
        let runnerErrorMessage;
        const errorContextPath = path_1.default.join(traceDir, 'error-context.md');
        if (fs_1.default.existsSync(errorContextPath)) {
            runnerErrorMessage = fs_1.default.readFileSync(errorContextPath, 'utf-8');
            const selectorMatch = runnerErrorMessage.match(/waiting for locator\(['"]([^'"]+)['"]\)/i) ||
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
        const traceEventsPath = path_1.default.join(extractDir, 'trace.trace');
        if (fs_1.default.existsSync(traceEventsPath)) {
            const rawTrace = fs_1.default.readFileSync(traceEventsPath, 'utf-8');
            const lines = rawTrace.split('\n').filter(Boolean);
            const actionMap = new Map();
            const actionsSequence = [];
            let explicitErrorEvent = null;
            for (const line of lines) {
                try {
                    const event = JSON.parse(line);
                    if (event.callId &&
                        (event.type === 'action' || event.type === 'before' || event.apiName || event.method)) {
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
                }
                catch {
                    // ignore non-json lines
                }
            }
            let targetAction = null;
            if (explicitErrorEvent) {
                if (explicitErrorEvent.callId && actionMap.has(explicitErrorEvent.callId)) {
                    targetAction = { ...actionMap.get(explicitErrorEvent.callId), ...explicitErrorEvent };
                }
                else {
                    targetAction = explicitErrorEvent;
                }
            }
            else {
                const unfinishedAction = [...actionsSequence].reverse().find((a) => !a.endTime || a.endTime < 0);
                targetAction = unfinishedAction || (actionsSequence.length > 0 ? actionsSequence[actionsSequence.length - 1] : null);
            }
            if (targetAction) {
                const method = targetAction.method || targetAction.apiName || failureContext.actionMethod || 'unknown';
                const selector = targetAction.params?.selector || targetAction.selector || failureContext.failedSelector;
                const msg = targetAction.error?.error?.message ||
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
        const resourcesDir = path_1.default.join(extractDir, 'resources');
        if (fs_1.default.existsSync(resourcesDir)) {
            const files = fs_1.default.readdirSync(resourcesDir);
            const htmlFile = files.find((f) => f.endsWith('.html') || f.endsWith('.htm'));
            if (htmlFile) {
                failureContext.domSnapshot = fs_1.default
                    .readFileSync(path_1.default.join(resourcesDir, htmlFile), 'utf-8')
                    .slice(0, 15000);
            }
        }
        return failureContext;
    }
    finally {
        if (fs_1.default.existsSync(extractDir)) {
            fs_1.default.rmSync(extractDir, { recursive: true, force: true });
        }
    }
}
