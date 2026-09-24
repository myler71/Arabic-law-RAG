import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import os from 'os';
import path from 'path';
import { runStore } from '@/lib/llmops/runs/store';
import { feedbackStore, submitFeedback, getFeedbackForTrace, FeedbackApiError } from '@/lib/llmops/feedback/api';
import { langMemStore } from '@/lib/llmops/feedback/langmem/store';
import { setLogSink, type LlmopsLogEnvelope } from '@/lib/llmops/logging/logger';
import { LLMOPS_EVENTS } from '@/lib/llmops/logging/events';
import { POST as feedbackPostHandler, GET as feedbackGetHandler } from '@/app/api/ai/feedback/route';
import { GET as traceGetHandler } from '@/app/api/ai/runs/[id]/trace/route';

describe('LLMOps Feedback and RunStore Integration', () => {
  const capturedLogs: LlmopsLogEnvelope[] = [];

  beforeEach(async () => {
    capturedLogs.length = 0;
    setLogSink((_, env) => {
      capturedLogs.push(env);
    });
    const uniq = `${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    runStore.useFile(path.join(os.tmpdir(), `arabic-law-rag_runs_${uniq}.jsonl`));
    feedbackStore.useFile(path.join(os.tmpdir(), `arabic-law-rag_fb_${uniq}.jsonl`));
    langMemStore.setFilePath(path.join(os.tmpdir(), `arabic-law-rag_mem_${uniq}.jsonl`));
    await runStore.clear();
    await feedbackStore.clear();
    await langMemStore.clear();
  });

  describe('Part 1: submitFeedback Core Service', () => {
    it('submits valid feedback offline: writes file store row + T0 memory item + emits log', async () => {
      // 1. Seed a run
      await runStore.startRun({
        id: 'run-alpha-1',
        trace_id: 'trace-alpha-1',
        user_id: 'user-client-1',
        persona: 'client',
        mode: 'chat_fast',
        model_id: 'groq/compound-mini',
        prompt_version: 'synth_chat@1.4.1',
      });

      // 2. Submit feedback
      const result = await submitFeedback(
        {
          trace_id: 'trace-alpha-1',
          run_id: 'run-alpha-1',
          kind: 'accepted',
          rating: 5,
          target_span: 'final_answer',
          tags: ['accurate', 'fast_response'],
          locale: 'ar',
        },
        {
          id: 'user-client-1',
          role: 'client',
        }
      );

      expect(result).toBeDefined();
      expect(typeof result.feedback_id).toBe('string');
      expect(result.feedback_id.length).toBeGreaterThan(0);

      // 3. Verify file store row
      const storedFeedback = await feedbackStore.listFeedback({ trace_id: 'trace-alpha-1' });
      expect(storedFeedback.length).toBe(1);
      expect(storedFeedback[0].id).toBe(result.feedback_id);
      expect(storedFeedback[0].kind).toBe('accepted');
      expect(storedFeedback[0].rating).toBe(5);
      expect(storedFeedback[0].target_span).toBe('final_answer');
      expect(storedFeedback[0].tags).toEqual(['accurate', 'fast_response']);

      // 4. Verify T0 episodic memory item
      const memoryItems = await langMemStore.getForRun('trace-alpha-1');
      expect(memoryItems.length).toBe(1);
      expect(memoryItems[0].tier).toBe('T0');
      expect(memoryItems[0].source_feedback_id).toBe(result.feedback_id);
      expect(memoryItems[0].content).toContain('[accepted]');
      expect(memoryItems[0].content).toContain('final_answer');

      // 5. Verify structured log emitted
      const feedbackLogs = capturedLogs.filter((l) => l.event === LLMOPS_EVENTS.FEEDBACK_RECEIVED);
      expect(feedbackLogs.length).toBe(1);
      expect(feedbackLogs[0].trace_id).toBe('trace-alpha-1');
      expect(feedbackLogs[0].run_id).toBe('run-alpha-1');
      expect(feedbackLogs[0].data.kind).toBe('accepted');
      expect(feedbackLogs[0].data.rating).toBe(5);
      expect(feedbackLogs[0].data.feedback_id).toBe(result.feedback_id);
    });

    it('handles corrected feedback with correction_text and user flagged citations', async () => {
      await runStore.startRun({
        id: 'run-beta-2',
        trace_id: 'trace-beta-2',
        user_id: 'user-client-2',
        case_id: 'case-beta-2',
        mode: 'case_deep',
      });

      const result = await submitFeedback(
        {
          trace_id: 'trace-beta-2',
          run_id: 'run-beta-2',
          kind: 'corrected',
          rating: 2,
          target_span: 'citation',
          correction_text: 'المادة 122 بدلاً من المادة 120 من قانون العمل',
          citations_user_flagged: ['chunk-bad-120'],
          tags: ['wrong_article'],
        },
        {
          id: 'user-client-2',
          role: 'client',
        }
      );

      const items = await langMemStore.getForRun('trace-beta-2');
      expect(items.length).toBe(1);
      expect(items[0].tier).toBe('T0');
      expect(items[0].content).toContain('المادة 122 بدلاً من المادة 120');

      const feedbackLogs = capturedLogs.filter((l) => l.event === LLMOPS_EVENTS.FEEDBACK_RECEIVED);
      expect(feedbackLogs.length).toBe(1);
      expect(feedbackLogs[0].data.flagged_citations_count).toBe(1);
      expect(feedbackLogs[0].data.correction_length).toBeGreaterThan(0);
    });

    it('rejects unowned trace with 403 Forbidden', async () => {
      // Run belongs to user-owner
      await runStore.startRun({
        id: 'run-owner-1',
        trace_id: 'trace-owner-1',
        user_id: 'user-owner',
      });

      // Different user attempts feedback
      await expect(
        submitFeedback(
          {
            trace_id: 'trace-owner-1',
            run_id: 'run-owner-1',
            kind: 'rejected',
            tags: ['hallucination'],
          },
          {
            id: 'user-intruder',
            role: 'client',
          }
        )
      ).rejects.toThrow(FeedbackApiError);

      try {
        await submitFeedback(
          {
            trace_id: 'trace-owner-1',
            run_id: 'run-owner-1',
            kind: 'rejected',
          },
          {
            id: 'user-intruder',
            role: 'client',
          }
        );
      } catch (err) {
        expect(err instanceof FeedbackApiError).toBe(true);
        expect((err as FeedbackApiError).status).toBe(403);
      }
    });

    it('rejects feedback for nonexistent trace with 404 Not Found', async () => {
      await expect(
        submitFeedback(
          {
            trace_id: 'ghost-trace-404',
            run_id: 'ghost-run-404',
            kind: 'accepted',
          },
          {
            id: 'user-any',
            role: 'client',
          }
        )
      ).rejects.toThrow(FeedbackApiError);
    });

    it('permits lawyer on case to submit feedback even if run user_id is client', async () => {
      await runStore.startRun({
        id: 'run-case-1',
        trace_id: 'trace-case-1',
        user_id: 'user-client-client',
        case_id: 'case-contract-10',
        mode: 'case_deep',
      });

      const result = await submitFeedback(
        {
          trace_id: 'trace-case-1',
          run_id: 'run-case-1',
          kind: 'accepted',
          rating: 4,
          persona: 'lawyer',
        },
        {
          id: 'lawyer-in-charge',
          role: 'lawyer',
        }
      );

      expect(result.feedback_id).toBeDefined();
      const records = await feedbackStore.listFeedback({ trace_id: 'trace-case-1' });
      expect(records.length).toBe(1);
      expect(records[0].persona).toBe('lawyer');
    });
  });

  describe('Part 2: POST /api/ai/feedback Route Handler', () => {
    it('returns 201 with feedback_id on valid input', async () => {
      await runStore.startRun({
        id: 'run-http-1',
        trace_id: 'trace-http-1',
        user_id: 'demo-user',
      });

      const req = new NextRequest('http://localhost:3000/api/ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trace_id: 'trace-http-1',
          run_id: 'run-http-1',
          kind: 'accepted',
          rating: 5,
          tags: ['clear_advice'],
        }),
      });

      const res = await feedbackPostHandler(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.feedback_id).toBeDefined();
    });

    it('returns 400 VALIDATION_ERROR on invalid kind', async () => {
      await runStore.startRun({
        id: 'run-http-2',
        trace_id: 'trace-http-2',
        user_id: 'demo-user',
      });

      const req = new NextRequest('http://localhost:3000/api/ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trace_id: 'trace-http-2',
          run_id: 'run-http-2',
          kind: 'not_a_valid_kind',
        }),
      });

      const res = await feedbackPostHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when missing required fields (e.g. trace_id)', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'accepted',
        }),
      });

      const res = await feedbackPostHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe('VALIDATION_ERROR');
    });

    it('returns 403 when user does not own trace', async () => {
      // Run owned by someone else
      await runStore.startRun({
        id: 'run-private-1',
        trace_id: 'trace-private-1',
        user_id: 'private-user-999',
      });

      const req = new NextRequest('http://localhost:3000/api/ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trace_id: 'trace-private-1',
          run_id: 'run-private-1',
          kind: 'rejected',
        }),
      });

      const res = await feedbackPostHandler(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe('FORBIDDEN');
    });
  });

  describe('Part 3: GET /api/ai/feedback Route Handler', () => {
    it('returns 400 when trace_id query parameter is missing', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/feedback');
      const res = await feedbackGetHandler(req);
      expect(res.status).toBe(400);
    });

    it('returns feedback list for requested trace_id', async () => {
      await runStore.startRun({
        id: 'run-get-1',
        trace_id: 'trace-get-1',
        user_id: 'demo-user',
      });

      await submitFeedback(
        {
          trace_id: 'trace-get-1',
          run_id: 'run-get-1',
          kind: 'accepted',
          rating: 4,
        },
        { id: 'demo-user', role: 'client' }
      );

      const req = new NextRequest('http://localhost:3000/api/ai/feedback?trace_id=trace-get-1');
      const res = await feedbackGetHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Array.isArray(json.feedback)).toBe(true);
      expect(json.feedback.length).toBe(1);
      expect(json.feedback[0].trace_id).toBe('trace-get-1');
    });
  });

  describe('Part 4: GET /api/ai/runs/[id]/trace Integration', () => {
    it('returns run_record and metadata from runStore when trace is queried', async () => {
      await runStore.startRun({
        id: 'run-obs-persist-1',
        trace_id: 'trace-obs-persist-1',
        user_id: 'demo-user',
        prompt_version: 'synth_chat@1.4.1',
        model_id: 'groq/compound-mini',
        rag_index_version: 'statutes-eg-labor-2026.03.1',
        guard_version: 'legal_guard@2.1.0',
        git_sha: 'ea46529',
        outcome: 'success',
        ttft_ms: 180,
        t_total_ms: 650,
        tokens_in: 250,
        tokens_out: 400,
        cost_usd_est: 0.00035,
        evidence_score: 0.95,
      });

      const req = new NextRequest('http://localhost:3000/api/ai/runs/trace-obs-persist-1/trace');
      const res = await traceGetHandler(req, {
        params: Promise.resolve({ id: 'trace-obs-persist-1' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.trace_id).toBe('trace-obs-persist-1');
      expect(data.run_id).toBe('run-obs-persist-1');
      expect(data.prompt_version).toBe('synth_chat@1.4.1');
      expect(data.model_id).toBe('groq/compound-mini');
      expect(data.tokens_in).toBe(250);
      expect(data.tokens_out).toBe(400);
      expect(data.cost_usd_est).toBe(0.00035);
      expect(data.evidence_score).toBe(0.95);
      expect(data.run_record).toBeDefined();
    });
  });
});
