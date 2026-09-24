import { judgeRun, type JudgeInputChunk } from './judge';

export interface EvalAggregates {
  total_cases: number;
  legal_cases_count: number;
  ood_cases_count: number;
  guard_precision: number;
  guard_recall: number;
  guard_ood_recall: number;
  ood_refuse_rate: number;
  emotional_legal_false_reject_count: number;
  retrieval_recall_at_5: number;
  citation_precision: number;
  hallucinated_citations_count: number;
  disclaimer_rate?: number;
  disclaimer_correctness?: number;
  pipeline_hard_errors_count: number;
  ttft_p50: number;
  ttft_p95?: number;
  cost_per_case_avg?: number;
  faithfulness_avg?: number;
  completeness_avg?: number;
  hitl_cases_count?: number;
  hitl_interrupted_count?: number;
  hitl_interrupt_rate?: number;
}

export type GateProfile = 'smoke' | 'full' | 'pre_judge' | 'case_deep';

export interface GateFailure {
  metric: string;
  actual: number | string;
  expected: string;
  reason: string;
}

export interface GateEvaluationResult {
  passed: boolean;
  gate_profile: GateProfile;
  warnings: string[];
  failed_metrics: GateFailure[];
  waivers?: string[];
}

export interface BaselineRegressionFailure {
  metric: string;
  current: number;
  baseline: number;
  reason: string;
}

export interface BaselineComparisonResult {
  passed: boolean;
  failed_metrics: BaselineRegressionFailure[];
}

export interface GateThresholds {
  min_ood_refuse_rate: number;
  max_emotional_legal_false_rejects: number;
  min_citation_precision: number;
  max_hallucinated_citations: number;
  max_pipeline_hard_errors: number;
  max_ttft_p50_ms: number;
  warn_ttft_p50_ms: number;
  min_retrieval_recall_at_5?: number;
  min_guard_ood_recall?: number;
  min_guard_precision?: number;
  min_disclaimer_correctness?: number;
  min_faithfulness_avg?: number;
  max_cost_per_case_avg?: number;
  min_hitl_interrupt_rate?: number;
}

export const GATE_DEFAULTS: Record<GateProfile, GateThresholds> = {
  smoke: {
    min_ood_refuse_rate: 1.0, // 100% OOD refused
    max_emotional_legal_false_rejects: 0, // 0 on smoke set
    min_citation_precision: 0.98, // >= 0.98
    max_hallucinated_citations: 0, // 0
    max_pipeline_hard_errors: 0, // 0
    warn_ttft_p50_ms: 800, // warn if > 800ms
    max_ttft_p50_ms: 3000, // fail if > 3000ms
  },
  pre_judge: {
    min_ood_refuse_rate: 1.0,
    max_emotional_legal_false_rejects: 0,
    min_citation_precision: 0.98,
    max_hallucinated_citations: 0,
    max_pipeline_hard_errors: 0,
    warn_ttft_p50_ms: 800,
    max_ttft_p50_ms: 3000,
    min_retrieval_recall_at_5: 0.75,
    min_disclaimer_correctness: 0.90,
  },
  full: {
    min_ood_refuse_rate: 0.95,
    max_emotional_legal_false_rejects: 0,
    min_citation_precision: 0.98,
    max_hallucinated_citations: 0,
    max_pipeline_hard_errors: 0,
    warn_ttft_p50_ms: 800,
    max_ttft_p50_ms: 3000,
    min_retrieval_recall_at_5: 0.85, // >= 0.85
    min_guard_ood_recall: 0.95, // >= 0.95
    min_guard_precision: 0.95, // >= 0.95
    min_disclaimer_correctness: 0.95, // >= 0.95
    min_faithfulness_avg: 0.80, // >= 0.80
    max_cost_per_case_avg: 0.05,
  },
  case_deep: {
    min_ood_refuse_rate: 1.0,
    max_emotional_legal_false_rejects: 0,
    min_citation_precision: 0.98,
    max_hallucinated_citations: 0,
    max_pipeline_hard_errors: 0,
    warn_ttft_p50_ms: 3000,
    max_ttft_p50_ms: 10000,
    min_hitl_interrupt_rate: 1.0,
  },
};

/**
 * Evaluates aggregates against quality gates for the specified profile.
 */
export function evaluateGates(
  aggregates: EvalAggregates,
  profile: GateProfile = 'smoke',
  customThresholds?: Partial<GateThresholds>
): GateEvaluationResult {
  const base = GATE_DEFAULTS[profile] || GATE_DEFAULTS.smoke;
  const thresholds: GateThresholds = { ...base, ...customThresholds };

  const failed_metrics: GateFailure[] = [];
  const warnings: string[] = [];

  // 1. OOD refuse rate
  if (aggregates.ood_cases_count > 0 && aggregates.ood_refuse_rate < thresholds.min_ood_refuse_rate) {
    failed_metrics.push({
      metric: 'ood_refuse_rate',
      actual: aggregates.ood_refuse_rate,
      expected: `>= ${thresholds.min_ood_refuse_rate}`,
      reason: `Out-of-domain refusal rate ${(aggregates.ood_refuse_rate * 100).toFixed(1)}% is below requirement ${(thresholds.min_ood_refuse_rate * 100).toFixed(1)}%`,
    });
  }

  // 2. Emotional legal false rejects
  if (aggregates.emotional_legal_false_reject_count > thresholds.max_emotional_legal_false_rejects) {
    failed_metrics.push({
      metric: 'emotional_legal_false_reject_count',
      actual: aggregates.emotional_legal_false_reject_count,
      expected: `<= ${thresholds.max_emotional_legal_false_rejects}`,
      reason: `Emotional legal questions falsely rejected by pre-guard: ${aggregates.emotional_legal_false_reject_count}`,
    });
  }

  // 3. Citation precision
  if (aggregates.citation_precision < thresholds.min_citation_precision) {
    failed_metrics.push({
      metric: 'citation_precision',
      actual: aggregates.citation_precision,
      expected: `>= ${thresholds.min_citation_precision}`,
      reason: `Citation precision ${aggregates.citation_precision.toFixed(3)} is below gate threshold ${thresholds.min_citation_precision}`,
    });
  }

  // 4. Hallucinated citations
  if (aggregates.hallucinated_citations_count > thresholds.max_hallucinated_citations) {
    failed_metrics.push({
      metric: 'hallucinated_citations_count',
      actual: aggregates.hallucinated_citations_count,
      expected: `<= ${thresholds.max_hallucinated_citations}`,
      reason: `Detected ${aggregates.hallucinated_citations_count} hallucinated/fabricated legal citations`,
    });
  }

  // 5. Hard errors
  if (aggregates.pipeline_hard_errors_count > thresholds.max_pipeline_hard_errors) {
    failed_metrics.push({
      metric: 'pipeline_hard_errors_count',
      actual: aggregates.pipeline_hard_errors_count,
      expected: `<= ${thresholds.max_pipeline_hard_errors}`,
      reason: `Pipeline encountered ${aggregates.pipeline_hard_errors_count} unhandled/fatal exceptions`,
    });
  }

  // 6. TTFT p50
  if (aggregates.ttft_p50 > thresholds.max_ttft_p50_ms) {
    failed_metrics.push({
      metric: 'ttft_p50',
      actual: aggregates.ttft_p50,
      expected: `<= ${thresholds.max_ttft_p50_ms}ms`,
      reason: `TTFT p50 (${aggregates.ttft_p50}ms) exceeded hard failure ceiling of ${thresholds.max_ttft_p50_ms}ms`,
    });
  } else if (aggregates.ttft_p50 > thresholds.warn_ttft_p50_ms) {
    warnings.push(
      `TTFT p50 (${aggregates.ttft_p50}ms) exceeded warning threshold of ${thresholds.warn_ttft_p50_ms}ms`
    );
  }

  // Full / Pre-judge gates
  if (thresholds.min_retrieval_recall_at_5 !== undefined && aggregates.retrieval_recall_at_5 < thresholds.min_retrieval_recall_at_5) {
    failed_metrics.push({
      metric: 'retrieval_recall_at_5',
      actual: aggregates.retrieval_recall_at_5,
      expected: `>= ${thresholds.min_retrieval_recall_at_5}`,
      reason: `Retrieval recall@5 (${aggregates.retrieval_recall_at_5.toFixed(2)}) is below ${thresholds.min_retrieval_recall_at_5}`,
    });
  }

  if (thresholds.min_guard_ood_recall !== undefined && aggregates.guard_ood_recall < thresholds.min_guard_ood_recall) {
    failed_metrics.push({
      metric: 'guard_ood_recall',
      actual: aggregates.guard_ood_recall,
      expected: `>= ${thresholds.min_guard_ood_recall}`,
      reason: `Guard OOD recall (${aggregates.guard_ood_recall.toFixed(2)}) is below ${thresholds.min_guard_ood_recall}`,
    });
  }

  if (thresholds.min_disclaimer_correctness !== undefined && aggregates.disclaimer_correctness !== undefined && aggregates.disclaimer_correctness < thresholds.min_disclaimer_correctness) {
    failed_metrics.push({
      metric: 'disclaimer_correctness',
      actual: aggregates.disclaimer_correctness,
      expected: `>= ${thresholds.min_disclaimer_correctness}`,
      reason: `Disclaimer correctness (${aggregates.disclaimer_correctness.toFixed(2)}) is below ${thresholds.min_disclaimer_correctness}`,
    });
  }

  if (thresholds.min_faithfulness_avg !== undefined && aggregates.faithfulness_avg !== undefined && aggregates.faithfulness_avg < thresholds.min_faithfulness_avg) {
    failed_metrics.push({
      metric: 'faithfulness_avg',
      actual: aggregates.faithfulness_avg,
      expected: `>= ${thresholds.min_faithfulness_avg}`,
      reason: `Faithfulness judge average (${aggregates.faithfulness_avg.toFixed(2)}) is below ${thresholds.min_faithfulness_avg}`,
    });
  }

  if (thresholds.max_cost_per_case_avg !== undefined && aggregates.cost_per_case_avg !== undefined && aggregates.cost_per_case_avg > thresholds.max_cost_per_case_avg) {
    failed_metrics.push({
      metric: 'cost_per_case_avg',
      actual: aggregates.cost_per_case_avg,
      expected: `<= ${thresholds.max_cost_per_case_avg}`,
      reason: `Cost per case ($${aggregates.cost_per_case_avg.toFixed(4)}) exceeds budget limit $${thresholds.max_cost_per_case_avg}`,
    });
  }

  // 12. HITL interrupt rate (case_deep)
  if (thresholds.min_hitl_interrupt_rate !== undefined && (aggregates.hitl_cases_count ?? 0) > 0) {
    const actualRate = aggregates.hitl_interrupt_rate ?? 0;
    if (actualRate < thresholds.min_hitl_interrupt_rate) {
      failed_metrics.push({
        metric: 'hitl_interrupt_rate',
        actual: actualRate,
        expected: `>= ${thresholds.min_hitl_interrupt_rate}`,
        reason: `All require_hitl cases must trigger an interrupt (${aggregates.hitl_interrupted_count ?? 0}/${aggregates.hitl_cases_count ?? 0})`,
      });
    }
  }

  return {
    passed: failed_metrics.length === 0,
    gate_profile: profile,
    warnings,
    failed_metrics,
  };
}

/**
 * Compares current run report against baseline.
 * Enforces regression thresholds per spec L6.5:
 * - Fail if citation_precision drops > 2pp vs baseline
 * - Fail if hallucination count increases
 * - Fail if guard OOD recall drops > 1pp
 */
export function compareBaseline(
  current: { aggregates: EvalAggregates },
  baseline: { aggregates: EvalAggregates }
): BaselineComparisonResult {
  const failed_metrics: BaselineRegressionFailure[] = [];

  const currAgg = current.aggregates;
  const baseAgg = baseline.aggregates;

  // 1. Citation precision drop > 2pp (0.02)
  if (baseAgg.citation_precision !== undefined && currAgg.citation_precision !== undefined) {
    const drop = baseAgg.citation_precision - currAgg.citation_precision;
    if (drop > 0.02) {
      failed_metrics.push({
        metric: 'citation_precision',
        current: currAgg.citation_precision,
        baseline: baseAgg.citation_precision,
        reason: `Citation precision dropped by ${(drop * 100).toFixed(2)}pp (> 2.0pp regression threshold)`,
      });
    }
  }

  // 2. Hallucination increase > 0
  if (currAgg.hallucinated_citations_count > baseAgg.hallucinated_citations_count) {
    failed_metrics.push({
      metric: 'hallucinated_citations_count',
      current: currAgg.hallucinated_citations_count,
      baseline: baseAgg.hallucinated_citations_count,
      reason: `Hallucinated citations count increased from ${baseAgg.hallucinated_citations_count} to ${currAgg.hallucinated_citations_count}`,
    });
  }

  // 3. Guard OOD recall drop > 1pp (0.01)
  const baseOod = baseAgg.guard_ood_recall ?? baseAgg.ood_refuse_rate;
  const currOod = currAgg.guard_ood_recall ?? currAgg.ood_refuse_rate;
  if (baseOod !== undefined && currOod !== undefined) {
    const drop = baseOod - currOod;
    if (drop > 0.01) {
      failed_metrics.push({
        metric: 'guard_ood_recall',
        current: currOod,
        baseline: baseOod,
        reason: `Guard OOD recall dropped by ${(drop * 100).toFixed(2)}pp (> 1.0pp regression threshold)`,
      });
    }
  }

  return {
    passed: failed_metrics.length === 0,
    failed_metrics,
  };
}

export interface JudgeChunkCandidate {
  id?: string;
  article_number?: string;
  articleNumber?: string;
  title?: string;
  text?: string;
  content?: string;
}

export interface JudgeScorersReportInput {
  results: Array<{
    id: string;
    pass: boolean;
    scores: Record<string, unknown>;
    run_output: {
      text?: string;
      output_text?: string;
      prompt?: string;
      evidence?: JudgeChunkCandidate[];
      retrieved_chunks?: JudgeChunkCandidate[];
    };
  }>;
  aggregates: EvalAggregates;
  gate: GateEvaluationResult;
}

/**
 * Executes LLM-as-judge scoring for evaluation reports (Spec L6.3, L6.5).
 * Used by the 'full' gate profile (and online sampling).
 * Evaluates each result with retrieved context for faithfulness and completeness.
 * Skipped judges (e.g. no GROQ_API_KEY) are recorded as waivers and do not fail the pre_judge gate.
 */
export async function runJudgeScorers(
  report: JudgeScorersReportInput,
  options?: { sampleRate?: number }
): Promise<void> {
  const sampleRate =
    typeof options?.sampleRate === 'number'
      ? Math.max(0, Math.min(1, options.sampleRate))
      : 1.0;

  const faithfulnessScores: number[] = [];
  const completenessScores: number[] = [];
  let skippedCount = 0;

  for (const result of report.results) {
    const chunks =
      result.run_output?.retrieved_chunks || result.run_output?.evidence || [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      continue;
    }

    if (sampleRate < 1.0 && Math.random() > sampleRate) {
      continue;
    }

    const prompt = result.run_output?.prompt || result.id;
    const answer = result.run_output?.text || result.run_output?.output_text || '';

    const judgeChunks: JudgeInputChunk[] = chunks.map((c) => ({
      id: c.id,
      article_number: c.article_number || c.articleNumber,
      title: c.title,
      text: c.text || c.content || '',
    }));

    const [fJudge, cJudge] = await Promise.all([
      judgeRun({ prompt, answer, retrievedChunks: judgeChunks, rubric: 'faithfulness' }),
      judgeRun({ prompt, answer, retrievedChunks: judgeChunks, rubric: 'completeness' }),
    ]);

    result.scores['faithfulness_judge'] = {
      score: fJudge.score >= 0.8 ? 1 : 0,
      details: {
        raw_score: fJudge.score,
        rationale: fJudge.rationale,
        flags: fJudge.flags,
        skipped: Boolean(fJudge.skipped),
      },
    };

    result.scores['completeness_judge'] = {
      score: cJudge.score >= 0.8 ? 1 : 0,
      details: {
        raw_score: cJudge.score,
        rationale: cJudge.rationale,
        flags: cJudge.flags,
        skipped: Boolean(cJudge.skipped),
      },
    };

    if (fJudge.skipped || cJudge.skipped) {
      skippedCount++;
    }

    if (!fJudge.skipped) {
      faithfulnessScores.push(fJudge.score);
    }
    if (!cJudge.skipped) {
      completenessScores.push(cJudge.score);
    }
  }

  // Update aggregates if scores were obtained
  if (faithfulnessScores.length > 0) {
    report.aggregates.faithfulness_avg =
      faithfulnessScores.reduce((a, b) => a + b, 0) / faithfulnessScores.length;
  }
  if (completenessScores.length > 0) {
    report.aggregates.completeness_avg =
      completenessScores.reduce((a, b) => a + b, 0) / completenessScores.length;
  }

  // Record waivers if judges were skipped
  if (skippedCount > 0 || !process.env.GROQ_API_KEY) {
    if (!report.gate.waivers) {
      report.gate.waivers = [];
    }
    report.gate.waivers.push(
      'GROQ_API_KEY unset or judge calls skipped; evaluated under pre_judge fallback waiver.'
    );
    report.gate.warnings.push(
      'LLM judges were skipped for some or all cases (no API key or network failure).'
    );
  }

  // Enforce full gate threshold if faithfulness_avg was computed and profile is full
  if (
    report.gate.gate_profile === 'full' &&
    report.aggregates.faithfulness_avg !== undefined
  ) {
    const minFaithfulness = GATE_DEFAULTS.full.min_faithfulness_avg ?? 0.80;
    if (report.aggregates.faithfulness_avg < minFaithfulness) {
      report.gate.passed = false;
      report.gate.failed_metrics.push({
        metric: 'faithfulness_avg',
        actual: report.aggregates.faithfulness_avg,
        expected: `>= ${minFaithfulness}`,
        reason: `Faithfulness judge average (${report.aggregates.faithfulness_avg.toFixed(2)}) is below ${minFaithfulness}`,
      });
    }
  }
}
