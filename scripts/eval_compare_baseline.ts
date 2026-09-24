#!/usr/bin/env tsx
/**
 * Baseline Regression Comparison CLI (Spec L6.4, L6.5, L12)
 *
 * Compares current evaluation report aggregates against baseline report.
 * Regression Thresholds:
 * - citation_precision drop > 2pp (0.02) -> FAIL
 * - hallucinated_citations_count increase -> FAIL
 * - guard_ood_recall drop > 1pp (0.01) -> FAIL
 *
 * On failure: logs ai.alert.quality_drop via llmopsLogger and exits with code 1.
 * With --update-baseline: copies current report to baseline and exits with code 0.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compareBaseline,
  type EvalAggregates,
  type BaselineComparisonResult,
  type BaselineRegressionFailure,
} from '../lib/llmops/eval/gates';
import { llmopsLogger } from '../lib/llmops/logging/logger';
import { LLMOPS_EVENTS } from '../lib/llmops/logging/events';

export interface CompareBaselineOptions {
  reportPath?: string;
  baselinePath?: string;
  updateBaseline?: boolean;
  silent?: boolean;
}

export interface CompareBaselineExecutionResult {
  passed: boolean;
  updated?: boolean;
  failed_metrics: BaselineRegressionFailure[];
  reportPath: string;
  baselinePath: string;
}

/**
 * Finds the latest evaluation report JSON file in the target directory.
 */
export function findLatestReport(reportsDir: string): string | null {
  if (!fs.existsSync(reportsDir)) {
    return null;
  }

  const hasAggregates = (filePath: string): boolean => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const json = JSON.parse(raw);
      return Boolean(json && typeof json === 'object' && json.aggregates);
    } catch {
      return false;
    }
  };

  const latestPointer = path.join(reportsDir, 'latest.json');
  if (fs.existsSync(latestPointer) && hasAggregates(latestPointer)) {
    return latestPointer;
  }

  const files = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('baseline-') && f !== 'runs.jsonl');

  if (files.length === 0) {
    return null;
  }

  // Sort descending by name (timestamp format ensures chronological sorting)
  files.sort().reverse();
  for (const file of files) {
    const candidate = path.join(reportsDir, file);
    if (hasAggregates(candidate)) {
      return candidate;
    }
  }

  return null;
}
/**
 * Executes baseline comparison and emits ai.alert.quality_drop if regression is detected.
 */
export function runBaselineComparison(
  options: CompareBaselineOptions = {}
): CompareBaselineExecutionResult {
  const reportsDir = path.resolve(process.cwd(), 'evaluation/reports');
  const reportPath =
    options.reportPath || findLatestReport(reportsDir);

  if (!reportPath || !fs.existsSync(reportPath)) {
    throw new Error(
      `Evaluation report not found at ${reportPath || 'evaluation/reports'}. Run an evaluation suite first.`
    );
  }

  const baselinePath =
    options.baselinePath || path.join(reportsDir, 'baseline-smoke.json');

  // Handle --update-baseline
  if (options.updateBaseline) {
    const rawReport = fs.readFileSync(reportPath, 'utf-8');
    fs.writeFileSync(baselinePath, rawReport, 'utf-8');
    if (!options.silent) {
      console.log(`[Baseline Update] Copied report ${reportPath} -> ${baselinePath}`);
    }
    return {
      passed: true,
      updated: true,
      failed_metrics: [],
      reportPath,
      baselinePath,
    };
  }

  if (!fs.existsSync(baselinePath)) {
    throw new Error(
      `Baseline report not found at ${baselinePath}. Run with --update-baseline to establish initial baseline.`
    );
  }

  const currentReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
    aggregates: EvalAggregates;
  };
  const baselineReport = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as {
    aggregates: EvalAggregates;
  };

  if (!currentReport.aggregates) {
    throw new Error(`Report at ${reportPath} is missing aggregates object`);
  }
  if (!baselineReport.aggregates) {
    throw new Error(`Baseline report at ${baselinePath} is missing aggregates object`);
  }

  const comparison: BaselineComparisonResult = compareBaseline(
    currentReport,
    baselineReport
  );

  if (!comparison.passed) {
    // Spec L3.3 & L6.5: Log ai.alert.quality_drop for each detected regression
    for (const failure of comparison.failed_metrics) {
      llmopsLogger.error(LLMOPS_EVENTS.ALERT_QUALITY_DROP, {
        metric: failure.metric,
        baseline: failure.baseline,
        current: failure.current,
        reason: failure.reason,
        msg: `Quality drop detected on metric '${failure.metric}': current ${failure.current} vs baseline ${failure.baseline}`,
      });
    }

    if (!options.silent) {
      console.error('\n================ ⚠️ QUALITY DROP REGRESSION DETECTED ===============');
      console.error(`Report:   ${reportPath}`);
      console.error(`Baseline: ${baselinePath}`);
      console.error('\nFailed Regression Thresholds:');
      for (const f of comparison.failed_metrics) {
        console.error(`  - [${f.metric}] ${f.reason}`);
      }
      console.error('=====================================================================\n');
    }

    return {
      passed: false,
      failed_metrics: comparison.failed_metrics,
      reportPath,
      baselinePath,
    };
  }

  if (!options.silent) {
    console.log('\n================ ✅ BASELINE COMPARISON PASSED ================');
    console.log(`Report:   ${reportPath}`);
    console.log(`Baseline: ${baselinePath}`);
    console.log('All regression metrics (citation_precision, hallucination, OOD recall) within tolerances.');
    console.log('===============================================================\n');
  }

  return {
    passed: true,
    failed_metrics: [],
    reportPath,
    baselinePath,
  };
}

// CLI execution handling
const isCli =
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith('eval_compare_baseline.ts') ||
    process.argv[1].endsWith('eval_compare_baseline.js') ||
    process.argv[1].includes('eval_compare_baseline'));

if (isCli) {
  const args = process.argv.slice(2);

  const reportIdx = args.indexOf('--report');
  const reportPath = reportIdx !== -1 && args[reportIdx + 1] ? args[reportIdx + 1] : undefined;

  const baselineIdx = args.indexOf('--baseline');
  const baselinePath = baselineIdx !== -1 && args[baselineIdx + 1] ? args[baselineIdx + 1] : undefined;

  const updateBaseline = args.includes('--update-baseline');
  const silent = args.includes('--silent');

  try {
    const result = runBaselineComparison({
      reportPath,
      baselinePath,
      updateBaseline,
      silent,
    });

    if (!result.passed) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('Baseline comparison error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
