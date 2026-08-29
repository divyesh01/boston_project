/**
 * SessionArtifactStore
 * --------------------
 * Persists comprehensive run artifacts under .agent-runs/<session-id>/ for complete observability.
 * Structure:
 * .agent-runs/<session-id>/
 *   ├── manifest.json
 *   ├── prompts/
 *   ├── responses/
 *   ├── receipts/
 *   ├── patches/
 *   ├── tests/
 *   ├── logs/
 *   └── final-report.json
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { redactSecrets } from '../policies/SecretRedactor.js';

export class SessionArtifactStore {
  constructor(sessionId, rootDir = process.cwd()) {
    this.sessionId = sessionId || `run-${Date.now()}`;
    this.sessionDir = path.resolve(rootDir, '.agent-runs', this.sessionId);
    this._ensureDirectories();
  }

  _ensureDirectories() {
    const subdirs = ['prompts', 'responses', 'receipts', 'patches', 'tests', 'logs'];
    for (const dir of subdirs) {
      const fullPath = path.join(this.sessionDir, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }
  }

  savePrompt(name, content) {
    const filePath = path.join(this.sessionDir, 'prompts', `${name}.txt`);
    fs.writeFileSync(filePath, redactSecrets(String(content || '')), 'utf8');
    return filePath;
  }

  saveResponse(name, data) {
    const filePath = path.join(this.sessionDir, 'responses', `${name}.json`);
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, redactSecrets(content), 'utf8');
    return filePath;
  }

  saveReceipts(receiptsText) {
    const filePath = path.join(this.sessionDir, 'receipts', 'agent_receipts.txt');
    fs.writeFileSync(filePath, redactSecrets(receiptsText), 'utf8');
    return filePath;
  }

  savePatch(patchId, patchText, meta = {}) {
    const filePath = path.join(this.sessionDir, 'patches', `${patchId}.diff`);
    fs.writeFileSync(filePath, patchText, 'utf8');
    const metaPath = path.join(this.sessionDir, 'patches', `${patchId}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return { filePath, metaPath };
  }

  saveTestResult(name, output, passed) {
    const filePath = path.join(this.sessionDir, 'tests', `${name}.log`);
    const data = `STATUS: ${passed ? 'PASSED' : 'FAILED'}\n\n${output}`;
    fs.writeFileSync(filePath, redactSecrets(data), 'utf8');
    return filePath;
  }

  saveLog(name, logText) {
    const filePath = path.join(this.sessionDir, 'logs', `${name}.log`);
    fs.writeFileSync(filePath, redactSecrets(logText), 'utf8');
    return filePath;
  }

  saveFinalReport(report) {
    const filePath = path.join(this.sessionDir, 'final-report.json');
    fs.writeFileSync(filePath, redactSecrets(JSON.stringify(report, null, 2)), 'utf8');
    return filePath;
  }

  saveManifest(manifest) {
    const filePath = path.join(this.sessionDir, 'manifest.json');
    fs.writeFileSync(filePath, redactSecrets(JSON.stringify(manifest, null, 2)), 'utf8');
    return filePath;
  }
}
