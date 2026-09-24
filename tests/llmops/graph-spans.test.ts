import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}));

import { createServerClient } from '@/lib/supabase';
import { runCaseDeep, resumeCaseDeep } from '@/lib/ai/agents/graph';
import { memoryCheckpointStore } from '@/lib/ai/agents/checkpoint';
import type { LegalGraphState } from '@/lib/ai/agents/types';
import * as providerModule from '@/lib/llmops/tracing/provider';
import type { Span, TracingProvider } from '@/lib/llmops/tracing/provider';
import { runStore } from '@/lib/llmops/runs/store';
import { feedbackStore } from '@/lib/llmops/feedback/api';
import { langMemStore } from '@/lib/llmops/feedback/langmem/store';
import { POST as reviewHandler } from '@/app/api/ai/cases/[id]/review/route';
import { runSuite } from '@/lib/llmops/eval/runner';

describe('LLMOps-C: Graph Spans, HITL Feedback, and Case-Deep Suite', () => {
  const capturedSpans: Span[] = [];

  class MockCaptureTracer implements TracingProvider {
    readonly name = 'mock-capture';

    startSpan(name: string, attrs?: Record<string, unknown>, parentId?: string | null): Span {
      const span: Span = {
        id: `span_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        traceId: (attrs?.trace_id as string) || 'test-trace-id',
        parentId: parentId ?? null,
        name,
        startTime: Date.now(),
        attributes: { ...(attrs || {}) },
        status: 'unset',
        events: [],
      };
      capturedSpans.push(span);
      return span;
    }

    endSpan(span: Span, status?: 'ok' | 'error') {
      span.status = status ?? 'ok';
      span.endTime = Date.now();
    }
  }

  beforeEach(async () => {
    capturedSpans.length = 0;
    vi.clearAllMocks();
    // Per-worker isolated stores (parallel workers share defaults otherwise).
    const uniq = `${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    runStore.useFile(path.join(os.tmpdir(), `hakmdar_runs_${uniq}.jsonl`));
    feedbackStore.useFile(path.join(os.tmpdir(), `hakmdar_fb_${uniq}.jsonl`));
    langMemStore.setFilePath(path.join(os.tmpdir(), `hakmdar_mem_${uniq}.jsonl`));
    await runStore.clear();
    await feedbackStore.clear();
    await langMemStore.clear();
  });


  afterEach(async () => {
    vi.restoreAllMocks();
    providerModule.resetTracer();
    await runStore.clear();
    await feedbackStore.clear();
    await langMemStore.clear();
  });

  describe('Part 1: Node Span Instrumentation in runCaseDeep and finalize', () => {
    it('captures spans for every graph node with chunk_ids and evidence_score on retrieve & synthesize', async () => {
      const mockTracer = new MockCaptureTracer();
      vi.spyOn(providerModule, 'getTracer').mockReturnValue(mockTracer);

      const initialState: LegalGraphState = {
        trace_id: 'trace-spans-test-101',
        run_id: 'run-spans-test-101',
        raw_query: 'فصلني المدير تعسفياً بدون أي إنذار مسبق وأطالب بتعويض المادة 122',
        normalized_query: '',
        guard_pre: null,
        route_plan: null,
        retrieved_chunks: [],
        specialist_outputs: {},
        citations: [],
        hitl: { status: 'pending' },
        timings: [],
      };

      // 1. Run up to HITL checkpoint
      const pausedState = await runCaseDeep(initialState);
      expect(pausedState.hitl.status).toBe('awaiting_review');

      const spanNames = capturedSpans.map((s) => s.name);

      // Verify node spans were created
      expect(spanNames).toContain('ai.guard_pre');
      expect(spanNames).toContain('ai.graph.route_plan');
      expect(spanNames).toContain('ai.retrieve');
      expect(spanNames).toContain('ai.graph.statutory');
      expect(spanNames).toContain('ai.graph.synthesize');
      expect(spanNames).toContain('ai.hitl');

      // Verify retrieve span attributes (chunk_ids + evidence_score)
      const retrieveSpan = capturedSpans.find((s) => s.name === 'ai.retrieve');
      expect(retrieveSpan).toBeDefined();
      expect(Array.isArray(retrieveSpan?.attributes.chunk_ids)).toBe(true);
      expect(typeof retrieveSpan?.attributes.evidence_score).toBe('number');

      // Verify synthesize span attributes (chunk_ids + evidence_score)
      const synthSpan = capturedSpans.find((s) => s.name === 'ai.graph.synthesize');
      expect(synthSpan).toBeDefined();
      expect(Array.isArray(synthSpan?.attributes.chunk_ids)).toBe(true);
      expect(typeof synthSpan?.attributes.evidence_score).toBe('number');

      // Verify all spans completed successfully
      for (const span of capturedSpans) {
        expect(span.status).toBe('ok');
      }

      // 2. Resume through finalize
      const preFinalizeCount = capturedSpans.length;
      const finalizedState = await resumeCaseDeep(pausedState, {
        decision: 'approve',
        notes: 'معتمدة بالكامل ومطابقة للمادة 122',
        reviewer_id: 'lawyer-42',
      });

      expect(finalizedState.hitl.status).toBe('approved');
      expect(capturedSpans.length).toBeGreaterThan(preFinalizeCount);

      // Verify finalize span was created
      const finalizeSpan = capturedSpans.find((s) => s.name === 'ai.graph.finalize');
      expect(finalizeSpan).toBeDefined();
      expect(finalizeSpan?.attributes.node_name).toBe('finalize');
      expect(finalizeSpan?.attributes.decision).toBe('approve');
      expect(finalizeSpan?.status).toBe('ok');
    });
  });

  describe('Part 2: Review Endpoint -> Feedback Mapping with Trace ID', () => {
    it('writes feedback record with kind="accepted" and lawyer persona upon approve', async () => {
      const trace_id = 'trace-fb-approve-1';
      const run_id = 'run-fb-approve-1';

      // Seed paused checkpoint in memory store
      const pausedState: LegalGraphState = {
        trace_id,
        run_id,
        raw_query: 'فصل تعسفي بموجب المادة 122',
        normalized_query: 'فصل تعسفي بموجب المادة 122',
        guard_pre: null,
        route_plan: null,
        retrieved_chunks: [],
        specialist_outputs: {},
        draft_answer: 'مذكرة استشارية مطابقة للمادة 122',
        citations: [],
        hitl: { status: 'awaiting_review', checkpoint_id: 'chk-fb-1' },
        timings: [],
      };
      await memoryCheckpointStore.set('chk-fb-1', pausedState);

      // Mock lawyer Supabase user
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'lawyer-test-1', user_metadata: { role: 'lawyer' } } },
            error: null,
          }),
        },
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-test-1/review', {
        method: 'POST',
        body: JSON.stringify({
          checkpoint_id: 'chk-fb-1',
          decision: 'approve',
          notes: 'موافقة المحامي المشرف',
        }),
      });

      const res = await reviewHandler(req, { params: Promise.resolve({ id: 'case-test-1' }) });
      expect(res.status).toBe(200);

      // Verify feedback was persisted in feedbackStore
      const feedbackRecords = await feedbackStore.listFeedback({ trace_id });
      expect(feedbackRecords.length).toBe(1);

      const fb = feedbackRecords[0];
      expect(fb.trace_id).toBe(trace_id);
      expect(fb.kind).toBe('accepted');
      expect(fb.persona).toBe('lawyer');
      expect(fb.case_id).toBe('case-test-1');
      expect(fb.user_id).toBe('lawyer-test-1');
    });

    it('writes feedback record with kind="corrected" and correction_text upon modify', async () => {
      const trace_id = 'trace-fb-modify-2';
      const run_id = 'run-fb-modify-2';

      const pausedState: LegalGraphState = {
        trace_id,
        run_id,
        raw_query: 'فصل تعسفي بموجب المادة 122',
        normalized_query: 'فصل تعسفي بموجب المادة 122',
        guard_pre: null,
        route_plan: null,
        retrieved_chunks: [],
        specialist_outputs: {},
        draft_answer: 'مسودة أولية',
        citations: [],
        hitl: { status: 'awaiting_review', checkpoint_id: 'chk-fb-2' },
        timings: [],
      };
      await memoryCheckpointStore.set('chk-fb-2', pausedState);

      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'lawyer-test-2', user_metadata: { role: 'lawyer' } } },
            error: null,
          }),
        },
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const modifiedText = 'المسودة المعدلة بدقة وإضافة أجر شهرين عن كل سنة خدمة';
      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-test-2/review', {
        method: 'POST',
        body: JSON.stringify({
          checkpoint_id: 'chk-fb-2',
          decision: 'modify',
          notes: 'تعديل الصياغة',
          modified_draft: modifiedText,
        }),
      });

      const res = await reviewHandler(req, { params: Promise.resolve({ id: 'case-test-2' }) });
      expect(res.status).toBe(200);

      const feedbackRecords = await feedbackStore.listFeedback({ trace_id });
      expect(feedbackRecords.length).toBe(1);

      const fb = feedbackRecords[0];
      expect(fb.trace_id).toBe(trace_id);
      expect(fb.kind).toBe('corrected');
      expect(fb.persona).toBe('lawyer');
      expect(fb.correction_text).toBe(modifiedText);
    });

    it('writes feedback record with kind="rejected" upon reject', async () => {
      const trace_id = 'trace-fb-reject-3';
      const run_id = 'run-fb-reject-3';

      const pausedState: LegalGraphState = {
        trace_id,
        run_id,
        raw_query: 'فصل تعسفي بموجب المادة 122',
        normalized_query: 'فصل تعسفي بموجب المادة 122',
        guard_pre: null,
        route_plan: null,
        retrieved_chunks: [],
        specialist_outputs: {},
        draft_answer: 'مسودة مرفوضة',
        citations: [],
        hitl: { status: 'awaiting_review', checkpoint_id: 'chk-fb-3' },
        timings: [],
      };
      await memoryCheckpointStore.set('chk-fb-3', pausedState);

      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'lawyer-test-3', user_metadata: { role: 'lawyer' } } },
            error: null,
          }),
        },
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-test-3/review', {
        method: 'POST',
        body: JSON.stringify({
          checkpoint_id: 'chk-fb-3',
          decision: 'reject',
          notes: 'غير صالحة قانوناً لعدم كفاية المستندات',
        }),
      });

      const res = await reviewHandler(req, { params: Promise.resolve({ id: 'case-test-3' }) });
      expect(res.status).toBe(200);

      const feedbackRecords = await feedbackStore.listFeedback({ trace_id });
      expect(feedbackRecords.length).toBe(1);

      const fb = feedbackRecords[0];
      expect(fb.trace_id).toBe(trace_id);
      expect(fb.kind).toBe('rejected');
      expect(fb.persona).toBe('lawyer');
      expect(fb.correction_text).toBe('غير صالحة قانوناً لعدم كفاية المستندات');
    });
  });

  describe('Part 3: case_deep Suite Runner on Inline 2-Case Suite', () => {
    it('passes case_deep gate on 2-case inline suite (HITL interrupted + precision >= 0.98 + 0 hallucinated)', async () => {
      const inlineSuite = [
        {
          id: 'inline-deep-labor-1',
          version: 1,
          persona: 'lawyer',
          domain: 'labor',
          language: 'ar',
          register: 'formal',
          mode_target: 'case_deep',
          category: 'labor',
          question_ar: 'فصلني المدير تعسفياً بدون أي إنذار مسبق وأطالب بتعويض المادة 122',
          prompt: 'فصلني المدير تعسفياً بدون أي إنذار مسبق وأطالب بتعويض المادة 122',
          is_legal: true,
          expect_is_legal: true,
          expect_domain: 'labor',
          expect_mapped_concepts_any_of: ['فصل تعسفي', 'إنهاء علاقة عمل'],
          expected_article_anchor: ['م 122', 'م 69'],
          expected_sources: {
            must_cite_any_of: [
              { law: 'قانون العمل رقم 12 لسنة 2003', year: 2003, articles: ['122', '69'] }
            ],
            retrieval_must_include_any: ['م 122', '122'],
            must_not_cite_articles: []
          },
          must_refuse: false,
          allow_disclaimer: false,
          require_disclaimer: false,
          require_hitl: true,
          hitl_decision: 'approve',
          hitl_notes: 'معتمدة بالكامل',
          max_ttft_ms: 5000,
          min_citation_precision: 1.0,
          forbidden_phrases: ['تشخيص نهائي'],
          notes: 'حالة عمالية تتطلب تدخلاً بشرياً وموافقة'
        },
        {
          id: 'inline-deep-ood-2',
          version: 1,
          persona: 'client',
          domain: null,
          language: 'ar',
          register: 'colloquial',
          mode_target: 'case_deep',
          category: 'ood',
          question_ar: 'طريقة عمل المكرونة بالبشاميل ومقادير الصلصة واللحمة المفرومة',
          prompt: 'طريقة عمل المكرونة بالبشاميل ومقادير الصلصة واللحمة المفرومة',
          is_legal: false,
          expect_is_legal: false,
          expect_domain: null,
          expect_mapped_concepts_any_of: [],
          expected_sources: {
            must_cite_any_of: [],
            retrieval_must_include_any: [],
            must_not_cite_articles: []
          },
          must_refuse: true,
          allow_disclaimer: false,
          require_disclaimer: false,
          require_hitl: false,
          max_ttft_ms: 5000,
          min_citation_precision: 1.0,
          forbidden_phrases: [],
          notes: 'استفسار غير قانوني يُرفض مباشرة'
        }
      ];

      const tempSuitePath = path.resolve(process.cwd(), 'evaluation/temp_inline_case_deep.json');
      fs.writeFileSync(tempSuitePath, JSON.stringify(inlineSuite, null, 2), 'utf-8');

      try {
        const report = await runSuite(tempSuitePath, {
          gateProfile: 'case_deep',
          silent: true,
        });

        expect(report.gate.passed).toBe(true);
        expect(report.gate.failed_metrics.length).toBe(0);
        expect(report.aggregates.total_cases).toBe(2);
        expect(report.aggregates.legal_cases_count).toBe(1);
        expect(report.aggregates.ood_cases_count).toBe(1);
        expect(report.aggregates.ood_refuse_rate).toBe(1.0);
        expect(report.aggregates.citation_precision).toBeGreaterThanOrEqual(0.98);
        expect(report.aggregates.hallucinated_citations_count).toBe(0);
        expect(report.aggregates.hitl_interrupt_rate).toBe(1.0);
        expect(report.aggregates.hitl_interrupted_count).toBe(1);
        expect(report.aggregates.hitl_cases_count).toBe(1);
      } finally {
        if (fs.existsSync(tempSuitePath)) {
          fs.unlinkSync(tempSuitePath);
        }
      }
    });
  });
});
