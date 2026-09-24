import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { judgeRun, parseJudgeJson, type JudgeInputChunk } from '../../lib/llmops/eval/judge';
import {
  evaluateGates,
  compareBaseline,
  runJudgeScorers,
  type EvalAggregates,
  type GateEvaluationResult,
  type JudgeScorersReportInput,
} from '../../lib/llmops/eval/gates';
import { runBaselineComparison, findLatestReport } from '../../scripts/eval_compare_baseline';
import { setLogSink, type LlmopsLogEnvelope } from '../../lib/llmops/logging/logger';
import { LLMOPS_EVENTS } from '../../lib/llmops/logging/events';

describe('Groq LLM-as-Judge & Quality Gates (judge.test.ts)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setLogSink(null);
    vi.restoreAllMocks();
  });

  describe('1. parseJudgeJson Unit Tests (Fence-strip & Brace-rescue)', () => {
    it('parses direct strict JSON', () => {
      const raw = '{"score": 0.95, "rationale": "Fully grounded in Article 122", "flags": []}';
      const res = parseJudgeJson(raw);
      expect(res).toEqual({
        score: 0.95,
        rationale: 'Fully grounded in Article 122',
        flags: [],
      });
    });

    it('strips markdown code fences (```json ... ```)', () => {
      const raw = '```json\n{"score": 0.85, "rationale": "Partially grounded", "flags": ["minor_extrapolation"]}\n```';
      const res = parseJudgeJson(raw);
      expect(res).toEqual({
        score: 0.85,
        rationale: 'Partially grounded',
        flags: ['minor_extrapolation'],
      });
    });

    it('strips generic code fences (``` ... ```)', () => {
      const raw = '```\n{"score": 0.7, "rationale": "Missing details", "flags": []}\n```';
      const res = parseJudgeJson(raw);
      expect(res).toEqual({
        score: 0.7,
        rationale: 'Missing details',
        flags: [],
      });
    });

    it('recovers JSON surrounded by conversational text via brace-rescue', () => {
      const raw =
        'Here is the evaluation result you requested:\n\n{"score": 0.9, "rationale": "Supported by law 12", "flags": ["law_verified"]}\n\nHope this is helpful!';
      const res = parseJudgeJson(raw);
      expect(res).toEqual({
        score: 0.9,
        rationale: 'Supported by law 12',
        flags: ['law_verified'],
      });
    });

    it('clamps scores between 0.0 and 1.0', () => {
      const tooHigh = parseJudgeJson('{"score": 1.5, "rationale": "over", "flags": []}');
      expect(tooHigh?.score).toBe(1.0);

      const tooLow = parseJudgeJson('{"score": -0.5, "rationale": "under", "flags": []}');
      expect(tooLow?.score).toBe(0.0);
    });

    it('returns null for non-JSON, invalid JSON, or missing numeric score', () => {
      expect(parseJudgeJson('')).toBeNull();
      expect(parseJudgeJson('I decline to answer in JSON format.')).toBeNull();
      expect(parseJudgeJson('{"score": "not-a-number"}')).toBeNull();
      expect(parseJudgeJson('{"rationale": "missing score"}')).toBeNull();
      expect(parseJudgeJson('{"score": NaN}')).toBeNull();
    });
  });

  describe('2. judgeRun LLM Adapter (Mocked Fetch & Key Constraints)', () => {
    const mockChunks: JudgeInputChunk[] = [
      {
        id: 'chunk-122',
        article_number: '122',
        title: 'قانون العمل - الفصل التعسفي',
        text: 'إذا أنهى صاحب العمل العقد غير محدد المدة دون مبرر مشروع يلتزم بتعويض العامل بما لا يقل عن أجر شهرين عن كل سنة.',
      },
    ];

    it('skips without throwing when GROQ_API_KEY is unset or empty', async () => {
      vi.stubEnv('GROQ_API_KEY', '');
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const res = await judgeRun({
        prompt: 'ما تعويض الفصل التعسفي؟',
        answer: 'التعويض شهرين عن كل سنة وفق المادة 122.',
        retrievedChunks: mockChunks,
        rubric: 'faithfulness',
      });

      expect(res.skipped).toBe(true);
      expect(res.score).toBe(0);
      expect(res.rationale).toBe('GROQ_API_KEY unset');
      expect(res.flags).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('executes successful faithfulness evaluation with strict parameters', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key-do-not-log');
      vi.stubEnv('LLM_JUDGE_MODEL', 'qwen/qwen3.8-27b');

      let capturedPayload: unknown = null;
      let capturedAuth: string | null = null;

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        expect(url).toContain('api.groq.com');
        const headers = init?.headers as Record<string, string>;
        capturedAuth = headers?.Authorization ?? null;
        capturedPayload = JSON.parse((init?.body as string) || '{}');

        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    score: 0.95,
                    rationale: 'Answer accurately cites Article 122 compensation rule without extrapolation.',
                    flags: [],
                  }),
                },
              },
            ],
          }),
        };
      });

      const res = await judgeRun({
        prompt: 'ما تعويض الفصل التعسفي وفق القانون؟',
        answer: 'يلتزم صاحب العمل بتعويض شهرين عن كل سنة خدمة وفقاً للمادة 122 من قانون العمل.',
        retrievedChunks: mockChunks,
        rubric: 'faithfulness',
      });

      expect(res.skipped).toBe(false);
      expect(res.score).toBe(0.95);
      expect(res.rationale).toContain('Article 122');
      expect(res.flags).toEqual([]);

      // Verify Groq API call contract
      expect(capturedAuth).toBe('Bearer mock-test-key-do-not-log');
      const payload = capturedPayload as {
        model: string;
        temperature: number;
        response_format: { type: string };
        messages: Array<{ role: string; content: string }>;
      };
      expect(payload.model).toBe('qwen/qwen3.8-27b');
      expect(payload.temperature).toBe(0);
      expect(payload.response_format).toEqual({ type: 'json_object' });

      // Verify system prompt contains hard legal constraints
      const sysMsg = payload.messages.find((m) => m.role === 'system')?.content || '';
      expect(sysMsg).toContain('Judge ONLY and STRICTLY based on the provided Retrieved Context');
      expect(sysMsg).toContain('FORBIDDEN from using your own external legal knowledge');
      expect(sysMsg).toContain('STRICT, VALID JSON ONLY');
    });

    it('executes completeness rubric evaluation', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  score: 1.0,
                  rationale: 'Fully addresses both elements of inquiry.',
                  flags: [],
                }),
              },
            },
          ],
        }),
      });

      const res = await judgeRun({
        prompt: 'هل يجوز إنهاء العقد وما هو التعويض؟',
        answer: 'لا يجوز بدون مبرر مشروع والتعويض شهرين عن كل سنة.',
        retrievedChunks: mockChunks,
        rubric: 'completeness',
      });

      expect(res.skipped).toBe(false);
      expect(res.score).toBe(1.0);
    });

    it('returns skipped on unparseable JSON without throwing', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Unexpected model output without JSON braces',
              },
            },
          ],
        }),
      });

      const res = await judgeRun({
        prompt: 'test',
        answer: 'test',
        retrievedChunks: mockChunks,
        rubric: 'faithfulness',
      });

      expect(res.skipped).toBe(true);
      expect(res.score).toBe(0);
      expect(res.rationale).toBe('judge_parse_error');
    });

    it('returns skipped on HTTP error response (e.g. 500 / 429)', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key');

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const res = await judgeRun({
        prompt: 'test',
        answer: 'test',
        retrievedChunks: mockChunks,
        rubric: 'faithfulness',
      });

      expect(res.skipped).toBe(true);
      expect(res.rationale).toBe('judge_http_500');
    });

    it('returns skipped on network failure without throwing', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key');

      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED connect to Groq'));

      const res = await judgeRun({
        prompt: 'test',
        answer: 'test',
        retrievedChunks: mockChunks,
        rubric: 'faithfulness',
      });

      expect(res.skipped).toBe(true);
      expect(res.rationale).toContain('ECONNREFUSED');
    });

    it('returns skipped on Abort timeout without throwing', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key');

      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      global.fetch = vi.fn().mockRejectedValue(abortError);

      const res = await judgeRun({
        prompt: 'test',
        answer: 'test',
        retrievedChunks: mockChunks,
        rubric: 'faithfulness',
      });

      expect(res.skipped).toBe(true);
      expect(res.rationale).toBe('judge_timeout');
    });
  });

  describe('3. Baseline Regression Thresholds (gates.ts compareBaseline)', () => {
    const baseAgg: EvalAggregates = {
      total_cases: 20,
      legal_cases_count: 15,
      ood_cases_count: 5,
      guard_precision: 1.0,
      guard_recall: 1.0,
      guard_ood_recall: 1.0,
      ood_refuse_rate: 1.0,
      emotional_legal_false_reject_count: 0,
      retrieval_recall_at_5: 0.9,
      citation_precision: 1.0,
      hallucinated_citations_count: 0,
      pipeline_hard_errors_count: 0,
      ttft_p50: 500,
    };

    it('passes when current metrics match or exceed baseline', () => {
      const current = { aggregates: { ...baseAgg, citation_precision: 1.0 } };
      const baseline = { aggregates: baseAgg };

      const comparison = compareBaseline(current, baseline);
      expect(comparison.passed).toBe(true);
      expect(comparison.failed_metrics).toHaveLength(0);
    });

    it('fails when citation_precision drops > 2pp (> 0.02)', () => {
      // 1.0 -> 0.975 (drop of 2.5pp -> fail)
      const current = { aggregates: { ...baseAgg, citation_precision: 0.975 } };
      const baseline = { aggregates: baseAgg };

      const comparison = compareBaseline(current, baseline);
      expect(comparison.passed).toBe(false);
      expect(comparison.failed_metrics.some((f) => f.metric === 'citation_precision')).toBe(true);

      // 1.0 -> 0.985 (drop of 1.5pp <= 2.0pp -> pass)
      const tolerantCurrent = { aggregates: { ...baseAgg, citation_precision: 0.985 } };
      const tolerantComp = compareBaseline(tolerantCurrent, baseline);
      expect(tolerantComp.passed).toBe(true);
    });

    it('fails when hallucinated_citations_count increases', () => {
      const current = { aggregates: { ...baseAgg, hallucinated_citations_count: 1 } };
      const baseline = { aggregates: baseAgg };

      const comparison = compareBaseline(current, baseline);
      expect(comparison.passed).toBe(false);
      expect(comparison.failed_metrics.some((f) => f.metric === 'hallucinated_citations_count')).toBe(true);
    });

    it('fails when guard_ood_recall drops > 1pp (> 0.01)', () => {
      // 1.0 -> 0.985 (drop of 1.5pp -> fail)
      const current = { aggregates: { ...baseAgg, guard_ood_recall: 0.985, ood_refuse_rate: 0.985 } };
      const baseline = { aggregates: baseAgg };

      const comparison = compareBaseline(current, baseline);
      expect(comparison.passed).toBe(false);
      expect(comparison.failed_metrics.some((f) => f.metric === 'guard_ood_recall')).toBe(true);
    });
  });

  describe('4. Baseline Compare CLI & Quality Drop Alert Logging (eval_compare_baseline.ts)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakmdar-eval-compare-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('logs ai.alert.quality_drop and fails on regression', () => {
      const baselineFile = path.join(tmpDir, 'baseline.json');
      const reportFile = path.join(tmpDir, 'report.json');

      const baselineData = {
        aggregates: {
          citation_precision: 1.0,
          hallucinated_citations_count: 0,
          guard_ood_recall: 1.0,
          ood_refuse_rate: 1.0,
          total_cases: 10,
        },
      };

      const regressedData = {
        aggregates: {
          citation_precision: 0.94, // 6pp drop (> 2pp)
          hallucinated_citations_count: 2, // increase from 0
          guard_ood_recall: 0.95, // 5pp drop (> 1pp)
          ood_refuse_rate: 0.95,
          total_cases: 10,
        },
      };

      fs.writeFileSync(baselineFile, JSON.stringify(baselineData));
      fs.writeFileSync(reportFile, JSON.stringify(regressedData));

      const emittedAlerts: LlmopsLogEnvelope[] = [];
      setLogSink((_line, env) => {
        if (env.event === LLMOPS_EVENTS.ALERT_QUALITY_DROP) {
          emittedAlerts.push(env);
        }
      });

      const result = runBaselineComparison({
        reportPath: reportFile,
        baselinePath: baselineFile,
        silent: true,
      });

      expect(result.passed).toBe(false);
      expect(result.failed_metrics.length).toBeGreaterThanOrEqual(3);

      // Verify ai.alert.quality_drop was logged for each failure
      expect(emittedAlerts.length).toBeGreaterThanOrEqual(3);
      const metricsLogged = emittedAlerts.map((e) => (e.data?.metric as string) || '');
      expect(metricsLogged).toContain('citation_precision');
      expect(metricsLogged).toContain('hallucinated_citations_count');
      expect(metricsLogged).toContain('guard_ood_recall');
    });

    it('--update-baseline overwrites baseline with current report', () => {
      const baselineFile = path.join(tmpDir, 'baseline.json');
      const reportFile = path.join(tmpDir, 'report.json');

      const initialReport = {
        aggregates: {
          citation_precision: 0.99,
          hallucinated_citations_count: 0,
          guard_ood_recall: 1.0,
          total_cases: 10,
        },
      };

      fs.writeFileSync(reportFile, JSON.stringify(initialReport));

      const result = runBaselineComparison({
        reportPath: reportFile,
        baselinePath: baselineFile,
        updateBaseline: true,
        silent: true,
      });

      expect(result.passed).toBe(true);
      expect(result.updated).toBe(true);
      expect(fs.existsSync(baselineFile)).toBe(true);

      const savedBaseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
      expect(savedBaseline.aggregates.citation_precision).toBe(0.99);
    });
  });

  describe('5. runJudgeScorers & Gate Integration (gates.ts)', () => {
    it('evaluates results with retrieved context and records faithfulness_avg', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  score: 0.9,
                  rationale: 'Faithful and grounded',
                  flags: [],
                }),
              },
            },
          ],
        }),
      });

      const report: JudgeScorersReportInput = {
        results: [
          {
            id: 'case-legal',
            pass: true,
            scores: {},
            run_output: {
              text: 'المادة 122 تقرر التعويض شهرين.',
              prompt: 'ما تعويض الفصل؟',
              retrieved_chunks: [
                {
                  id: 'c1',
                  article_number: '122',
                  title: 'قانون العمل',
                  text: 'الفصل التعسفي يستوجب تعويض شهرين عن كل سنة.',
                },
              ],
            },
          },
          {
            id: 'case-ood',
            pass: true,
            scores: {},
            run_output: {
              text: 'هذا السؤال خارج نطاق القانون المصري.',
              prompt: 'كيف أصلح سيارتي؟',
              retrieved_chunks: [], // No retrieved chunks -> skipped
            },
          },
        ],
        aggregates: {
          total_cases: 2,
          legal_cases_count: 1,
          ood_cases_count: 1,
          guard_precision: 1.0,
          guard_recall: 1.0,
          guard_ood_recall: 1.0,
          ood_refuse_rate: 1.0,
          emotional_legal_false_reject_count: 0,
          retrieval_recall_at_5: 1.0,
          citation_precision: 1.0,
          hallucinated_citations_count: 0,
          pipeline_hard_errors_count: 0,
          ttft_p50: 300,
        },
        gate: {
          passed: true,
          gate_profile: 'full' as const,
          warnings: [],
          failed_metrics: [],
        },
      };

      await runJudgeScorers(report);

      expect(report.results[0].scores.faithfulness_judge).toBeDefined();
      expect(report.results[0].scores.completeness_judge).toBeDefined();
      // Case 2 had no chunks -> judge scorers not added
      expect(report.results[1].scores.faithfulness_judge).toBeUndefined();

      expect(report.aggregates.faithfulness_avg).toBe(0.9);
      expect(report.aggregates.completeness_avg).toBe(0.9);
      expect(report.gate.passed).toBe(true);
    });

    it('records waiver and does not fail gate when judges are skipped (no GROQ_API_KEY / pre_judge fallback)', async () => {
      vi.stubEnv('GROQ_API_KEY', ''); // Unset key

      const report: JudgeScorersReportInput = {
        results: [
          {
            id: 'case-1',
            pass: true,
            scores: {},
            run_output: {
              text: 'إجابة قانونية',
              prompt: 'سؤال قانوني',
              retrieved_chunks: [{ id: 'c1', text: 'نص قانوني' }],
            },
          },
        ],
        aggregates: {
          total_cases: 1,
          legal_cases_count: 1,
          ood_cases_count: 0,
          guard_precision: 1.0,
          guard_recall: 1.0,
          guard_ood_recall: 1.0,
          ood_refuse_rate: 1.0,
          emotional_legal_false_reject_count: 0,
          retrieval_recall_at_5: 1.0,
          citation_precision: 1.0,
          hallucinated_citations_count: 0,
          pipeline_hard_errors_count: 0,
          ttft_p50: 300,
        },
        gate: {
          passed: true,
          gate_profile: 'pre_judge' as const,
          warnings: [],
          failed_metrics: [],
        },
      };

      await runJudgeScorers(report);

      // Skipped judges must be recorded in scores
      const fJudge = report.results[0].scores.faithfulness_judge as { details?: { skipped?: boolean } };
      expect(fJudge?.details?.skipped).toBe(true);

      // Gate must not fail under pre_judge fallback
      expect(report.gate.passed).toBe(true);
      expect(report.gate.waivers).toBeDefined();
      expect(report.gate.waivers?.length).toBeGreaterThan(0);
      expect(report.gate.warnings.some((w) => w.includes('LLM judges'))).toBe(true);
    });

    it('fails full gate if faithfulness_avg is below threshold (0.80)', async () => {
      vi.stubEnv('GROQ_API_KEY', 'mock-test-key');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  score: 0.65, // Below 0.80 threshold
                  rationale: 'Substantial extrapolation detected',
                  flags: ['unsupported_citation'],
                }),
              },
            },
          ],
        }),
      });

      const report: JudgeScorersReportInput = {
        results: [
          {
            id: 'case-unfaithful',
            pass: true,
            scores: {},
            run_output: {
              text: 'إجابة بها ادعاءات غير مدعومة',
              retrieved_chunks: [{ id: 'c1', text: 'نص قانوني أصلي' }],
            },
          },
        ],
        aggregates: {
          total_cases: 1,
          legal_cases_count: 1,
          ood_cases_count: 0,
          guard_precision: 1.0,
          guard_recall: 1.0,
          guard_ood_recall: 1.0,
          ood_refuse_rate: 1.0,
          emotional_legal_false_reject_count: 0,
          retrieval_recall_at_5: 1.0,
          citation_precision: 1.0,
          hallucinated_citations_count: 0,
          pipeline_hard_errors_count: 0,
          ttft_p50: 300,
        },
        gate: {
          passed: true,
          gate_profile: 'full' as const,
          warnings: [],
          failed_metrics: [],
        },
      };

      await runJudgeScorers(report);

      expect(report.aggregates.faithfulness_avg).toBe(0.65);
      expect(report.gate.passed).toBe(false);
      expect(report.gate.failed_metrics.some((f) => f.metric === 'faithfulness_avg')).toBe(true);
    });
  });
});
