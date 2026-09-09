"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.expect = exports.test = exports.SHORKY_TOKENS_ATTACHMENT_NAME = void 0;
const test_1 = require("@playwright/test");
Object.defineProperty(exports, "expect", { enumerable: true, get: function () { return test_1.expect; } });
const healingEngine_1 = require("../utils/healingEngine");
const visual_diff_1 = require("../utils/visual-diff");
const tokenUsage_1 = require("../utils/tokenUsage");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Attachment name used to bridge LLM token usage from the worker process
 * (where fixtures/test bodies run and OpenAI calls actually happen — see
 * `healingEngine.ts`'s `recordTokenUsage()`) to the main process reporter
 * (`cloudReporter.ts`, which runs in a separate process and has no direct
 * access to worker-local state). `cloudReporter.ts`'s `onTestEnd()` looks
 * for an attachment with this exact name.
 */
exports.SHORKY_TOKENS_ATTACHMENT_NAME = 'shorky-tokens-used';
const REGISTRY_PATH = path.join(__dirname, 'healed-selectors.json');
function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            const data = fs.readFileSync(REGISTRY_PATH, 'utf-8');
            return JSON.parse(data || '{}');
        }
    }
    catch (err) {
        console.error('⚠️ [Shorky] Failed to read healed-selectors.json', err);
    }
    return {};
}
function saveRegistry(registry) {
    try {
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
    }
    catch (err) {
        console.error('⚠️ [Shorky] Failed to save healed-selectors.json', err);
    }
}
exports.test = test_1.test.extend({
    autoHealPage: async ({ page }, use, testInfo) => {
        // Reset the per-test token counter at fixture setup so tokens consumed
        // by a *previous* test sharing this worker process never bleed into
        // the current test's reported usage (see tokenUsage.ts).
        (0, tokenUsage_1.resetTokensUsedThisTest)();
        const clickAndHeal = async (selector) => {
            const registry = loadRegistry();
            const activeSelector = registry[selector] || selector;
            if (registry[selector]) {
                console.log(`⚡ [Shorky Cache] Using pre-healed selector: "${selector}" -> "${registry[selector]}"`);
            }
            try {
                await page.click(activeSelector, { timeout: 3000 });
            }
            catch (error) {
                console.warn(`⚠️ [Shorky Interceptor] Selector failed: "${selector}". Initiating self-healing...`);
                const healedSelector = await (0, healingEngine_1.healSelector)(page, selector);
                console.log(`✨ [Shorky Healed] Replaced "${selector}" -> "${healedSelector}"`);
                registry[selector] = healedSelector;
                saveRegistry(registry);
                await page.click(healedSelector);
            }
        };
        const runVisualCheck = async (expectation) => {
            console.log(`👁️ [Shorky Vision] Auditing visual layout: "${expectation}"...`);
            const result = await (0, healingEngine_1.assertVisual)(page, expectation);
            if (!result.passed) {
                console.error(`❌ [Shorky Vision Failed] ${result.reason}`);
                throw new Error(`Visual assertion failed: ${result.reason}`);
            }
            else {
                console.log(`✅ [Shorky Vision Passed] ${result.reason}`);
            }
        };
        const runVisualBaseline = async (snapshotName, options) => {
            await (0, visual_diff_1.assertVisualBaseline)(page, snapshotName, options ?? {});
        };
        await use({
            page,
            clickAndHeal,
            assertVisual: runVisualCheck,
            assertVisualBaseline: runVisualBaseline,
        });
        // Fixture teardown (runs after the test body completes, but while
        // `testInfo` is still attachable): snapshot the tokens consumed by any
        // self-healing/vision calls made during this test and attach them to
        // the test result so `cloudReporter.ts` (running in the main process)
        // can read them back out in `onTestEnd()`.
        const tokensUsed = (0, tokenUsage_1.getTokensUsedThisTest)();
        if (tokensUsed > 0) {
            await testInfo.attach(exports.SHORKY_TOKENS_ATTACHMENT_NAME, {
                body: String(tokensUsed),
                contentType: 'text/plain',
            });
        }
    },
});
