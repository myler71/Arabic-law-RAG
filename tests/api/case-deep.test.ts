import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}));

import { createServerClient } from '@/lib/supabase';
import { runCaseDeep, resumeCaseDeep } from '@/lib/ai/agents/graph';
import { memoryCheckpointStore } from '@/lib/ai/agents/checkpoint';
import type { LegalGraphState } from '@/lib/ai/agents/types';
import type { LegalChunk } from '@/lib/ai/legalRag';
import { STANDARD_LEGAL_DISCLAIMER } from '@/lib/ai/safety/legalGuard';
import { POST as analyzeHandler } from '@/app/api/ai/cases/[id]/analyze/route';
import { POST as reviewHandler } from '@/app/api/ai/cases/[id]/review/route';
import { GET as traceHandler } from '@/app/api/ai/runs/[id]/trace/route';

describe('Case-Deep Multi-Agent Workflow with Lawyer HITL', () => {
  let mockSupabase: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    memoryCheckpointStore.clear?.();
  });

  const mockValidLaborChunk: LegalChunk = {
    id: 'chunk-art-122',
    article_number: 'المادة 122',
    law_name: 'قانون العمل الموحد 12 لسنة 2003',
    title: 'التعويض عن الفصل التعسفي',
    text: 'إذا أنهى أحد الطرفين العقد دون مبرر مشروع، التزم بتعويض الطرف الآخر...',
    summary: 'التعويض عن الفصل التعسفي لا يقل عن أجر شهرين عن كل سنة من سنوات الخدمة.',
    keywords: ['فصل تعسفي', 'تعويض'],
    category: 'labor',
    court: 'محكمة النقض العمالية',
  };

  describe('Part 1: runCaseDeep Execution & HITL Checkpointing', () => {
    it('stops at human_review step and persists checkpoint without setting final_response', async () => {
      const initialState: LegalGraphState = {
        trace_id: 'test-trace-1',
        run_id: 'test-run-1',
        raw_query: 'صاحب الشركة طردني تعسفياً بدون سابق إنذار ورافض يديني مستحقاتي',
        normalized_query: '',
        guard_pre: null,
        route_plan: null,
        retrieved_chunks: [mockValidLaborChunk],
        specialist_outputs: {},
        citations: [],
        hitl: { status: 'pending' },
        timings: [],
      };

      const result = await runCaseDeep(initialState);

      // Graph must halt before finalization
      expect(result.hitl.status).toBe('awaiting_review');
      expect(result.hitl.checkpoint_id).toBeDefined();
      expect(typeof result.hitl.checkpoint_id).toBe('string');
      expect(result.final_response).toBeUndefined();

      // Specialists executed and attached chunk_ids
      expect(result.specialist_outputs['statutory_specialist']).toBeDefined();
      expect(result.specialist_outputs['statutory_specialist'].chunk_ids).toContain('chunk-art-122');
      expect(result.specialist_outputs['cassation_specialist']).toBeDefined();
      expect(result.specialist_outputs['procedural_specialist']).toBeDefined();

      // Draft memo synthesized
      expect(result.draft_answer).toBeDefined();
      expect(result.draft_answer).toContain('مذكرة رأي قانوني استشاري');
      expect(result.citations.length).toBeGreaterThan(0);

      // Timings recorded for each step
      const stepNames = result.timings.map((t) => t.step);
      expect(stepNames).toContain('guard_input');
      expect(stepNames).toContain('route_plan');
      expect(stepNames).toContain('retrieve');
      expect(stepNames).toContain('synthesize');
      expect(stepNames).toContain('human_review');

      // Checkpoint persisted in memory store
      const persisted = await memoryCheckpointStore.get(result.hitl.checkpoint_id!);
      expect(persisted).not.toBeNull();
      expect(persisted?.hitl.status).toBe('awaiting_review');
      expect(persisted?.trace_id).toBe('test-trace-1');
    });
  });

  describe('Part 2: Resume with Approve & Low Evidence Disclaimer', () => {
    it('produces final_response with disclaimer when evidence is low (< 0.65 threshold)', async () => {
      // Create paused state with NO retrieved chunks (evidence_score = 0)
      const pausedState: LegalGraphState = {
        trace_id: 'test-trace-low-ev',
        run_id: 'test-run-low-ev',
        raw_query: 'هل يجوز الطعن بالنقض في هذا الحكم الغريب؟',
        normalized_query: 'هل يجوز الطعن بالنقض في هذا الحكم الغريب؟',
        guard_pre: {
          is_legal: true,
          domain: 'civil',
          mapped_legal_concepts: ['طعن بالنقض'],
          applicable_laws: ['قانون المرافعات'],
          confidence: 0.9,
          reject_reason: null,
          clarification_question: null,
        },
        route_plan: {
          domain: 'civil',
          specialists: ['statutory_specialist', 'procedural_specialist'],
        },
        retrieved_chunks: [], // Empty evidence ensures low evidence score
        specialist_outputs: {},
        draft_answer: 'مذكرة رأي استشاري عامة في إجراءات الطعن المدني أمام المحكمة.',
        citations: [],
        hitl: {
          status: 'awaiting_review',
          checkpoint_id: 'chk-low-ev-1',
        },
        timings: [],
      };

      await memoryCheckpointStore.set('chk-low-ev-1', pausedState);

      const finalized = await resumeCaseDeep('chk-low-ev-1', {
        decision: 'approve',
        notes: 'معتمد مع التنبيه بقلة السوابق',
        reviewer_id: 'lawyer-test-id',
      });

      expect(finalized.hitl.status).toBe('approved');
      expect(finalized.final_response).toBeDefined();
      expect(finalized.guard_post).toBeDefined();
      expect(finalized.guard_post?.action).toBe('disclaimer');
      expect(finalized.guard_post?.evidence_score).toBeLessThan(0.65);
      expect(finalized.final_response).toContain(STANDARD_LEGAL_DISCLAIMER);
      expect(finalized.episodic_memory).toBeDefined();
      expect(finalized.episodic_memory?.action).toBe('approve');
      expect(finalized.episodic_memory?.reviewer_id).toBe('lawyer-test-id');
    });
  });

  describe('Part 3: Fabrication Guard (Anti-Hallucination)', () => {
    it('strips specialist output referencing article absent from retrieved evidence in guard_post', async () => {
      // Evidence only contains article 122
      const retrievedChunks: LegalChunk[] = [mockValidLaborChunk];

      const stateWithFabricatedArticle: LegalGraphState = {
        trace_id: 'test-trace-fab',
        run_id: 'test-run-fab',
        raw_query: 'فصلني المدير تعسفياً بدون إنذار',
        normalized_query: 'فصلني المدير تعسفيا بدون انذار',
        guard_pre: null,
        route_plan: {
          domain: 'labor',
          specialists: ['statutory_specialist'],
        },
        retrieved_chunks: retrievedChunks,
        specialist_outputs: {
          statutory_specialist: {
            specialist_name: 'statutory_specialist',
            domain: 'labor',
            chunk_ids: ['chunk-art-122'],
            findings: [
              {
                article_number: 'المادة 122',
                law_name: 'قانون العمل 12 لسنة 2003',
                chunk_ids: ['chunk-art-122'],
                finding: 'التعويض عن الفصل التعسفي شهرين عن كل سنة.',
              },
              {
                // Fabricated article 999 not in retrievedChunks!
                article_number: 'المادة 999',
                law_name: 'قانون العمل المزعوم',
                chunk_ids: ['fake-id'],
                finding: 'تطبيق المادة 999 يلزم بحبس صاحب العمل عشر سنوات.',
              },
            ],
            summary: 'نتائج البحث التشريعي',
          },
        },
        draft_answer:
          'استناداً لأحكام المادة 122 من قانون العمل، وكذلك المادة 999 من القانون، يحق للعامل المطالبة بالتعويض.',
        citations: [],
        hitl: {
          status: 'awaiting_review',
          checkpoint_id: 'chk-fab-1',
        },
        timings: [],
      };

      await memoryCheckpointStore.set('chk-fab-1', stateWithFabricatedArticle);

      const finalized = await resumeCaseDeep('chk-fab-1', {
        decision: 'approve',
      });

      // guard_post must strip fabricated "المادة 999"
      expect(finalized.final_response).not.toContain('المادة 999');
      expect(finalized.final_response).toContain('[مادة غير موثقة]');
      expect(finalized.guard_post?.unverified_citations).toBeDefined();
      expect(finalized.guard_post?.unverified_citations?.some((u) => u.includes('999'))).toBe(true);

      // Verified article 122 must remain
      expect(finalized.final_response).toContain('المادة 122');
    });
  });

  describe('Part 4: Trace Endpoint & Observability', () => {
    it('trace endpoint returns timings and chunk_ids', async () => {
      const stateWithTrace: LegalGraphState = {
        trace_id: 'trace-obs-101',
        run_id: 'run-obs-101',
        case_id: 'case-xyz',
        raw_query: 'فصل تعسفي',
        normalized_query: 'فصل تعسفي',
        guard_pre: {
          is_legal: true,
          domain: 'labor',
          mapped_legal_concepts: ['فصل تعسفي'],
          applicable_laws: ['قانون العمل 12/2003'],
          confidence: 0.95,
          reject_reason: null,
          clarification_question: null,
        },
        route_plan: {
          domain: 'labor',
          specialists: ['statutory_specialist'],
        },
        retrieved_chunks: [mockValidLaborChunk],
        specialist_outputs: {
          statutory_specialist: {
            specialist_name: 'statutory_specialist',
            domain: 'labor',
            findings: [
              {
                article_number: 'المادة 122',
                chunk_ids: ['chunk-art-122'],
                finding: 'تعويض شهرين عن كل سنة خدمة',
              },
            ],
            chunk_ids: ['chunk-art-122'],
            summary: 'نص المادة 122',
          },
        },
        draft_answer: 'مسودة رأي قانوني استشاري',
        citations: [
          {
            id: 'chunk-art-122',
            title: 'التعويض عن الفصل التعسفي',
            lawName: 'قانون العمل 12/2003',
            articleNumber: 'المادة 122',
            summary: 'تعويض الفصل التعسفي شهرين عن كل سنة خدمة',
          },
        ],
        hitl: {
          status: 'awaiting_review',
          checkpoint_id: 'chk-trace-1',
        },
        timings: [
          { step: 'guard_input', duration_ms: 5, ts: Date.now() - 100 },
          { step: 'retrieve', duration_ms: 12, ts: Date.now() - 80 },
          { step: 'synthesize', duration_ms: 8, ts: Date.now() - 40 },
        ],
      };

      await memoryCheckpointStore.set('chk-trace-1', stateWithTrace);

      const req = new NextRequest('http://localhost:3000/api/ai/runs/run-obs-101/trace');
      const res = await traceHandler(req, { params: Promise.resolve({ id: 'run-obs-101' }) });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.run_id).toBe('run-obs-101');
      expect(data.trace_id).toBe('trace-obs-101');
      expect(Array.isArray(data.timings)).toBe(true);
      expect(data.timings.length).toBe(3);
      expect(data.timings[0].step).toBe('guard_input');
      expect(data.timings[0].duration_ms).toBe(5);

      // Check citations and retrieved chunks include chunk_ids
      expect(Array.isArray(data.citations)).toBe(true);
      expect(data.citations[0].chunk_id).toBe('chunk-art-122');
      expect(data.retrieved_chunks[0].chunk_id).toBe('chunk-art-122');
    });

    it('returns 404 for unknown trace id', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/runs/nonexistent-run/trace');
      const res = await traceHandler(req, { params: Promise.resolve({ id: 'nonexistent-run' }) });
      expect(res.status).toBe(404);
    });
  });

  describe('Part 5: Role Authorization on Endpoints', () => {
    it('rejects unauthenticated requests with 401 on /analyze', async () => {
      mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('Unauthorized') }),
        },
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-1/analyze', {
        method: 'POST',
        body: JSON.stringify({ query: 'قضية تعويض' }),
      });
      const res = await analyzeHandler(req, { params: Promise.resolve({ id: 'case-1' }) });
      expect(res.status).toBe(401);
    });

    it('rejects client role with 403 on /analyze', async () => {
      mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'client-1', user_metadata: { role: 'client' } } },
            error: null,
          }),
        },
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-1/analyze', {
        method: 'POST',
        body: JSON.stringify({ query: 'قضية تعويض' }),
      });
      const res = await analyzeHandler(req, { params: Promise.resolve({ id: 'case-1' }) });
      expect(res.status).toBe(403);
    });

    it('allows lawyer role with 200 on /analyze', async () => {
      mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'lawyer-1', user_metadata: { role: 'lawyer' } } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'case-1', title: 'قضية فصل تعسفي', description: 'طردني صاحب العمل' },
                error: null,
              }),
            }),
          }),
        }),
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-1/analyze', {
        method: 'POST',
        body: JSON.stringify({ query: 'طردني صاحب العمل بدون إنذار' }),
      });
      const res = await analyzeHandler(req, { params: Promise.resolve({ id: 'case-1' }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.status).toBe('awaiting_review');
      expect(json.checkpoint_id).toBeDefined();
      expect(json.draft).toBeDefined();
    });

    it('rejects client role with 403 on /review', async () => {
      mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'client-1', user_metadata: { role: 'client' } } },
            error: null,
          }),
        },
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-1/review', {
        method: 'POST',
        body: JSON.stringify({ checkpoint_id: 'chk-1', decision: 'approve' }),
      });
      const res = await reviewHandler(req, { params: Promise.resolve({ id: 'case-1' }) });
      expect(res.status).toBe(403);
    });

    it('allows lawyer to approve and finalize on /review', async () => {
      // Pre-populate checkpoint
      const pausedState: LegalGraphState = {
        trace_id: 'trace-rev-1',
        run_id: 'run-rev-1',
        raw_query: 'فصل تعسفي',
        normalized_query: 'فصل تعسفي',
        guard_pre: null,
        route_plan: null,
        retrieved_chunks: [mockValidLaborChunk],
        specialist_outputs: {},
        draft_answer: 'مذكرة استشارية استناداً إلى المادة 122 من قانون العمل.',
        citations: [],
        hitl: { status: 'awaiting_review', checkpoint_id: 'chk-rev-1' },
        timings: [],
      };
      await memoryCheckpointStore.set('chk-rev-1', pausedState);

      mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'lawyer-1', user_metadata: { role: 'lawyer' } } },
            error: null,
          }),
        },
      };
      vi.mocked(createServerClient).mockReturnValue(mockSupabase as unknown as SupabaseClient);

      const req = new NextRequest('http://localhost:3000/api/ai/cases/case-1/review', {
        method: 'POST',
        body: JSON.stringify({ checkpoint_id: 'chk-rev-1', decision: 'approve', notes: 'ممتازة وتوافق أحكام النقض' }),
      });
      const res = await reviewHandler(req, { params: Promise.resolve({ id: 'case-1' }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.status).toBe('approved');
      expect(json.final_response).toBeDefined();
      expect(json.final_response).toContain('المادة 122');
      expect(json.episodic_memory).toBeDefined();
      expect(json.episodic_memory.notes).toBe('ممتازة وتوافق أحكام النقض');
    });
  });
});
