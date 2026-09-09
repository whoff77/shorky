"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const shorkyCloud_1 = require("../config/shorkyCloud");
const autoHealFixture_1 = require("../fixtures/autoHealFixture");
/**
 * Extracts the LLM token count `autoHealFixture.ts` attached to this test
 * result (see `SHORKY_TOKENS_ATTACHMENT_NAME`), if any. Attachments cross
 * the worker-process -> main-process boundary as plain buffers/strings, so
 * this parses the attachment body back into a number, defensively falling
 * back to 0 for any malformed/missing attachment rather than throwing.
 */
function extractTokensUsed(result) {
    const attachment = result.attachments.find((a) => a.name === autoHealFixture_1.SHORKY_TOKENS_ATTACHMENT_NAME);
    if (!attachment)
        return 0;
    const raw = attachment.body ? attachment.body.toString('utf-8') : undefined;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
class ShorkyCloudReporter {
    apiEndpoint;
    apiKey;
    testItems = [];
    runData;
    constructor() {
        this.apiEndpoint = (0, shorkyCloud_1.getShorkyCloudTelemetryUrl)();
        this.apiKey = (0, shorkyCloud_1.getShorkyCloudApiKey)();
        this.runData = {
            passed: 0,
            failed: 0,
        };
    }
    onBegin(config, suite) {
        if (!this.apiKey) {
            console.log('ℹ️ [Shorky] SHORKY_CLOUD_API_KEY not found. Skipping cloud reporting.');
            return;
        }
        console.log('🚀 [Shorky] Initializing Shorky Cloud reporting run...');
    }
    onTestEnd(test, result) {
        if (!this.apiKey)
            return;
        let testStatus = 'passed';
        if (result.status === 'passed') {
            this.runData.passed++;
            testStatus = 'passed';
        }
        else if (result.status === 'failed' || result.status === 'timedOut') {
            this.runData.failed++;
            testStatus = 'failed';
        }
        const errorMessage = result.error?.message || result.error?.stack;
        const tokensUsed = extractTokensUsed(result);
        this.testItems.push({
            title: test.title,
            status: testStatus,
            error: errorMessage,
            tokensUsed,
        });
    }
    async onEnd(result) {
        const cloudUrl = (0, shorkyCloud_1.getShorkyCloudTelemetryUrl)();
        // Skip attempting transmission entirely if cloud is explicitly disabled
        if (!(0, shorkyCloud_1.isShorkyCloudEnabled)()) {
            console.log('ℹ️ [Shorky Cloud] Telemetry transmission skipped (SHORKY_CLOUD_URL not configured).');
            return;
        }
        try {
            console.log(`📤 [Shorky Cloud] Transmitting run artifacts to ${cloudUrl}...`);
            const passedCount = this.runData.passed;
            const failedCount = this.runData.failed;
            const durationMs = Math.round(result.duration ?? 0);
            // Sum of every test's tokensUsed (captured from OpenAI response.usage
            // during self-healing/vision calls — see tokenUsage.ts and
            // autoHealFixture.ts). Reported both per-test and as a run-level
            // total below; shorky-cloud's /api/v1/telemetry uses the run-level
            // total when present, atomically incrementing that project's
            // tokensUsedThisMonth for the /api/v1/preflight budget guard.
            const totalTokensUsed = this.testItems.reduce((sum, item) => sum + item.tokensUsed, 0);
            // Construct the flattened payload matching shorky-cloud's Zod schema
            const telemetryPayload = {
                projectName: process.env.SHORKY_PROJECT_NAME || 'shorky',
                status: failedCount > 0 ? 'failed' : 'passed',
                passedCount,
                failedCount,
                durationMs,
                tokensUsed: totalTokensUsed,
                tests: this.testItems.map((item) => ({
                    testName: item.title,
                    status: item.status,
                    traceLogs: item.error
                        ? [{
                                step: 1,
                                action: 'test_execution',
                                status: item.status === 'failed' ? 'failed' : 'success',
                                timestamp: new Date().toISOString(),
                                message: item.error,
                            }]
                        : [],
                    selfHealingCount: item.status === 'healed' ? 1 : 0,
                    tokensUsed: item.tokensUsed,
                }))
            };
            const response = await fetch(cloudUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-shorky-api-key': (0, shorkyCloud_1.getShorkyCloudApiKey)(),
                },
                body: JSON.stringify(telemetryPayload),
                // Set a short timeout so offline runs don't hang execution
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('⚠️ [Shorky Cloud] Backend responded with status:', response.status, JSON.stringify(errorData, null, 2));
            }
            else {
                console.log('✅ [Shorky Cloud] Telemetry successfully transmitted.');
            }
        }
        catch (error) {
            // Gracefully log offline status without throwing an unhandled stack trace
            if (error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TimeoutError') {
                console.warn('ℹ️ [Shorky Cloud] Cloud server unavailable. Continuing offline execution.');
            }
            else {
                console.warn('⚠️ [Shorky Cloud] Telemetry warning:', error?.message || error);
            }
        }
    }
}
exports.default = ShorkyCloudReporter;
