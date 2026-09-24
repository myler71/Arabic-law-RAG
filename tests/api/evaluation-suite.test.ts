import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runEvaluation } from '@/evaluation/runner';

describe('HAKMDAR Offline Evaluation Suite', () => {
  it('executes full offline evaluation suite and passes all target thresholds', async () => {
    const report = await runEvaluation();

    // 1. Scenario counts
    expect(report.total).toBeGreaterThanOrEqual(50);
    expect(report.legal_scenarios_count).toBeGreaterThanOrEqual(40);
    expect(report.ood_scenarios_count).toBeGreaterThanOrEqual(8);

    // 2. Core target metrics
    expect(report.guard_precision).toBeGreaterThanOrEqual(0.9);
    expect(report.ood_block_rate).toBe(1.0);
    expect(report.retrieval_recall_at_5).toBeGreaterThanOrEqual(0.8);

    // 3. Supporting verification metrics
    expect(report.guard_recall).toBeGreaterThanOrEqual(0.9);
    expect(report.citation_verify_rate).toBeGreaterThanOrEqual(0.9);
    expect(report.disclaimer_rate).toBeGreaterThanOrEqual(0.9);
    expect(report.domain_accuracy).toBeGreaterThanOrEqual(0.85);

    // 4. Zero failures
    expect(report.passed).toBe(true);
    expect(report.failures).toHaveLength(0);

    // 5. Output reports verified on disk
    const reportsDir = path.join(process.cwd(), 'evaluation/reports');
    const jsonReportPath = path.join(reportsDir, 'latest.json');
    const mdReportPath = path.join(reportsDir, 'latest.md');

    expect(fs.existsSync(jsonReportPath)).toBe(true);
    expect(fs.existsSync(mdReportPath)).toBe(true);

    const jsonRaw = fs.readFileSync(jsonReportPath, 'utf-8');
    const parsedJson = JSON.parse(jsonRaw) as { total: number; passed: boolean };
    expect(parsedJson.total).toBe(report.total);
    expect(parsedJson.passed).toBe(true);

    const mdContent = fs.readFileSync(mdReportPath, 'utf-8');
    expect(mdContent).toContain('HAKMDAR Egyptian Legal AI — Offline Evaluation Report');
    expect(mdContent).toContain('PASSED ALL THRESHOLDS');
  }, 30000);
});
