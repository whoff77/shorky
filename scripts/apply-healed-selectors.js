"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const HEALED_JSON_PATH = path_1.default.join(__dirname, '../src/fixtures/healed-selectors.json');
const TESTS_DIR = path_1.default.join(__dirname, '../tests');
function applyHealedSelectors() {
    if (!fs_1.default.existsSync(HEALED_JSON_PATH)) {
        console.log('No healed selectors registry found.');
        process.exit(0);
    }
    const rawData = fs_1.default.readFileSync(HEALED_JSON_PATH, 'utf-8');
    const healedMap = JSON.parse(rawData || '{}');
    const brokenSelectors = Object.keys(healedMap);
    if (brokenSelectors.length === 0) {
        console.log('✨ No new healed selectors to apply.');
        process.exit(0);
    }
    console.log(`🔍 Found ${brokenSelectors.length} healed selector(s). Refactoring spec files...`);
    const testFiles = fs_1.default.readdirSync(TESTS_DIR).filter(f => f.endsWith('.spec.ts') || f.endsWith('.test.ts'));
    let changesMade = 0;
    for (const file of testFiles) {
        const filePath = path_1.default.join(TESTS_DIR, file);
        let content = fs_1.default.readFileSync(filePath, 'utf-8');
        let fileModified = false;
        for (const [broken, fixed] of Object.entries(healedMap)) {
            if (content.includes(broken)) {
                content = content.replaceAll(broken, fixed);
                fileModified = true;
                changesMade++;
                console.log(`  🩹 Fixed "${broken}" -> "${fixed}" in tests/${file}`);
            }
        }
        if (fileModified) {
            fs_1.default.writeFileSync(filePath, content, 'utf-8');
        }
    }
    // Always clear the JSON cache file so it stays empty on main
    fs_1.default.writeFileSync(HEALED_JSON_PATH, JSON.stringify({}, null, 2), 'utf-8');
    if (changesMade === 0) {
        console.log('ℹ️ No spec files contained matching broken selector strings.');
    }
    else {
        console.log(`✅ Refactored ${changesMade} selector(s) across spec files and cleared cache.`);
    }
}
applyHealedSelectors();
