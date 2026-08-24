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
    const cloudUrl = process.env.SHORKY_CLOUD_URL || 'http://localhost:3000/api/v1/telemetry';
    const isCloudEnabled = process.env.ENABLE_SHORKY_CLOUD === 'true' || process.env.SHORKY_CLOUD_URL;

    // Skip attempting transmission entirely if cloud is explicitly disabled
    if (!isCloudEnabled && !process.env.SHORKY_CLOUD_URL) {
      console.log('ℹ️ [Shorky Cloud] Telemetry transmission skipped (SHORKY_CLOUD_URL not configured).');
      return;
    }

    try {
      console.log(`📤 [Shorky Cloud] Transmitting run artifacts to ${cloudUrl}...`);
      
      const response = await fetch(cloudUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ /* payload */ }),
        // Set a short timeout so offline runs don't hang execution
        signal: AbortSignal.timeout(3000), 
      });

      if (!response.ok) {
        console.warn(`⚠️ [Shorky Cloud] Backend responded with status: ${response.status}`);
      } else {
        console.log('✅ [Shorky Cloud] Telemetry successfully transmitted.');
      }
    } catch (error: any) {
      // Gracefully log offline status without throwing an unhandled stack trace
      if (error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TimeoutError') {
        console.warn('ℹ️ [Shorky Cloud] Cloud server unavailable. Continuing offline execution.');
      } else {
        console.warn('⚠️ [Shorky Cloud] Telemetry warning:', error?.message || error);
      }
    }
  }
}