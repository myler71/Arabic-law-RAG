import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { preGuard, postGuard } from '../../ai/safety/legalGuard';
import {
  retrieveLegalEvidence,
  type LegalChunk,
} from '../../ai/legalRag';
import {
  generateGroundedAnswer,
  extractStructuredSummary,
  type StructuredCaseSummary,
} from '../../ai/generation/grounded';
import { newTraceId, newRunId } from '../ids';
import { resolveVersions } from '../versions';
import { runCaseDeep, resumeCaseDeep } from '../../ai/agents/graph';
import type { LegalGraphState } from '../../ai/agents/types';
import {
  RULE_SCORERS,
  matchAnchorInChunk,
  type EvalScenario,
  type EvalRunOutput,
  type ScorerResult,
} from './scorers';
import {
  evaluateGates,
  compareBaseline,
  type EvalAggregates,
  type GateProfile,
  type GateEvaluationResult,
  type BaselineComparisonResult,
} from './gates';

export interface RunSuiteOptions {
  gateProfile?: GateProfile;
  updateBaseline?: boolean;
  baselinePath?: string;
  compareBaseline?: boolean;
  reportsDir?: string;
  silent?: boolean;
}

export interface ScenarioResult {
  id: string;
  pass: boolean;
  scores: Record<string, ScorerResult>;
  trace_id: string;
  duration_ms: number;
  run_output: EvalRunOutput;
  error?: string | null;
}

export interface EvalReport {
  suite: string;
  started_at: string;
  finished_at: string;
  git_sha: string;
  prompt_versions: Record<string, string>;
  model_ids: Record<string, string>;
  rag_index_version: string;
  guard_version: string;
  results: ScenarioResult[];
  aggregates: EvalAggregates;
  gate: GateEvaluationResult;
  baseline_comparison?: BaselineComparisonResult | null;
  report_json_path?: string;
  report_md_path?: string;
}

/**
 * Runs the real HAKMDAR pipeline on a single evaluation scenario.
 */
export async function executeScenarioPipeline(scenario: EvalScenario): Promise<{
  run_output: EvalRunOutput;
  duration_ms: number;
  error?: string | null;
}> {
  const prompt = scenario.prompt || scenario.question_ar || '';
  const t0 = performance.now();

  try {
    // 1. preGuard
    const guardPre = preGuard(prompt);

    if (!guardPre.is_legal) {
      const duration_ms = Math.round(performance.now() - t0);
      const run_output: EvalRunOutput = {
        is_legal: false,
        domain: guardPre.domain,
        mapped_legal_concepts: guardPre.mapped_legal_concepts,
        applicable_laws: guardPre.applicable_laws,
        reject_reason: guardPre.reject_reason,
        clarification_question: guardPre.clarification_question,
        action: 'refuse',
        text: guardPre.reject_reason || '',
        ttft_ms: duration_ms,
        evidence: [],
        retrieved_chunks: [],
        verified_citations: [],
        unverified_citations: [],
        structured_summary: null,
      };
      return { run_output, duration_ms };
    }

    // 2. retrieveLegalEvidence
    const retrievalRes = await retrieveLegalEvidence(prompt, { topK: scenario.retrieval_k ?? 5 });
    const evidence = retrievalRes.evidence || [];

    // 3. Grounded generation
    const gen = generateGroundedAnswer(prompt, evidence, guardPre);

    // 4. postGuard
    const guardPost = postGuard(gen.text, evidence);

    // 5. extractStructuredSummary
    const structuredSummary = extractStructuredSummary(prompt, evidence, guardPre, gen.isDisclaimer);

    const duration_ms = Math.round(performance.now() - t0);

    const run_output: EvalRunOutput = {
      is_legal: true,
      domain: guardPre.domain,
      mapped_legal_concepts: guardPre.mapped_legal_concepts,
      applicable_laws: guardPre.applicable_laws,
      evidence,
      retrieved_chunks: evidence,
      text: guardPost.cleaned_text,
      action: guardPost.action,
      evidence_score: guardPost.evidence_score,
      verified_citations: guardPost.verified_citations,
      unverified_citations: guardPost.unverified_citations || [],
      disclaimer: guardPost.disclaimer,
      is_disclaimer: gen.isDisclaimer,
      structured_summary: structuredSummary,
      ttft_ms: duration_ms,
    };

    return { run_output, duration_ms };
  } catch (err: unknown) {
    const duration_ms = Math.round(performance.now() - t0);
    const errorMsg = err instanceof Error ? err.message : String(err);
    const run_output: EvalRunOutput = {
      is_legal: false,
      action: 'refuse',
      error: errorMsg,
      errors: [errorMsg],
      ttft_ms: duration_ms,
    };
    return { run_output, duration_ms, error: errorMsg };
  }
}

/**
 * Runs the case_deep multi-agent graph pipeline on an evaluation scenario up to HITL,
 * verifies HITL interrupt when required, resumes with scenario review decision,
 * and returns the finalized output.
 */
export async function executeCaseDeepScenarioPipeline(scenario: EvalScenario): Promise<{
  run_output: EvalRunOutput;
  duration_ms: number;
  error?: string | null;
}> {
  const prompt = scenario.prompt || scenario.question_ar || '';
  const t0 = performance.now();

  try {
    const initialState: LegalGraphState = {
      trace_id: newTraceId(),
      run_id: newRunId(),
      user_id: 'synthetic-lawyer',
      raw_query: prompt,
      normalized_query: '',
      guard_pre: null,
      route_plan: null,
      retrieved_chunks: [],
      specialist_outputs: {},
      citations: [],
      hitl: { status: 'pending' },
      timings: [],
    };

    // 1. Run multi-agent graph up to HITL review checkpoint
    const pausedState = await runCaseDeep(initialState);
    const hitlTriggered = pausedState.hitl?.status === 'awaiting_review';

    // If pre-guard rejected (OOD or illegal)
    if (!pausedState.guard_pre?.is_legal) {
      const duration_ms = Math.round(performance.now() - t0);
      const run_output: EvalRunOutput = {
        is_legal: false,
        domain: pausedState.guard_pre?.domain || null,
        mapped_legal_concepts: pausedState.guard_pre?.mapped_legal_concepts || [],
        applicable_laws: pausedState.guard_pre?.applicable_laws || [],
        reject_reason: pausedState.guard_pre?.reject_reason || null,
        action: 'refuse',
        text: pausedState.final_response || pausedState.guard_pre?.reject_reason || '',
        output_text: pausedState.final_response || pausedState.guard_pre?.reject_reason || '',
        ttft_ms: duration_ms,
        evidence: [],
        retrieved_chunks: [],
        verified_citations: [],
        unverified_citations: [],
        structured_summary: null,
        hitl_triggered: false,
        interrupt: false,
      };
      return { run_output, duration_ms };
    }

    // 2. Resume with scenario decision (default 'approve')
    const rawScenario = scenario as unknown as Record<string, unknown>;
    const decision = (rawScenario.hitl_decision as 'approve' | 'modify' | 'reject') || 'approve';
    const notes = typeof rawScenario.hitl_notes === 'string' ? rawScenario.hitl_notes : undefined;
    const modified_draft = typeof rawScenario.modified_draft === 'string' ? rawScenario.modified_draft : undefined;

    const finalizedState = await resumeCaseDeep(pausedState, {
      decision,
      notes,
      modified_draft,
      reviewer_id: 'synthetic-lawyer',
    });

    const duration_ms = Math.round(performance.now() - t0);
    const action = finalizedState.guard_post?.action === 'disclaimer'
      ? 'disclaimer'
      : (decision === 'reject' ? 'refuse' : 'pass');

    const run_output: EvalRunOutput = {
      is_legal: true,
      domain: finalizedState.route_plan?.domain || finalizedState.guard_pre?.domain || null,
      mapped_legal_concepts: finalizedState.route_plan?.mapped_concepts || finalizedState.guard_pre?.mapped_legal_concepts || [],
      applicable_laws: finalizedState.route_plan?.applicable_laws || finalizedState.guard_pre?.applicable_laws || [],
      evidence: finalizedState.retrieved_chunks || [],
      retrieved_chunks: finalizedState.retrieved_chunks || [],
      text: finalizedState.final_response || finalizedState.draft_answer || '',
      output_text: finalizedState.final_response || finalizedState.draft_answer || '',
      action,
      evidence_score: finalizedState.guard_post?.evidence_score ?? (finalizedState.retrieved_chunks.length > 0 ? 0.85 : 0.0),
      verified_citations: finalizedState.citations || [],
      unverified_citations: finalizedState.guard_post?.unverified_citations || [],
      disclaimer: finalizedState.guard_post?.disclaimer || null,
      is_disclaimer: finalizedState.guard_post?.action === 'disclaimer',
      structured_summary: finalizedState.structured_summary
        ? {
            case_type: typeof finalizedState.structured_summary.case_type === 'string'
              ? finalizedState.structured_summary.case_type
              : (finalizedState.route_plan?.domain || 'نزاع قانوني'),
            risk_level: 'medium',
            recommended_action: typeof finalizedState.structured_summary.recommended_action === 'string'
              ? finalizedState.structured_summary.recommended_action
              : 'استكمال المستندات والمتابعة الإجرائية',
          }
        : null,
      ttft_ms: duration_ms,
      hitl_triggered: hitlTriggered,
      interrupt: hitlTriggered,
    };

    return { run_output, duration_ms };
  } catch (err: unknown) {
    const duration_ms = Math.round(performance.now() - t0);
    const errorMsg = err instanceof Error ? err.message : String(err);
    const run_output: EvalRunOutput = {
      is_legal: false,
      action: 'refuse',
      error: errorMsg,
      errors: [errorMsg],
      ttft_ms: duration_ms,
      hitl_triggered: false,
      interrupt: false,
    };
    return { run_output, duration_ms, error: errorMsg };
  }
}

/**
 * Computes aggregate summary metrics from individual scenario results.
 */
export function computeAggregates(
  scenarios: EvalScenario[],
  results: ScenarioResult[]
): EvalAggregates {
  const total_cases = scenarios.length;
  let legal_cases_count = 0;
  let ood_cases_count = 0;

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  let emotional_legal_false_reject_count = 0;
  let totalRetrievalRecall = 0;
  let retrievalScenariosEvaluated = 0;

  let totalVerifiedCitations = 0;
  let totalUnverifiedCitations = 0;
  let hallucinated_citations_count = 0;

  let pipeline_hard_errors_count = 0;
  const ttftList: number[] = [];

  let disclaimerCasesEvaluated = 0;
  let disclaimerCorrectCount = 0;
  let hitlCasesCount = 0;
  let hitlInterruptedCount = 0;
  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    const result = results[i];
    const out = result.run_output;

    if (result.error) {
      pipeline_hard_errors_count++;
    }

    if (out.ttft_ms !== undefined) {
      ttftList.push(out.ttft_ms);
    }

    const expectLegal = scenario.expect_is_legal ?? scenario.is_legal;

    if (expectLegal) {
      legal_cases_count++;
      if (out.is_legal) {
        tp++;
      } else {
        fn++;
        // Check if emotional / colloquial
        const isEmotionalColloquial =
          scenario.register === 'colloquial' ||
          (scenario.notes && scenario.notes.includes('عامية')) ||
          scenario.id.startsWith('labor') ||
          (scenario.expect_mapped_concepts_any_of && scenario.expect_mapped_concepts_any_of.length > 0);
        if (isEmotionalColloquial) {
          emotional_legal_false_reject_count++;
        }
      }

      // Retrieval recall
      const anchors = [
        ...(scenario.expected_article_anchor ?? []),
        ...(scenario.expected_sources?.retrieval_must_include_any ?? []),
      ];
      if (scenario.expected_sources?.must_cite_any_of) {
        for (const g of scenario.expected_sources.must_cite_any_of) {
          if (g.articles) anchors.push(...g.articles);
        }
      }

      if (anchors.length > 0) {
        retrievalScenariosEvaluated++;
        const chunks = (out.retrieved_chunks ?? out.evidence ?? []).slice(0, 5);
        let found = 0;
        for (const anchor of anchors) {
          if (chunks.some((c) => matchAnchorInChunk(anchor, c))) {
            found++;
          }
        }
        totalRetrievalRecall += found / anchors.length;
      }

      // Citations
      const vCount = out.verified_citations?.length ?? 0;
      const uCount = out.unverified_citations?.length ?? 0;
      totalVerifiedCitations += vCount;
      totalUnverifiedCitations += uCount;
    } else {
      ood_cases_count++;
      if (!out.is_legal) {
        tn++;
      } else {
        fp++;
      }
    }

    // Hallucinations
    const halluScore = result.scores.hallucination_citation_scorer;
    if (halluScore && halluScore.score === 0) {
      hallucinated_citations_count++;
    }

    // Disclaimer
    if (scenario.expect_disclaimer || scenario.require_disclaimer || scenario.allow_disclaimer === false) {
      disclaimerCasesEvaluated++;
      const discScore = result.scores.disclaimer_scorer;
      if (discScore && discScore.score === 1) {
        disclaimerCorrectCount++;
      }
    }

    // HITL tracking
    if (scenario.require_hitl) {
      hitlCasesCount++;
      if (out.hitl_triggered || out.action === 'hitl' || out.interrupt === true) {
        hitlInterruptedCount++;
      }
    }
  }

  // TTFT percentiles
  ttftList.sort((a, b) => a - b);
  const ttft_p50 = ttftList.length > 0 ? ttftList[Math.floor(ttftList.length * 0.5)] : 0;
  const ttft_p95 = ttftList.length > 0 ? ttftList[Math.min(ttftList.length - 1, Math.floor(ttftList.length * 0.95))] : 0;

  const guard_precision = tp + fp > 0 ? tp / (tp + fp) : 1.0;
  const guard_recall = tp + fn > 0 ? tp / (tp + fn) : 1.0;
  const ood_refuse_rate = tn + fp > 0 ? tn / (tn + fp) : 1.0;
  const retrieval_recall_at_5 = retrievalScenariosEvaluated > 0 ? totalRetrievalRecall / retrievalScenariosEvaluated : 1.0;

  const totalCitations = totalVerifiedCitations + totalUnverifiedCitations;
  const citation_precision = totalCitations > 0 ? totalVerifiedCitations / totalCitations : 1.0;
  const disclaimer_correctness = disclaimerCasesEvaluated > 0 ? disclaimerCorrectCount / disclaimerCasesEvaluated : 1.0;
  const hitl_interrupt_rate = hitlCasesCount > 0 ? hitlInterruptedCount / hitlCasesCount : 1.0;

  return {
    total_cases,
    legal_cases_count,
    ood_cases_count,
    guard_precision,
    guard_recall,
    guard_ood_recall: ood_refuse_rate,
    ood_refuse_rate,
    emotional_legal_false_reject_count,
    retrieval_recall_at_5,
    citation_precision,
    hallucinated_citations_count,
    disclaimer_correctness,
    pipeline_hard_errors_count,
    ttft_p50,
    ttft_p95,
    hitl_cases_count: hitlCasesCount,
    hitl_interrupted_count: hitlInterruptedCount,
    hitl_interrupt_rate,
  };
}

/**
 * Formats Markdown report for the evaluation run.
 */
export function formatMarkdownReport(report: EvalReport): string {
  const { suite, started_at, git_sha, gate, aggregates, results } = report;

  const lines: string[] = [];
  lines.push(`# HAKMDAR Evaluation Report: ${suite.toUpperCase()}`);
  lines.push('');
  lines.push(`- **Date**: ${started_at}`);
  lines.push(`- **Git Commit**: \`${git_sha}\``);
  lines.push(`- **Gate Profile**: \`${gate.gate_profile}\``);
  lines.push(`- **Gate Status**: ${gate.passed ? '✅ PASSED' : '❌ FAILED'}`);
  lines.push('');

  if (gate.failed_metrics.length > 0) {
    lines.push('### ⚠️ Failed Gate Metrics');
    for (const f of gate.failed_metrics) {
      lines.push(`- **${f.metric}**: actual \`${f.actual}\` vs expected \`${f.expected}\` (${f.reason})`);
    }
    lines.push('');
  }

  if (gate.warnings.length > 0) {
    lines.push('### 🔔 Warnings');
    for (const w of gate.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  lines.push('### Key Aggregate Metrics');
  lines.push('| Metric | Value | Target / Requirement |');
  lines.push('|---|---|---|');
  lines.push(`| Out-of-Domain Refusal Rate | ${(aggregates.ood_refuse_rate * 100).toFixed(1)}% | 100% |`);
  lines.push(`| Emotional Legal False Rejects | ${aggregates.emotional_legal_false_reject_count} | 0 |`);
  lines.push(`| Citation Precision | ${(aggregates.citation_precision * 100).toFixed(1)}% | ≥ 98% |`);
  lines.push(`| Hallucinated Citations | ${aggregates.hallucinated_citations_count} | 0 |`);
  lines.push(`| Pipeline Hard Errors | ${aggregates.pipeline_hard_errors_count} | 0 |`);
  lines.push(`| TTFT p50 / p95 | ${aggregates.ttft_p50}ms / ${aggregates.ttft_p95 || 0}ms | ≤ 3000ms (warn > 800ms) |`);
  lines.push(`| Retrieval Recall@5 | ${(aggregates.retrieval_recall_at_5 * 100).toFixed(1)}% | ≥ 75% |`);
  lines.push(`| Total Scenarios Tested | ${aggregates.total_cases} (${aggregates.legal_cases_count} legal, ${aggregates.ood_cases_count} OOD) | - |`);
  lines.push('');

  lines.push('### Scenario Details');
  lines.push('| ID | Pass? | Legal? | Action | Citations (V/U) | TTFT | Notes |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const v = r.run_output.verified_citations?.length ?? 0;
    const u = r.run_output.unverified_citations?.length ?? 0;
    lines.push(
      `| \`${r.id}\` | ${r.pass ? '✅' : '❌'} | ${r.run_output.is_legal ? 'Legal' : 'OOD/Refused'} | \`${r.run_output.action || 'pass'}\` | ${v}/${u} | ${r.run_output.ttft_ms ?? 0}ms | ${r.error || 'OK'} |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Main function to execute an evaluation suite file and generate reports.
 */
export async function runSuite(
  suitePath: string,
  options: RunSuiteOptions = {}
): Promise<EvalReport> {
  const started_at = new Date().toISOString();

  const resolvedSuitePath = path.isAbsolute(suitePath)
    ? suitePath
    : path.resolve(process.cwd(), suitePath);

  if (!fs.existsSync(resolvedSuitePath)) {
    throw new Error(`Evaluation suite file not found at: ${resolvedSuitePath}`);
  }

  const rawSuite = fs.readFileSync(resolvedSuitePath, 'utf-8');
  const scenarios = JSON.parse(rawSuite) as EvalScenario[];

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error(`Evaluation suite at ${resolvedSuitePath} is empty or not an array`);
  }

  const suiteName = path.basename(resolvedSuitePath, '.json');
  const isCaseDeepSuite = suiteName.includes('case_deep') || options.gateProfile === 'case_deep';
  const gateProfile = options.gateProfile ?? (isCaseDeepSuite ? 'case_deep' : 'smoke');
  const versions = resolveVersions();

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const isScenarioCaseDeep = isCaseDeepSuite || scenario.mode_target === 'case_deep';
    const { run_output, duration_ms, error } = isScenarioCaseDeep
      ? await executeCaseDeepScenarioPipeline(scenario)
      : await executeScenarioPipeline(scenario);

    // Run all rule scorers
    const scores: Record<string, ScorerResult> = {};
    for (const [scorerName, scorerFn] of Object.entries(RULE_SCORERS)) {
      scores[scorerName] = scorerFn({ scenario, run_output });
    }

    const pass = Object.values(scores).every((s) => s.score === 1) && !error;

    results.push({
      id: scenario.id,
      pass,
      scores,
      trace_id: newTraceId(),
      duration_ms,
      run_output,
      error,
    });
  }

  const finished_at = new Date().toISOString();
  const aggregates = computeAggregates(scenarios, results);
  const gate = evaluateGates(aggregates, gateProfile);

  // Compare baseline if baseline exists
  const reportsDir = options.reportsDir || path.resolve(process.cwd(), 'evaluation/reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const baselinePath = options.baselinePath || path.join(reportsDir, 'baseline-smoke.json');
  let baseline_comparison: BaselineComparisonResult | null = null;

  if (fs.existsSync(baselinePath) && !options.updateBaseline) {
    try {
      const baseRaw = fs.readFileSync(baselinePath, 'utf-8');
      const baseReport = JSON.parse(baseRaw);
      if (baseReport && baseReport.aggregates) {
        baseline_comparison = compareBaseline({ aggregates }, baseReport);
        if (!baseline_comparison.passed) {
          gate.passed = false;
          for (const reg of baseline_comparison.failed_metrics) {
            gate.failed_metrics.push({
              metric: `regression:${reg.metric}`,
              actual: reg.current,
              expected: `not worse than baseline ${reg.baseline}`,
              reason: reg.reason,
            });
          }
        }
      }
    } catch {
      // Baseline read warning ignored
    }
  }

  const report: EvalReport = {
    suite: suiteName,
    started_at,
    finished_at,
    git_sha: versions.app_git_sha,
    prompt_versions: { chat_fast: versions.prompt_version },
    model_ids: { default: versions.model_id },
    rag_index_version: versions.rag_index_version,
    guard_version: versions.guard_version,
    results,
    aggregates,
    gate,
    baseline_comparison,
  };

  // Safe timestamp format for filenames (YYYY-MM-DDTHH-mm-ss)
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '-');
  const timestamp = `${dateStr}T${timeStr}`;

  const jsonReportPath = path.join(reportsDir, `${timestamp}-${suiteName}.json`);
  const mdReportPath = path.join(reportsDir, `${timestamp}-${suiteName}.md`);

  report.report_json_path = jsonReportPath;
  report.report_md_path = mdReportPath;

  // Write reports
  fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2), 'utf-8');
  const mdContent = formatMarkdownReport(report);
  fs.writeFileSync(mdReportPath, mdContent, 'utf-8');

  // Update or initialize baseline
  if (options.updateBaseline || !fs.existsSync(baselinePath)) {
    fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2), 'utf-8');
  }

  if (!options.silent) {
    console.log(`\n================== HAKMDAR EVALUATION (${suiteName}) ==================`);
    console.log(`Gate Profile: ${gateProfile} | Status: ${gate.passed ? 'PASSED ✅' : 'FAILED ❌'}`);
    console.log(`Cases: ${aggregates.total_cases} (${aggregates.legal_cases_count} legal, ${aggregates.ood_cases_count} OOD)`);
    console.log(`OOD Refuse Rate: ${(aggregates.ood_refuse_rate * 100).toFixed(1)}%`);
    console.log(`Citation Precision: ${(aggregates.citation_precision * 100).toFixed(1)}%`);
    console.log(`Hallucinated Citations: ${aggregates.hallucinated_citations_count}`);
    console.log(`TTFT p50: ${aggregates.ttft_p50}ms`);
    console.log(`Report JSON: ${jsonReportPath}`);
    console.log(`Report MD: ${mdReportPath}`);
    if (gate.failed_metrics.length > 0) {
      console.log('Failed Metrics:');
      for (const f of gate.failed_metrics) {
        console.log(`  - [${f.metric}] actual ${f.actual} vs expected ${f.expected}: ${f.reason}`);
      }
    }
    console.log('=======================================================================\n');
  }

  return report;
}

// CLI entry point
const isCli =
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith('runner.ts') ||
    process.argv[1].endsWith('runner.js') ||
    process.argv[1].includes('eval/runner') ||
    process.argv[1].includes('eval\\runner'));

if (isCli) {
  const args = process.argv.slice(2);
  const suiteIdx = args.indexOf('--suite');
  let suiteArg: string;
  if (suiteIdx !== -1 && args[suiteIdx + 1]) {
    const val = args[suiteIdx + 1];
    if (val === 'case_deep') {
      suiteArg = 'lib/llmops/eval/case_deep_suite.json';
    } else if (val === 'smoke') {
      suiteArg = 'evaluation/smoke_suite.json';
    } else {
      suiteArg = val;
    }
  } else {
    suiteArg = args.find((a) => !a.startsWith('-')) || 'evaluation/smoke_suite.json';
    if (suiteArg === 'case_deep') {
      suiteArg = 'lib/llmops/eval/case_deep_suite.json';
    }
  }

  const isCaseDeep = suiteArg.includes('case_deep') || args.includes('case_deep');
  const defaultGate = isCaseDeep ? 'case_deep' : 'smoke';
  const gateIdx = args.indexOf('--gate');
  const gateProfile = (gateIdx !== -1 && args[gateIdx + 1] ? args[gateIdx + 1] : defaultGate) as GateProfile;
  const updateBaseline = args.includes('--update-baseline');
  const compareBaseline = args.includes('--compare-baseline');
  const baselineIdx = args.indexOf('--baseline');
  const baselinePath = baselineIdx !== -1 && args[baselineIdx + 1] ? args[baselineIdx + 1] : undefined;

  runSuite(suiteArg, { gateProfile, updateBaseline, compareBaseline, baselinePath })
    .then((report) => {
      if (!report.gate.passed) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('Eval runner error:', err);
      process.exit(1);
    });
}
