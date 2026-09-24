import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newTraceId, newRunId, newSpanId, hashId } from '../../lib/llmops/ids';
import { runLlmOpsContext, getLlmOpsContext, updateLlmOpsContext } from '../../lib/llmops/context';
import { resolveVersions } from '../../lib/llmops/versions';
import { LLMOPS_EVENTS } from '../../lib/llmops/logging/events';
import { redactValue, redactDeep } from '../../lib/llmops/logging/redact';
import { llmopsLogger, setLogSink, LlmopsLogEnvelope } from '../../lib/llmops/logging/logger';
import { resolveRoute, MODEL_ROUTING_TABLE } from '../../lib/llmops/registry/models';

describe('LLMOps Foundations Scaffold', () => {
  describe('IDs (ids.ts)', () => {
    it('generates distinct UUID v4 trace and run IDs', () => {
      const trace1 = newTraceId();
      const trace2 = newTraceId();
      expect(trace1).not.toBe(trace2);
      expect(trace1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      const run1 = newRunId();
      const run2 = newRunId();
      expect(run1).not.toBe(run2);
      expect(run1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('generates 16-hex character span IDs', () => {
      const span1 = newSpanId();
      const span2 = newSpanId();
      expect(span1).not.toBe(span2);
      expect(span1).toHaveLength(16);
      expect(span1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates deterministic 12-char SHA-256 prefixes with hashId', () => {
      const hash1 = hashId('user_egypt_123');
      const hash2 = hashId('user_egypt_123');
      const hash3 = hashId('user_egypt_456');

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(12);
      expect(hash1).toMatch(/^[0-9a-f]{12}$/);
      expect(hash1).not.toBe(hash3);
    });
  });

  describe('Context (context.ts)', () => {
    it('returns safe null context outside an execution block', () => {
      const ctx = getLlmOpsContext();
      expect(ctx.trace_id).toBeNull();
      expect(ctx.run_id).toBeNull();
      expect(ctx.session_id).toBeNull();
      expect(ctx.user_id_hash).toBeNull();
      expect(ctx.persona).toBeNull();
      expect(ctx.mode).toBeNull();
      expect(ctx.route).toBeNull();
      expect(ctx.case_id).toBeNull();
    });

    it('binds context within runLlmOpsContext', () => {
      const traceId = newTraceId();
      const runId = newRunId();

      runLlmOpsContext(
        {
          trace_id: traceId,
          run_id: runId,
          persona: 'client',
          mode: 'chat_fast',
          route: '/api/ai/chat/stream',
        },
        () => {
          const ctx = getLlmOpsContext();
          expect(ctx.trace_id).toBe(traceId);
          expect(ctx.run_id).toBe(runId);
          expect(ctx.persona).toBe('client');
          expect(ctx.mode).toBe('chat_fast');
          expect(ctx.route).toBe('/api/ai/chat/stream');
        }
      );
    });

    it('inherits parent context and supports in-place updates', () => {
      const parentTrace = newTraceId();
      runLlmOpsContext({ trace_id: parentTrace, persona: 'lawyer' }, () => {
        expect(getLlmOpsContext().persona).toBe('lawyer');

        updateLlmOpsContext({ case_id: 'case_abc_123' });
        expect(getLlmOpsContext().case_id).toBe('case_abc_123');
        expect(getLlmOpsContext().trace_id).toBe(parentTrace);

        // Nested run retains parent unless overridden
        runLlmOpsContext({ mode: 'case_deep' }, () => {
          const inner = getLlmOpsContext();
          expect(inner.trace_id).toBe(parentTrace);
          expect(inner.persona).toBe('lawyer');
          expect(inner.case_id).toBe('case_abc_123');
          expect(inner.mode).toBe('case_deep');
        });
      });
    });
  });

  describe('Versions (versions.ts)', () => {
    it('resolves versions with dev defaults matching spec examples', () => {
      const versions = resolveVersions();

      expect(versions.app_git_sha).toBeDefined();
      expect(typeof versions.app_git_sha).toBe('string');
      expect(versions.prompt_version).toBe('synth_chat@1.4.1');
      expect(versions.model_id).toBe('groq/compound-mini');
      expect(versions.embed_model_id).toBe('BAAI/bge-m3@rev');
      expect(versions.rerank_model_id).toBe('BAAI/bge-reranker-v2-m3');
      expect(versions.rag_index_version).toContain('statutes-eg-labor-2026.03.1');
      expect(versions.guard_version).toBe('legal_guard@2.1.0');
      expect(versions.graph_version).toBe('legal_graph@1.0.3');
      expect(versions.eval_suite_version).toBe('eval-smoke@12');
    });

    it('accepts custom version overrides', () => {
      const custom = resolveVersions({
        prompt_version: 'guard_pre@3.2.0',
        model_id: 'qwen/qwen3.8-27b',
      });
      expect(custom.prompt_version).toBe('guard_pre@3.2.0');
      expect(custom.model_id).toBe('qwen/qwen3.8-27b');
      expect(custom.guard_version).toBe('legal_guard@2.1.0');
    });
  });

  describe('Event Catalog (events.ts)', () => {
    it('contains all mandatory L3.3 events', () => {
      const allEvents = Object.values(LLMOPS_EVENTS);

      const requiredEvents = [
        'ai.request.start',
        'ai.auth.ok',
        'ai.auth.fail',
        'ai.ratelimit.hit',
        'ai.guard_pre.start',
        'ai.guard_pre.done',
        'ai.guard_pre.refuse',
        'ai.retrieve.start',
        'ai.retrieve.done',
        'ai.retrieve.error',
        'ai.llm.start',
        'ai.llm.done',
        'ai.llm.error',
        'ai.guard_post.start',
        'ai.guard_post.done',
        'ai.stream.metadata_emitted',
        'ai.stream.first_token',
        'ai.stream.done',
        'ai.graph.node.start',
        'ai.graph.node.done',
        'ai.hitl.interrupt',
        'ai.hitl.resume',
        'ai.request.done',
        'ai.feedback.received',
        'ai.memory.write',
        'ai.memory.inject',
        'ai.eval.run.start',
        'ai.eval.run.done',
        'ai.ingest.job.start',
        'ai.ingest.job.done',
        'ai.alert.quality_drop',
      ];

      for (const event of requiredEvents) {
        expect(allEvents).toContain(event);
      }
    });
  });

  describe('Redaction (redact.ts)', () => {
    it('redacts 14-digit Egyptian national ID sequences', () => {
      const text = 'الرقم القومي للعميل هو 29801011234567 يرجى مراجعته';
      const redacted = redactValue(text);
      expect(redacted).toBe('الرقم القومي للعميل هو [REDACTED:NATIONAL_ID] يرجى مراجعته');
    });

    it('does not redact sequences of numbers that are not 14 digits', () => {
      expect(redactValue('ID 12345')).toBe('ID 12345');
      expect(redactValue('1234567890123456')).toBe('1234567890123456'); // 16 digits
    });

    it('redacts Egyptian phone numbers (Vodafone, Orange, Etisalat, WE)', () => {
      expect(redactValue('اتصل على 01012345678')).toBe('اتصل على [REDACTED:PHONE]');
      expect(redactValue('اتصل على 01198765432')).toBe('اتصل على [REDACTED:PHONE]');
      expect(redactValue('اتصل على 01234567890')).toBe('اتصل على [REDACTED:PHONE]');
      expect(redactValue('اتصل على 01511223344')).toBe('اتصل على [REDACTED:PHONE]');
      expect(redactValue('international +201012345678')).toBe('international [REDACTED:PHONE]');
      expect(redactValue('formatted 010-1234-5678')).toBe('formatted [REDACTED:PHONE]');
    });

    it('redacts email addresses', () => {
      const text = 'Send contract to ahmed.lawyer@court.eg or lawyer@example.com';
      const redacted = redactValue(text);
      expect(redacted).toBe('Send contract to [REDACTED:EMAIL] or [REDACTED:EMAIL]');
    });

    it('redacts Bearer tokens and API secret keys', () => {
      expect(redactValue('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz.123')).toBe('[REDACTED:TOKEN]');
      expect(redactValue('Authorization: Bearer secret_key_test_12345')).toBe('Authorization: [REDACTED:TOKEN]');
      expect(redactValue('API key sk-abcdef1234567890abcdef123')).toBe('API key [REDACTED:TOKEN]');
    });

    it('deeply redacts nested objects, arrays, and sensitive keys', () => {
      const payload = {
        lawyer: {
          name: 'Tarek',
          email: 'tarek@law.eg',
          phone: '01012345678',
          national_id: '29505051234567',
        },
        auth: {
          token: 'secret_jwt_token_123',
          password: 'supersecretpassword',
        },
        documents: [
          {
            notes: 'Client phone 01234567890 and email test@example.com',
          },
        ],
      };

      const redacted = redactDeep(payload);
      expect(redacted.lawyer.email).toBe('[REDACTED:EMAIL]');
      expect(redacted.lawyer.phone).toBe('[REDACTED:PHONE]');
      expect(redacted.lawyer.national_id).toBe('[REDACTED:NATIONAL_ID]');
      expect(redacted.auth.token).toBe('[REDACTED:TOKEN]');
      expect(redacted.auth.password).toBe('[REDACTED:TOKEN]');
      expect(redacted.documents[0].notes).toBe('Client phone [REDACTED:PHONE] and email [REDACTED:EMAIL]');
    });

    it('handles circular references safely in redactDeep', () => {
      const circular: Record<string, unknown> = { name: 'circular_case' };
      circular.self = circular;

      expect(() => {
        const result = redactDeep(circular);
        expect(result.name).toBe('circular_case');
        expect(result.self).toBe('[CIRCULAR]');
      }).not.toThrow();
    });
  });

  describe('Logger (logger.ts)', () => {
    let capturedLogs: { line: string; envelope: LlmopsLogEnvelope }[] = [];

    beforeEach(() => {
      capturedLogs = [];
      setLogSink((line, envelope) => {
        capturedLogs.push({ line, envelope });
      });
    });

    afterEach(() => {
      setLogSink(null);
    });

    it('emits valid JSON envelope with L3.2 fields and binds context automatically', () => {
      const traceId = newTraceId();
      const runId = newRunId();

      runLlmOpsContext(
        {
          trace_id: traceId,
          run_id: runId,
          persona: 'client',
          mode: 'chat_fast',
          route: '/api/ai/chat/stream',
        },
        () => {
          llmopsLogger.info(LLMOPS_EVENTS.REQUEST_START, {
            duration_ms: 45,
            outcome: 'success',
            msg: 'Incoming chat request',
            message_len: 120,
            user_phone: '01012345678',
          });
        }
      );

      expect(capturedLogs).toHaveLength(1);
      const { line, envelope } = capturedLogs[0];

      // Validate JSON parse
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe('ai.request.start');
      expect(parsed.level).toBe('info');
      expect(parsed.service).toBe('arabic-law-rag');
      expect(parsed.trace_id).toBe(traceId);
      expect(parsed.run_id).toBe(runId);
      expect(parsed.persona).toBe('client');
      expect(parsed.mode).toBe('chat_fast');
      expect(parsed.route).toBe('/api/ai/chat/stream');
      expect(parsed.duration_ms).toBe(45);
      expect(parsed.outcome).toBe('success');
      expect(parsed.msg).toBe('Incoming chat request');

      // Verify versions are included
      expect(envelope.git_sha).toBeDefined();
      expect(envelope.prompt_version).toBeDefined();
      expect(envelope.model_id).toBeDefined();
      expect(envelope.rag_index_version).toBeDefined();

      // Verify data is redacted
      expect(parsed.data.message_len).toBe(120);
      expect(parsed.data.user_phone).toBe('[REDACTED:PHONE]');
    });

    it('handles errors cleanly with sanitized error messages', () => {
      const sensitiveErr = new Error('Database failed for email ahmed@test.eg with token Bearer abc12345');

      llmopsLogger.error(LLMOPS_EVENTS.RETRIEVE_ERROR, { msg: 'RAG error' }, sensitiveErr);

      expect(capturedLogs).toHaveLength(1);
      const { envelope } = capturedLogs[0];

      expect(envelope.level).toBe('error');
      expect(envelope.outcome).toBe('error');
      expect(envelope.error).toBeDefined();
      expect(envelope.error?.type).toBe('Error');
      expect(envelope.error?.message_safe).toBe(
        'Database failed for email [REDACTED:EMAIL] with token [REDACTED:TOKEN]'
      );
    });

    it('supports all log level facades: debug, info, warn, error', () => {
      llmopsLogger.debug(LLMOPS_EVENTS.STREAM_FIRST_TOKEN, { ttft_ms: 320 });
      llmopsLogger.info(LLMOPS_EVENTS.AUTH_OK);
      llmopsLogger.warn(LLMOPS_EVENTS.RATELIMIT_HIT, { limit: 10 });
      llmopsLogger.error(LLMOPS_EVENTS.LLM_ERROR);

      expect(capturedLogs).toHaveLength(4);
      expect(capturedLogs.map((l) => l.envelope.level)).toEqual(['debug', 'info', 'warn', 'error']);
    });
  });

  describe('Model Registry (registry/models.ts)', () => {
    it('contains exact model IDs specified by steering', () => {
      expect(MODEL_ROUTING_TABLE.classify_guard.primary).toEqual({
        provider: 'groq',
        model: 'qwen/qwen3.8-27b',
        temp: 0,
      });
      expect(MODEL_ROUTING_TABLE.classify_guard.fallback).toEqual({
        provider: 'groq',
        model: 'groq/compound-mini',
      });

      expect(MODEL_ROUTING_TABLE.synthesize_chat.primary).toEqual({
        provider: 'groq',
        model: 'groq/compound-mini',
        temp: 0.2,
      });
      expect(MODEL_ROUTING_TABLE.synthesize_chat.fallback).toEqual({
        provider: 'groq',
        model: 'groq/compound',
      });

      expect(MODEL_ROUTING_TABLE.synthesize_case.primary).toEqual({
        provider: 'groq',
        model: 'groq/compound-mini',
        temp: 0.1,
      });

      expect(MODEL_ROUTING_TABLE.judge_eval.primary).toEqual({
        provider: 'groq',
        model: 'qwen/qwen3.8-27b',
        temp: 0,
      });
      expect(MODEL_ROUTING_TABLE.judge_eval.fallback).toEqual({
        provider: 'groq',
        model: 'groq/compound-mini',
      });

      expect(MODEL_ROUTING_TABLE.voice_tts.primary).toEqual({
        provider: 'groq',
        model: 'canopylabs/orpheus-arabic-saudi',
      });
    });

    it('resolves routes correctly with resolveRoute', () => {
      const guardRoute = resolveRoute('classify_guard');
      expect(guardRoute.primary.model).toBe('qwen/qwen3.8-27b');

      const chatRoute = resolveRoute('synthesize_chat');
      expect(chatRoute.primary.model).toBe('groq/compound-mini');

      const voiceRoute = resolveRoute('voice_tts');
      expect(voiceRoute.primary.model).toBe('canopylabs/orpheus-arabic-saudi');
    });

    it('throws when requesting an invalid model role', () => {
      // @ts-expect-error test unknown role
      expect(() => resolveRoute('unknown_role')).toThrow(/Unknown model role/);
    });
  });
});
