import { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';

interface ShorkyRunPayload {
  apiKey: string;
  projectName: string;
  branch: string;
  commitSha: string;
  status: string;
  durationMs: number;
  generatedSpec?: string;
  visualDiffs: Array<{ name: string; base64Image: string }>;
  traceLogs: object[];
}

export default class ShorkyCloudReporter implements Reporter {
  private apiEndpoint: string;
  private apiKey: string;
  private runData: Partial<ShorkyRunPayload>;

  constructor() {
    this.apiEndpoint = process.env.SHORKY_CLOUD_URL || 'https://api.shorky.dev/v1/runs';
    this.apiKey = process.env.SHORKY_CLOUD_API_KEY || '';
    this.runData = {
      visualDiffs: [],
      traceLogs: []
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

    // Capture visual diff artifacts if present
    const diffAttachments = result.attachments.filter(a => a.name.includes('diff') && a.path);
    for (const attachment of diffAttachments) {
      if (attachment.path && fs.existsSync(attachment.path)) {
        const imageBuffer = fs.readFileSync(attachment.path);
        this.runData.visualDiffs?.push({
          name: attachment.name,
          base64Image: imageBuffer.toString('base64')
        });
      }
    }
  }

  async onEnd(result: FullResult) {
    if (!this.apiKey) return;

    // Collect generated spec file output if generator.ts ran
    const generatedSpecPath = path.join(process.cwd(), 'tests', 'generated-login.spec.ts');
    let generatedSpecContent: string | undefined;
    if (fs.existsSync(generatedSpecPath)) {
      generatedSpecContent = fs.readFileSync(generatedSpecPath, 'utf-8');
    }

    // Enrich traceLogs with the ReAct agent's reasoning/action/self-healing trace
    // persisted by src/agent/generator.ts (tests/generated-login.trace.json).
    const generatedTracePath = path.join(process.cwd(), 'tests', 'generated-login.trace.json');
    let agentTraceLogs: object[] = [];
    if (fs.existsSync(generatedTracePath)) {
      try {
        const rawTrace = fs.readFileSync(generatedTracePath, 'utf-8');
        const parsedTrace = JSON.parse(rawTrace || '[]');
        if (Array.isArray(parsedTrace)) {
          agentTraceLogs = parsedTrace;
        }
      } catch (err) {
        console.warn('⚠️ [Shorky Cloud] Failed to parse generated-login.trace.json:', err);
      }
    }

    const payload: ShorkyRunPayload = {
      apiKey: this.apiKey,
      projectName: process.env.SHORKY_PROJECT_NAME || 'default-project',
      branch: process.env.GITHUB_REF_NAME || 'local',
      commitSha: process.env.GITHUB_SHA || 'dev',
      status: result.status,
      durationMs: result.duration,
      generatedSpec: generatedSpecContent,
      visualDiffs: this.runData.visualDiffs || [],
      traceLogs: [...(this.runData.traceLogs || []), ...agentTraceLogs]
    };


    console.log(`📤 [Shorky Cloud] Transmitting run artifacts to ${this.apiEndpoint}...`);

    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log('✅ [Shorky Cloud] Run artifacts successfully published.');
      } else {
        console.error(`⚠️ [Shorky Cloud] Failed to send report: ${response.statusText}`);
      }
    } catch (error) {
      console.error('❌ [Shorky Cloud] Connection error posting execution data:', error);
    }
  }
}