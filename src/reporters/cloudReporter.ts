import { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';

interface TestRunItem {
  title: string;
  status: 'passed' | 'failed' | 'healed';
}

export default class ShorkyCloudReporter implements Reporter {
  private apiEndpoint: string;
  private apiKey: string;
  private testItems: TestRunItem[] = [];
  private runData: {
    passed: number;
    failed: number;
  };

  constructor() {
    this.apiEndpoint = process.env.SHORKY_CLOUD_URL || 'http://localhost:3000/api/v1/telemetry';
    this.apiKey = process.env.SHORKY_CLOUD_API_KEY || '';
    this.runData = {
      passed: 0,
      failed: 0,
    };
  }

  onBegin(config: FullConfig, suite: Suite) {
    if (!this.apiKey) {
      console.log('ℹ️ [Shorky] SHORKY_CLOUD_API_KEY not found. Skipping cloud reporting.');
      return;
    }
    console.log('🚀 [Shorky] Initializing Shorky Cloud reporting run...');
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.apiKey) return;

    let testStatus: 'passed' | 'failed' | 'healed' = 'passed';

    if (result.status === 'passed') {
      this.runData.passed++;
      testStatus = 'passed';
    } else if (result.status === 'failed' || result.status === 'timedOut') {
      this.runData.failed++;
      testStatus = 'failed';
    }

    this.testItems.push({
      title: test.title,
      status: testStatus,
    });
  }

  async onEnd(result: FullResult) {
    if (!this.apiKey) return;

    // Load agent trace logs if generated
    const generatedTracePath = path.join(process.cwd(), 'tests', 'generated-login.trace.json');
    let agentTraceLogs: any[] = [];
    if (fs.existsSync(generatedTracePath)) {
      try {
        const rawTrace = fs.readFileSync(generatedTracePath, 'utf-8');
        const parsedTrace = JSON.parse(rawTrace || '[]');
        if (Array.isArray(parsedTrace)) {
          // Format entries to satisfy agentTraceEntrySchema if necessary
          agentTraceLogs = parsedTrace.map((entry: any, index: number) => ({
            step: typeof entry.step === 'number' ? entry.step : index + 1,
            action: entry.action || entry.type || 'agent_step',
            status: entry.status === 'healed' ? 'healed' : entry.status === 'failed' ? 'failed' : 'success',
            timestamp: entry.timestamp || new Date().toISOString(),
            selector: entry.selector,
            message: entry.message || entry.thought,
            healedFrom: entry.healedFrom,
            healedTo: entry.healedTo,
            durationMs: typeof entry.durationMs === 'number' ? Math.round(entry.durationMs) : undefined,
          }));
        }
      } catch (err) {
        console.warn('⚠️ [Shorky Cloud] Failed to parse generated-login.trace.json:', err);
      }
    }

    const payload = {
      projectName: process.env.SHORKY_PROJECT_NAME || 'Default Local Project',
      status: result.status === 'passed' ? 'passed' : 'failed',
      passedCount: this.runData.passed,
      failedCount: this.runData.failed,
      durationMs: Math.round(result.duration),
      tests: this.testItems.map((t) => ({
        testName: t.title,
        status: t.status,
        traceLogs: agentTraceLogs,
        selfHealingCount: agentTraceLogs.filter((log) => log.status === 'healed').length,
      })),
    };

    console.log(`📤 [Shorky Cloud] Transmitting run artifacts to ${this.apiEndpoint}...`);

    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-shorky-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const resData = await response.json();
        console.log(`✅ [Shorky Cloud] Run artifacts successfully published! (Run ID: ${resData.runId})`);
      } else {
        const errText = await response.text().catch(() => '');
        console.error(`⚠️ [Shorky Cloud] Failed to send report (${response.status}): ${response.statusText} ${errText}`);
      }
    } catch (error) {
      console.error('❌ [Shorky Cloud] Connection error posting execution data:', error);
    }
  }
}