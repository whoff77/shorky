"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// scripts/test-fixer.ts
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const path_1 = __importDefault(require("path"));
const traceParser_1 = require("../src/engine/traceParser");
const codeFixer_1 = require("../src/engine/codeFixer");
const fs_1 = __importDefault(require("fs"));
async function main() {
    const specPath = path_1.default.join(__dirname, '../tests/broken-login.spec.ts');
    const tracePath = (0, traceParser_1.findLatestTraceZip)();
    if (!tracePath) {
        console.error('❌ Could not locate any trace.zip in test-results directory.');
        process.exit(1);
    }
    console.log(`🔍 Found trace artifact at: ${tracePath}`);
    console.log('📦 Parsing trace events and DOM snapshot...');
    const failureContext = await (0, traceParser_1.parsePlaywrightTrace)(tracePath);
    const specCode = fs_1.default.readFileSync(specPath, 'utf-8');
    console.log('🤖 Sending DOM state and failure trace to LLM...');
    const fix = await (0, codeFixer_1.generateSpecFix)(specCode, failureContext);
    fs_1.default.writeFileSync(specPath, fix.fixedCode, 'utf-8');
    console.log('\n✅ Fix Generated with DOM Context!');
    console.log(`📝 Explanation: ${fix.explanation}\n`);
    console.log('--- Updated Spec ---');
    console.log(fix.fixedCode);
}
main().catch(console.error);
