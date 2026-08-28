"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class ShorkyCloudReporter {
    apiEndpoint;
    apiKey;
    testItems = [];
    runData;
    constructor() {
        this.apiEndpoint = process.env.SHORKY_CLOUD_URL || 'http://localhost:3000/api/v1/telemetry';
        this.apiKey = process.env.SHORKY_CLOUD_API_KEY || '';
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
        this.testItems.push({
            title: test.title,
            status: testStatus,
        });
    }
    async onEnd(result) {
        const cloudUrl = process.env.SHORKY_CLOUD_URL || 'http://localhost:3000/api/v1/telemetry';
        const isCloudEnabled = process.env.ENABLE_SHORKY_CLOUD === 'true' || process.env.SHORKY_CLOUD_URL;
        // Skip attempting transmission entirely if cloud is explicitly disabled
        if (!isCloudEnabled && !process.env.SHORKY_CLOUD_URL) {
            console.log('ℹ️ [Shorky Cloud] Telemetry transmission skipped (SHORKY_CLOUD_URL not configured).');
            return;
        }
        try {
            console.log(`📤 [Shorky Cloud] Transmitting run artifacts to ${cloudUrl}...`);
            const passedCount = this.runData.passed;
            const failedCount = this.runData.failed;
            const durationMs = Math.round(result.duration ?? 0);
            // Construct the flattened payload matching shorky-cloud's Zod schema
            const telemetryPayload = {
                projectName: process.env.SHORKY_PROJECT_NAME || 'shorky',
                status: failedCount > 0 ? 'failed' : 'passed',
                passedCount,
                failedCount,
                durationMs,
                tests: this.testItems.map((item) => ({
                    testName: item.title,
                    status: item.status,
                    traceLogs: [],
                    selfHealingCount: 0,
                })),
            };
            const response = await fetch(cloudUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-shorky-api-key': process.env.SHORKY_CLOUD_API_KEY || '',
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
