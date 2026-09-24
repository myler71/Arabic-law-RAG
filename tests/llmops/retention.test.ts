import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { purgeDebugPayloads, AI_RUNS_RETENTION_SQL } from '../../lib/llmops/retention';

describe('LLMOps Retention Engine (retention.ts)', () => {
  let tempDir: string;
  let llmopsDir: string;
  let reportsDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'arabic-law-rag-retention-test-'));
    llmopsDir = path.join(tempDir, '.llmops');
    reportsDir = path.join(tempDir, 'evaluation', 'reports');

    await fs.promises.mkdir(llmopsDir, { recursive: true });
    await fs.promises.mkdir(reportsDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup ignore
    }
  });

  it('exports valid SQL documentation for database retention', () => {
    expect(AI_RUNS_RETENTION_SQL).toContain('DELETE FROM public.ai_run_spans');
    expect(AI_RUNS_RETENTION_SQL).toContain('DELETE FROM public.ai_runs');
    expect(AI_RUNS_RETENTION_SQL).toContain('ai_feedback');
  });

  it('drops old debug lines and keeps non-debug lines and recent debug lines', async () => {
    const jsonlPath = path.join(llmopsDir, 'dev_runs.jsonl');

    const now = new Date('2026-09-15T12:00:00.000Z');
    const oldDate = new Date('2026-08-01T12:00:00.000Z').toISOString(); // 45 days ago
    const recentDate = new Date('2026-09-14T12:00:00.000Z').toISOString(); // 1 day ago

    const lines = [
      // 1. Old debug line -> should be purged
      JSON.stringify({
        id: 'debug-old-1',
        level: 'debug',
        ts: oldDate,
        msg: 'Old debug trace',
      }),
      // 2. Old info/run record -> should be retained (spec: runs retained 90 days)
      JSON.stringify({
        id: 'run-old-1',
        outcome: 'success',
        created_at: oldDate,
        evidence_score: 0.95,
      }),
      // 3. Recent debug line -> should be retained (within 14 days)
      JSON.stringify({
        id: 'debug-recent-1',
        level: 'debug',
        ts: recentDate,
        msg: 'Recent debug trace',
      }),
      // 4. Old debug payload via outcome -> should be purged
      JSON.stringify({
        id: 'debug-old-2',
        outcome: 'debug',
        created_at: oldDate,
      }),
      // 5. Normal recent run -> should be retained
      JSON.stringify({
        id: 'run-recent-1',
        outcome: 'disclaimer',
        created_at: recentDate,
      }),
    ];

    await fs.promises.writeFile(jsonlPath, lines.join('\n') + '\n', 'utf-8');

    // Also add a debug artifact and a protected baseline report in evaluation/reports
    const debugArtifactPath = path.join(reportsDir, 'test-run.debug.json');
    const baselinePath = path.join(reportsDir, 'baseline-smoke.json');
    const latestPath = path.join(reportsDir, 'latest.json');

    await fs.promises.writeFile(debugArtifactPath, '{"debug":true}', 'utf-8');
    await fs.promises.writeFile(baselinePath, '{"suite":"smoke"}', 'utf-8');
    await fs.promises.writeFile(latestPath, '{"latest":true}', 'utf-8');

    // Set mtime for debugArtifact to 45 days ago
    const oldTime = new Date('2026-08-01T12:00:00.000Z');
    await fs.promises.utimes(debugArtifactPath, oldTime, oldTime);

    // Run purge
    const result = await purgeDebugPayloads({
      baseDir: tempDir,
      olderThanDays: 14,
      now,
    });

    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.linesRemoved).toBe(2); // lines 1 and 4
    expect(result.linesRetained).toBe(3); // lines 2, 3, and 5
    expect(result.artifactsRemoved).toBe(1); // test-run.debug.json

    // Check file content
    const updatedContent = await fs.promises.readFile(jsonlPath, 'utf-8');
    const updatedLines = updatedContent.trim().split('\n').map((l) => JSON.parse(l));

    expect(updatedLines.map((l) => l.id)).toEqual(['run-old-1', 'debug-recent-1', 'run-recent-1']);

    // Check reports
    expect(fs.existsSync(debugArtifactPath)).toBe(false);
    expect(fs.existsSync(baselinePath)).toBe(true);
    expect(fs.existsSync(latestPath)).toBe(true);
  });

  it('respects dryRun option and does not delete or modify files', async () => {
    const jsonlPath = path.join(llmopsDir, 'dev_runs.jsonl');
    const oldDate = new Date('2026-08-01T12:00:00.000Z').toISOString();

    const initialContent = JSON.stringify({
      id: 'debug-old',
      level: 'debug',
      ts: oldDate,
    }) + '\n';

    await fs.promises.writeFile(jsonlPath, initialContent, 'utf-8');

    const result = await purgeDebugPayloads({
      baseDir: tempDir,
      olderThanDays: 14,
      dryRun: true,
      now: new Date('2026-09-15T12:00:00.000Z'),
    });

    expect(result.dryRun).toBe(true);
    expect(result.linesRemoved).toBe(1);

    // File content remains unmodified
    const afterContent = await fs.promises.readFile(jsonlPath, 'utf-8');
    expect(afterContent).toBe(initialContent);
  });
});
