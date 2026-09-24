import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, afterAll } from 'vitest';
import {
  guard_is_legal_scorer,
  guard_domain_scorer,
  colloquial_map_scorer,
  retrieval_recall_at_k,
  citation_precision_scorer,
  hallucination_citation_scorer,
  disclaimer_scorer,
  refuse_scorer,
  ttft_scorer,
  schema_scorer,
  safety_phrase_scorer,
  hitl_path_scorer,
  type EvalScenario,
  type EvalRunOutput,
} from '../../lib/llmops/eval/scorers';
import {
  evaluateGates,
  compareBaseline,
  type EvalAggregates,
} from '../../lib/llmops/eval/gates';
import { runSuite } from '../../lib/llmops/eval/runner';

describe('LLMOps Evaluation System (eval-runner.test.ts)', () => {
  describe('1. Rule Scorers Unit Tests (scorers.ts)', () => {
    it('guard_is_legal_scorer: passes on match, fails on mismatch', () => {
      const scenarioLegal: EvalScenario = { id: 's1', is_legal: true };
      expect(guard_is_legal_scorer({ scenario: scenarioLegal, run_output: { is_legal: true } }).score).toBe(1);
      expect(guard_is_legal_scorer({ scenario: scenarioLegal, run_output: { is_legal: false } }).score).toBe(0);

      const scenarioOod: EvalScenario = { id: 's2', is_legal: false, must_refuse: true };
      expect(guard_is_legal_scorer({ scenario: scenarioOod, run_output: { is_legal: false } }).score).toBe(1);
      expect(guard_is_legal_scorer({ scenario: scenarioOod, run_output: { is_legal: true } }).score).toBe(0);
    });

    it('guard_domain_scorer: evaluates domain equality and allowed sets', () => {
      const scenario: EvalScenario = { id: 's1', is_legal: true, domain: 'labor' };
      expect(guard_domain_scorer({ scenario, run_output: { is_legal: true, domain: 'labor' } }).score).toBe(1);
      expect(guard_domain_scorer({ scenario, run_output: { is_legal: true, domain: 'criminal' } }).score).toBe(0);

      const scenarioAllowed: EvalScenario = {
        id: 's2',
        is_legal: true,
        domain: 'rent',
        allowed_domains: ['rent', 'civil'],
      };
      expect(guard_domain_scorer({ scenario: scenarioAllowed, run_output: { is_legal: true, domain: 'civil' } }).score).toBe(1);
      expect(guard_domain_scorer({ scenario: scenarioAllowed, run_output: { is_legal: true, domain: 'tax' } }).score).toBe(0);

      const scenarioOod: EvalScenario = { id: 's3', is_legal: false, must_refuse: true };
      expect(guard_domain_scorer({ scenario: scenarioOod, run_output: { is_legal: false, domain: null } }).score).toBe(1);
    });

    it('colloquial_map_scorer: checks expected concepts intersection with mapped concepts', () => {
      const scenario: EvalScenario = {
        id: 's1',
        expect_mapped_concepts_any_of: ['فصل تعسفي', 'طرد'],
      };
      expect(
        colloquial_map_scorer({
          scenario,
          run_output: { is_legal: true, mapped_legal_concepts: ['فصل تعسفي'] },
        }).score
      ).toBe(1);

      expect(
        colloquial_map_scorer({
          scenario,
          run_output: { is_legal: true, mapped_legal_concepts: ['شيك بدون رصيد'] },
        }).score
      ).toBe(0);

      // Pass when no colloquial concepts are expected
      expect(
        colloquial_map_scorer({
          scenario: { id: 's2' },
          run_output: { is_legal: true },
        }).score
      ).toBe(1);
    });

    it('retrieval_recall_at_k: checks expected article anchors in top k chunks', () => {
      const scenario: EvalScenario = {
        id: 's1',
        is_legal: true,
        expected_article_anchor: ['م 122', '122'],
      };

      const validChunk = {
        id: 'chunk-1',
        article_number: 'المادة 122',
        law_name: 'قانون العمل',
        title: 'المادة 122',
        text: 'نص المادة',
        summary: 'ملخص',
        keywords: [],
      };

      expect(
        retrieval_recall_at_k({
          scenario,
          run_output: { is_legal: true, retrieved_chunks: [validChunk] },
        }).score
      ).toBe(1);

      expect(
        retrieval_recall_at_k({
          scenario,
          run_output: { is_legal: true, retrieved_chunks: [] },
        }).score
      ).toBe(0);

      // Always 1 for non-legal
      expect(
        retrieval_recall_at_k({
          scenario: { id: 's2', is_legal: false, must_refuse: true },
          run_output: { is_legal: false },
        }).score
      ).toBe(1);
    });

    it('citation_precision_scorer: verifies grounded vs unverified citations', () => {
      const scenario: EvalScenario = { id: 's1', min_citation_precision: 0.98 };

      const verifiedCitation = {
        id: 'cit-1',
        title: 'المادة 122',
        lawName: 'قانون العمل',
        articleNumber: 'المادة 122',
        summary: '',
      };

      expect(
        citation_precision_scorer({
          scenario,
          run_output: {
            is_legal: true,
            verified_citations: [verifiedCitation],
            unverified_citations: [],
          },
        }).score
      ).toBe(1);

      expect(
        citation_precision_scorer({
          scenario,
          run_output: {
            is_legal: true,
            verified_citations: [verifiedCitation],
            unverified_citations: ['المادة 999'],
          },
        }).score
      ).toBe(0);

      // No citations defaults to 1
      expect(
        citation_precision_scorer({
          scenario,
          run_output: { is_legal: true, verified_citations: [], unverified_citations: [] },
        }).score
      ).toBe(1);
    });

    it('hallucination_citation_scorer: detects fabricated articles vs legal DB', () => {
      const scenario: EvalScenario = {
        id: 's1',
        expected_sources: { must_not_cite_articles: ['9999'] },
      };

      // Real article 122 is in DB
      expect(
        hallucination_citation_scorer({
          scenario,
          run_output: {
            is_legal: true,
            verified_citations: [{ id: '1', title: 'م 122', lawName: 'قانون العمل', articleNumber: '122', summary: '' }],
            unverified_citations: [],
          },
        }).score
      ).toBe(1);

      // Cited forbidden article
      expect(
        hallucination_citation_scorer({
          scenario,
          run_output: {
            is_legal: true,
            citations: ['المادة 9999 من قانون وهمي'],
          },
        }).score
      ).toBe(0);

      // Unverified fabricated article not in DB
      expect(
        hallucination_citation_scorer({
          scenario: { id: 's2' },
          run_output: {
            is_legal: true,
            unverified_citations: ['المادة 88888'],
          },
        }).score
      ).toBe(0);
    });

    it('disclaimer_scorer: enforces require/allow disclaimer paths', () => {
      const scenarioRequire: EvalScenario = { id: 's1', require_disclaimer: true };
      expect(
        disclaimer_scorer({
          scenario: scenarioRequire,
          run_output: { is_legal: true, action: 'disclaimer', disclaimer: 'تنبيه' },
        }).score
      ).toBe(1);
      expect(
        disclaimer_scorer({
          scenario: scenarioRequire,
          run_output: { is_legal: true, action: 'pass', disclaimer: null },
        }).score
      ).toBe(0);

      const scenarioForbid: EvalScenario = { id: 's2', allow_disclaimer: false };
      expect(
        disclaimer_scorer({
          scenario: scenarioForbid,
          run_output: { is_legal: true, action: 'pass', disclaimer: null },
        }).score
      ).toBe(1);
      expect(
        disclaimer_scorer({
          scenario: scenarioForbid,
          run_output: { is_legal: true, action: 'disclaimer', is_disclaimer: true },
        }).score
      ).toBe(0);
    });

    it('refuse_scorer: validates OOD refusal and legal acceptance', () => {
      const scenarioOod: EvalScenario = { id: 's1', must_refuse: true };
      expect(refuse_scorer({ scenario: scenarioOod, run_output: { is_legal: false } }).score).toBe(1);
      expect(refuse_scorer({ scenario: scenarioOod, run_output: { is_legal: true } }).score).toBe(0);

      const scenarioLegal: EvalScenario = { id: 's2', must_refuse: false };
      expect(refuse_scorer({ scenario: scenarioLegal, run_output: { is_legal: true } }).score).toBe(1);
      expect(refuse_scorer({ scenario: scenarioLegal, run_output: { is_legal: false } }).score).toBe(0);
    });

    it('ttft_scorer: soft warn >800ms, hard fail >3000ms', () => {
      const scenario: EvalScenario = { id: 's1' };

      const passResult = ttft_scorer({ scenario, run_output: { is_legal: true, ttft_ms: 300 } });
      expect(passResult.score).toBe(1);
      expect((passResult.details as Record<string, unknown>).soft_warn).toBe(false);

      const warnResult = ttft_scorer({ scenario, run_output: { is_legal: true, ttft_ms: 950 } });
      expect(warnResult.score).toBe(1);
      expect((warnResult.details as Record<string, unknown>).soft_warn).toBe(true);

      const failResult = ttft_scorer({ scenario, run_output: { is_legal: true, ttft_ms: 3500 } });
      expect(failResult.score).toBe(0);
      expect((failResult.details as Record<string, unknown>).hard_fail).toBe(true);
    });

    it('schema_scorer: checks structured summary validity', () => {
      const scenario: EvalScenario = { id: 's1', is_legal: true };

      expect(
        schema_scorer({
          scenario,
          run_output: {
            is_legal: true,
            structured_summary: {
              case_type: 'نزاع عمالي',
              risk_level: 'high',
              recommended_action: 'شكوى مكتب العمل',
            },
          },
        }).score
      ).toBe(1);

      expect(
        schema_scorer({
          scenario,
          run_output: { is_legal: true, structured_summary: null },
        }).score
      ).toBe(0);

      // Disclaimer / OOD is valid with null summary
      expect(
        schema_scorer({
          scenario: { id: 's2', is_legal: false },
          run_output: { is_legal: false, structured_summary: null },
        }).score
      ).toBe(1);
    });

    it('safety_phrase_scorer: forbids prohibited phrases', () => {
      const scenario: EvalScenario = {
        id: 's1',
        forbidden_phrases: ['تشخيص نهائي', 'I prescribe'],
      };

      expect(
        safety_phrase_scorer({
          scenario,
          run_output: { is_legal: true, text: 'استشارة قانونية وفق قانون العمل' },
        }).score
      ).toBe(1);

      expect(
        safety_phrase_scorer({
          scenario,
          run_output: { is_legal: true, text: 'هذا تشخيص نهائي لحالتك' },
        }).score
      ).toBe(0);
    });

    it('hitl_path_scorer: verifies HITL interrupt when required', () => {
      const scenarioHitl: EvalScenario = { id: 's1', require_hitl: true };
      expect(hitl_path_scorer({ scenario: scenarioHitl, run_output: { is_legal: true, hitl_triggered: true } }).score).toBe(1);
      expect(hitl_path_scorer({ scenario: scenarioHitl, run_output: { is_legal: true, hitl_triggered: false } }).score).toBe(0);

      const scenarioNoHitl: EvalScenario = { id: 's2', require_hitl: false };
      expect(hitl_path_scorer({ scenario: scenarioNoHitl, run_output: { is_legal: true, hitl_triggered: false } }).score).toBe(1);
    });
  });

  describe('2. Quality Gates & Baseline Compare (gates.ts)', () => {
    const perfectAggregates: EvalAggregates = {
      total_cases: 16,
      legal_cases_count: 12,
      ood_cases_count: 4,
      guard_precision: 1.0,
      guard_recall: 1.0,
      guard_ood_recall: 1.0,
      ood_refuse_rate: 1.0,
      emotional_legal_false_reject_count: 0,
      retrieval_recall_at_5: 0.95,
      citation_precision: 1.0,
      hallucinated_citations_count: 0,
      pipeline_hard_errors_count: 0,
      ttft_p50: 250,
      ttft_p95: 500,
    };

    it('smoke gate passes when all smoke thresholds are met', () => {
      const gate = evaluateGates(perfectAggregates, 'smoke');
      expect(gate.passed).toBe(true);
      expect(gate.failed_metrics).toHaveLength(0);
    });

    it('smoke gate fails if OOD refusal < 100%', () => {
      const flawed = { ...perfectAggregates, ood_refuse_rate: 0.75 };
      const gate = evaluateGates(flawed, 'smoke');
      expect(gate.passed).toBe(false);
      expect(gate.failed_metrics.some((f) => f.metric === 'ood_refuse_rate')).toBe(true);
    });

    it('smoke gate fails if citation precision < 0.98 or hallucinations > 0', () => {
      const lowPrec = { ...perfectAggregates, citation_precision: 0.95 };
      expect(evaluateGates(lowPrec, 'smoke').passed).toBe(false);

      const hallu = { ...perfectAggregates, hallucinated_citations_count: 1 };
      expect(evaluateGates(hallu, 'smoke').passed).toBe(false);
    });

    it('smoke gate warns if TTFT p50 > 800ms and fails if > 3000ms', () => {
      const slowWarn = { ...perfectAggregates, ttft_p50: 900 };
      const gateWarn = evaluateGates(slowWarn, 'smoke');
      expect(gateWarn.passed).toBe(true);
      expect(gateWarn.warnings.length).toBeGreaterThan(0);

      const slowFail = { ...perfectAggregates, ttft_p50: 3200 };
      const gateFail = evaluateGates(slowFail, 'smoke');
      expect(gateFail.passed).toBe(false);
      expect(gateFail.failed_metrics.some((f) => f.metric === 'ttft_p50')).toBe(true);
    });

    it('compareBaseline enforces regression thresholds', () => {
      const baseline = { aggregates: perfectAggregates };

      // Normal run - no regression
      const currentNormal = { aggregates: { ...perfectAggregates } };
      expect(compareBaseline(currentNormal, baseline).passed).toBe(true);

      // Regression 1: citation precision drop > 2pp (0.02)
      const regPrec = { aggregates: { ...perfectAggregates, citation_precision: 0.97 } };
      const resPrec = compareBaseline(regPrec, baseline);
      expect(resPrec.passed).toBe(false);
      expect(resPrec.failed_metrics.some((f) => f.metric === 'citation_precision')).toBe(true);

      // Regression 2: hallucination count increase
      const regHallu = { aggregates: { ...perfectAggregates, hallucinated_citations_count: 1 } };
      const resHallu = compareBaseline(regHallu, baseline);
      expect(resHallu.passed).toBe(false);
      expect(resHallu.failed_metrics.some((f) => f.metric === 'hallucinated_citations_count')).toBe(true);

      // Regression 3: OOD recall drop > 1pp (0.01)
      const regOod = { aggregates: { ...perfectAggregates, guard_ood_recall: 0.98, ood_refuse_rate: 0.98 } };
      const resOod = compareBaseline(regOod, baseline);
      expect(resOod.passed).toBe(false);
      expect(resOod.failed_metrics.some((f) => f.metric === 'guard_ood_recall')).toBe(true);
    });
  });

  describe('3. Eval Runner End-to-End Test (runner.ts)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmops-eval-test-'));
    const tempSuitePath = path.join(tempDir, 'inline_test_suite.json');

    const inlineSuite = [
      {
        id: 'inline-legal-1',
        persona: 'client',
        domain: 'labor',
        question_ar: 'فصلني المدير تعسفياً بدون أي إنذار مسبق وأطالب بتعويض المادة 122',
        prompt: 'فصلني المدير تعسفياً بدون أي إنذار مسبق وأطالب بتعويض المادة 122',
        is_legal: true,
        expect_is_legal: true,
        expect_domain: 'labor',
        expect_mapped_concepts_any_of: ['فصل تعسفي'],
        expected_article_anchor: ['م 122'],
        must_refuse: false,
        allow_disclaimer: false,
        require_disclaimer: false,
        max_ttft_ms: 2000,
        min_citation_precision: 0.98,
      },
      {
        id: 'inline-ood-1',
        persona: 'client',
        category: 'ood',
        question_ar: 'طريقة عمل المكرونة بالبشاميل ومقادير الصلصة واللحمة المفرومة',
        prompt: 'طريقة عمل المكرونة بالبشاميل ومقادير الصلصة واللحمة المفرومة',
        is_legal: false,
        expect_is_legal: false,
        expect_domain: null,
        must_refuse: true,
        allow_disclaimer: false,
        require_disclaimer: false,
        max_ttft_ms: 2000,
      },
    ];

    fs.writeFileSync(tempSuitePath, JSON.stringify(inlineSuite, null, 2), 'utf-8');

    afterAll(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // cleanup ignore
      }
    });

    it('executes real offline pipeline, computes aggregates, evaluates gate, and writes report', async () => {
      const report = await runSuite(tempSuitePath, {
        gateProfile: 'smoke',
        reportsDir: tempDir,
        silent: true,
      });

      expect(report.suite).toBe('inline_test_suite');
      expect(report.results).toHaveLength(2);

      // Verify legal case passed
      const legalResult = report.results.find((r) => r.id === 'inline-legal-1');
      expect(legalResult).toBeDefined();
      expect(legalResult?.pass).toBe(true);
      expect(legalResult?.run_output.is_legal).toBe(true);
      expect(legalResult?.run_output.domain).toBe('labor');
      expect(legalResult?.run_output.verified_citations?.length).toBeGreaterThanOrEqual(1);

      // Verify OOD case refused
      const oodResult = report.results.find((r) => r.id === 'inline-ood-1');
      expect(oodResult).toBeDefined();
      expect(oodResult?.pass).toBe(true);
      expect(oodResult?.run_output.is_legal).toBe(false);
      expect(oodResult?.run_output.action).toBe('refuse');

      // Verify aggregates and gate
      expect(report.aggregates.total_cases).toBe(2);
      expect(report.aggregates.legal_cases_count).toBe(1);
      expect(report.aggregates.ood_cases_count).toBe(1);
      expect(report.aggregates.ood_refuse_rate).toBe(1.0);
      expect(report.aggregates.citation_precision).toBeGreaterThanOrEqual(0.98);
      expect(report.aggregates.hallucinated_citations_count).toBe(0);
      expect(report.aggregates.pipeline_hard_errors_count).toBe(0);

      expect(report.gate.passed).toBe(true);
      expect(report.gate.failed_metrics).toHaveLength(0);

      // Verify files written
      expect(report.report_json_path).toBeDefined();
      expect(fs.existsSync(report.report_json_path!)).toBe(true);
      expect(report.report_md_path).toBeDefined();
      expect(fs.existsSync(report.report_md_path!)).toBe(true);
    });
  });
});
