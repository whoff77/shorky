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
exports.expect = exports.test = void 0;
const test_1 = require("@playwright/test");
Object.defineProperty(exports, "expect", { enumerable: true, get: function () { return test_1.expect; } });
const healingEngine_1 = require("../utils/healingEngine");
const visual_diff_1 = require("../utils/visual-diff");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
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
    autoHealPage: async ({ page }, use) => {
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
    },
});
