import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getTracer,
  resetTracer,
  NoopTracer,
  OtlpTracer,
  LangSmithTracer,
  CompositeTracer,
} from '../../lib/llmops/tracing/provider';
import {
  startRunSpan,
  spanChatFast,
  spanCaseDeep,
  withActiveSpan,
} from '../../lib/llmops/tracing/spans';
import {
  METRIC_NAMES,
  METRIC_AI_REQUESTS_TOTAL,
  METRIC_AI_TTFT_MS,
} from '../../lib/llmops/metrics/names';
import {
  emitCounter,
  emitHistogram,
  readMetricsSnapshot,
  resetMetrics,
  flushMetrics,
} from '../../lib/llmops/metrics/emit';
import { runLlmOpsContext } from '../../lib/llmops/context';

describe('LLMOps Tracing & Metrics Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetTracer();
    resetMetrics();
    process.env = { ...originalEnv };
    delete process.env.OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.LANGCHAIN_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetTracer();
    resetMetrics();
    vi.restoreAllMocks();
  });

  describe('1. Tracing Provider Adapters & Composite Factory', () => {
    it('defaults to NoopTracer when no environment variables are set', () => {
      const tracer = getTracer(true);
      expect(tracer.name).toBe('noop');
      expect(tracer).toBeInstanceOf(NoopTracer);

      const span = tracer.startSpan('test.span', { foo: 'bar' });
      expect(span.name).toBe('test.span');
      expect(span.status).toBe('unset');
      expect(span.attributes.foo).toBe('bar');

      tracer.endSpan(span, 'ok');
      expect(span.status).toBe('ok');
      expect(span.endTime).toBeDefined();
    });

    it('activates OtlpTracer when OTLP_ENDPOINT is configured', async () => {
      process.env.OTLP_ENDPOINT = 'http://localhost:4318';
      const tracer = getTracer(true);

      expect(tracer.name).toBe('otlp');
      expect(tracer).toBeInstanceOf(OtlpTracer);

      const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      globalThis.fetch = mockFetch;

      const otlp = new OtlpTracer({
        endpoint: 'http://localhost:4318',
        batchSize: 2,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const s1 = otlp.startSpan('test.s1', { mode: 'chat_fast' });
      const s2 = otlp.startSpan('test.s2', { mode: 'chat_fast' });

      otlp.endSpan(s1, 'ok');
      otlp.endSpan(s2, 'ok');

      await otlp.flush();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledInit] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('http://localhost:4318/v1/traces');
      const payload = JSON.parse(calledInit.body as string);
      expect(payload.resourceSpans).toBeDefined();
      expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    });

    it('activates LangSmithTracer when LANGSMITH_API_KEY is configured', async () => {
      process.env.LANGSMITH_API_KEY = 'lsv2_pt_dummy_123';
      const tracer = getTracer(true);

      expect(tracer.name).toBe('langsmith');
      expect(tracer).toBeInstanceOf(LangSmithTracer);

      const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      const langsmith = new LangSmithTracer({
        apiKey: 'lsv2_pt_dummy_123',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const span = langsmith.startSpan('ai.llm.synthesize', { model_id: 'groq/compound-mini' });
      langsmith.endSpan(span, 'ok');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://api.smith.langchain.com/runs');
      expect(calledInit.headers['x-api-key']).toBe('lsv2_pt_dummy_123');
      const body = JSON.parse(calledInit.body as string);
      expect(body.run_type).toBe('llm');
      expect(body.name).toBe('ai.llm.synthesize');
    });

    it('activates CompositeTracer when both OTLP and LangSmith are set', async () => {
      process.env.OTLP_ENDPOINT = 'http://localhost:4318';
      process.env.LANGSMITH_API_KEY = 'lsv2_pt_dummy_123';

      const tracer = getTracer(true);
      expect(tracer.name).toBe('composite');
      expect(tracer).toBeInstanceOf(CompositeTracer);

      const composite = tracer as CompositeTracer;
      expect(composite.providers).toHaveLength(2);
      expect(composite.providers.map((p) => p.name)).toEqual(['otlp', 'langsmith']);

      const span = composite.startSpan('composite.span', { test: true });
      expect(span.name).toBe('composite.span');
      composite.endSpan(span, 'ok');
      expect(span.status).toBe('ok');
    });
  });

  describe('2. Span Tree Structure & Helpers', () => {
    it('startRunSpan creates root span with minimum L4.1 attributes', () => {
      const root = runLlmOpsContext(
        { persona: 'client', route: '/api/ai/chat/stream' },
        () => {
          return startRunSpan('chat_fast', {
            chunk_ids: ['statute:122'],
            evidence_score: 0.95,
            is_legal: true,
            guard_domain: 'labor',
          });
        }
      );

      expect(root.name).toBe('arabic-law-rag.ai.run');
      expect(root.parentId).toBeNull();
      expect(root.attributes.mode).toBe('chat_fast');
      expect(root.attributes.persona).toBe('client');
      expect(root.attributes.route).toBe('/api/ai/chat/stream');
      expect(root.attributes.model_id).toBeDefined();
      expect(root.attributes.prompt_version).toBeDefined();
      expect(root.attributes.rag_index_version).toBeDefined();
      expect(root.attributes.chunk_ids).toEqual(['statute:122']);
      expect(root.attributes.evidence_score).toBe(0.95);
      expect(root.attributes.is_legal).toBe(true);
      expect(root.attributes.guard_domain).toBe('labor');
    });

    it('spanChatFast builds the complete chat_fast span tree', () => {
      const tree = spanChatFast();
      expect(tree.root.name).toBe('arabic-law-rag.ai.run');

      const sAuth = tree.auth({ user: 'anon' });
      const sGuardPre = tree.guardPre({ input_len: 25 });
      const sRetrieve = tree.retrieve({
        dense: { count: 5 },
        bm25: { count: 3 },
        rrf: { count: 4 },
        rerank: { count: 2 },
        chunk_ids: ['c1', 'c2'],
      });
      const sRecall = tree.memoryRecall({ hits: 0 });
      const sLlm = tree.llmSynthesize({ model: 'groq/compound-mini' });
      const sGuardPost = tree.guardPost({ citations_checked: 1 });
      const sStream = tree.stream({ tokens_streamed: 45 });

      expect(sAuth.name).toBe('ai.auth');
      expect(sAuth.parentId).toBe(tree.root.id);

      expect(sGuardPre.name).toBe('ai.guard_pre');
      expect(sGuardPre.parentId).toBe(tree.root.id);

      expect(sRetrieve.name).toBe('ai.retrieve');
      expect(sRetrieve.parentId).toBe(tree.root.id);
      expect(sRetrieve.attributes['retrieve.dense']).toEqual({ count: 5 });
      expect(sRetrieve.attributes['retrieve.rerank']).toEqual({ count: 2 });

      expect(sRecall.name).toBe('ai.memory.recall');
      expect(sRecall.parentId).toBe(tree.root.id);

      expect(sLlm.name).toBe('ai.llm.synthesize');
      expect(sLlm.parentId).toBe(tree.root.id);

      expect(sGuardPost.name).toBe('ai.guard_post');
      expect(sGuardPost.parentId).toBe(tree.root.id);

      expect(sStream.name).toBe('ai.stream');
      expect(sStream.parentId).toBe(tree.root.id);

      tree.end('ok', { outcome: 'success' });
      expect(tree.root.status).toBe('ok');
      expect(tree.root.attributes.outcome).toBe('success');
    });

    it('spanCaseDeep builds the complete case_deep span tree', () => {
      const tree = spanCaseDeep();
      expect(tree.root.name).toBe('arabic-law-rag.ai.run');

      const sGuardPre = tree.guardPre();
      const sRetrieve = tree.retrieve();
      const sStatutory = tree.graphNode('statutory', { articles: ['122'] });
      const sCassation = tree.graphNode('cassation', { judgments: 3 });
      const sProcedural = tree.graphNode('procedural');
      const sContract = tree.graphNode('contract');
      const sGraphSynth = tree.graphSynthesize();
      const sHitl = tree.hitl({ checkpoint_id: 'chk_1' });
      const sGuardPost = tree.guardPost();
      const sMemoryWrite = tree.memoryWrite({ tier: 'T0' });

      expect(sGuardPre.name).toBe('ai.guard_pre');
      expect(sRetrieve.name).toBe('ai.retrieve');
      expect(sStatutory.name).toBe('ai.graph.statutory');
      expect(sCassation.name).toBe('ai.graph.cassation');
      expect(sProcedural.name).toBe('ai.graph.procedural');
      expect(sContract.name).toBe('ai.graph.contract');
      expect(sGraphSynth.name).toBe('ai.graph.synthesize');
      expect(sHitl.name).toBe('ai.hitl');
      expect(sGuardPost.name).toBe('ai.guard_post');
      expect(sMemoryWrite.name).toBe('ai.memory.write');

      for (const span of [
        sGuardPre,
        sRetrieve,
        sStatutory,
        sCassation,
        sProcedural,
        sContract,
        sGraphSynth,
        sHitl,
        sGuardPost,
        sMemoryWrite,
      ]) {
        expect(span.parentId).toBe(tree.root.id);
      }

      tree.end('ok');
      expect(tree.root.status).toBe('ok');
    });

    it('withActiveSpan records exceptions and rethrows without swallowing', async () => {
      let recordedSpanId = '';

      await expect(
        withActiveSpan('failing.operation', { foo: 'bar' }, (span) => {
          recordedSpanId = span.id;
          throw new Error('Database connection failed');
        })
      ).rejects.toThrow('Database connection failed');

      expect(recordedSpanId).toBeTruthy();
    });
  });

  describe('3. Metrics Registry & Emission', () => {
    it('aggregates counters with multidimensional labels', () => {
      emitCounter(METRIC_NAMES.REQUESTS_TOTAL, { mode: 'chat_fast', outcome: 'success' }, 1);
      emitCounter(METRIC_NAMES.REQUESTS_TOTAL, { mode: 'chat_fast', outcome: 'success' }, 2);
      emitCounter(METRIC_NAMES.REQUESTS_TOTAL, { mode: 'case_deep', outcome: 'error' }, 1);

      const snapshot = readMetricsSnapshot();
      expect(snapshot.counters).toHaveLength(2);

      const fastSuccess = snapshot.counters.find(
        (c) => c.labels.mode === 'chat_fast' && c.labels.outcome === 'success'
      );
      expect(fastSuccess?.value).toBe(3);

      const deepError = snapshot.counters.find(
        (c) => c.labels.mode === 'case_deep' && c.labels.outcome === 'error'
      );
      expect(deepError?.value).toBe(1);
    });

    it('aggregates histograms with sum, count, min, max, avg, and buckets', () => {
      emitHistogram(METRIC_NAMES.TTFT_MS, 150, { mode: 'chat_fast' });
      emitHistogram(METRIC_NAMES.TTFT_MS, 350, { mode: 'chat_fast' });
      emitHistogram(METRIC_NAMES.TTFT_MS, 50, { mode: 'chat_fast' });

      const snapshot = readMetricsSnapshot();
      expect(snapshot.histograms).toHaveLength(1);

      const h = snapshot.histograms[0];
      expect(h.name).toBe(METRIC_NAMES.TTFT_MS);
      expect(h.count).toBe(3);
      expect(h.sum).toBe(550);
      expect(h.min).toBe(50);
      expect(h.max).toBe(350);
      expect(h.avg).toBeCloseTo(183.33, 1);

      // Verify bucket distributions
      expect(h.buckets['50']).toBe(1); // 50 <= 50
      expect(h.buckets['250']).toBe(2); // 50 and 150 <= 250
      expect(h.buckets['500']).toBe(3); // 50, 150, and 350 <= 500
      expect(h.buckets['+Inf']).toBe(3);
    });

    it('contains all required spec L4.2 metric constants', () => {
      expect(METRIC_NAMES.REQUESTS_TOTAL).toBe('ai_requests_total');
      expect(METRIC_NAMES.REQUEST_DURATION_MS).toBe('ai_request_duration_ms');
      expect(METRIC_NAMES.ERRORS_TOTAL).toBe('ai_errors_total');
      expect(METRIC_NAMES.RATELIMIT_TOTAL).toBe('ai_ratelimit_total');
      expect(METRIC_NAMES.CLIENT_DISCONNECT_TOTAL).toBe('ai_client_disconnect_total');
      expect(METRIC_NAMES.GUARD_REFUSE_TOTAL).toBe('ai_guard_refuse_total');
      expect(METRIC_NAMES.DISCLAIMER_TOTAL).toBe('ai_disclaimer_total');
      expect(METRIC_NAMES.CITATIONS_EMITTED_TOTAL).toBe('ai_citations_emitted_total');
      expect(METRIC_NAMES.CITATIONS_REJECTED_TOTAL).toBe('ai_citations_rejected_total');
      expect(METRIC_NAMES.EVIDENCE_SCORE).toBe('ai_evidence_score');
      expect(METRIC_NAMES.FEEDBACK_TOTAL).toBe('ai_feedback_total');
      expect(METRIC_NAMES.HITL_ACTIONS_TOTAL).toBe('ai_hitl_actions_total');
      expect(METRIC_NAMES.TTFT_MS).toBe('ai_ttft_ms');
      expect(METRIC_NAMES.RETRIEVE_MS).toBe('ai_retrieve_ms');
      expect(METRIC_NAMES.LLM_MS).toBe('ai_llm_ms');
      expect(METRIC_NAMES.GUARD_PRE_MS).toBe('ai_guard_pre_ms');
      expect(METRIC_NAMES.GUARD_POST_MS).toBe('ai_guard_post_ms');
      expect(METRIC_NAMES.TOKENS_IN_TOTAL).toBe('ai_tokens_in_total');
      expect(METRIC_NAMES.TOKENS_OUT_TOTAL).toBe('ai_tokens_out_total');
      expect(METRIC_NAMES.COST_USD_TOTAL).toBe('ai_cost_usd_total');
      expect(METRIC_NAMES.RETRIEVE_EMPTY_TOTAL).toBe('ai_retrieve_empty_total');
      expect(METRIC_NAMES.RETRIEVE_HIT_AT_K).toBe('ai_retrieve_hit_at_k');
      expect(METRIC_NAMES.INDEX_VERSION_INFO).toBe('ai_index_version_info');
      expect(METRIC_NAMES.EVAL_SUITE_PASS).toBe('ai_eval_suite_pass');
      expect(METRIC_NAMES.EVAL_METRIC).toBe('ai_eval_metric');
    });

    it('emit methods never throw on edge cases or network failures', async () => {
      expect(() => {
        emitCounter('', undefined as unknown as Record<string, string>, Number.NaN);
        emitCounter(METRIC_AI_REQUESTS_TOTAL, { bad: null, another: undefined }, -5);
        emitHistogram('', Number.NaN);
        emitHistogram(METRIC_AI_TTFT_MS, Number.NaN);
      }).not.toThrow();

      // Simulate failing OTLP push
      process.env.OTLP_ENDPOINT = 'http://invalid-unreachable-host:9999';
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network socket failed'));

      expect(() => {
        emitCounter(METRIC_AI_REQUESTS_TOTAL, { route: '/api' }, 1);
        emitHistogram(METRIC_AI_TTFT_MS, 120, { mode: 'chat_fast' });
      }).not.toThrow();

      await expect(flushMetrics()).resolves.not.toThrow();
    });
  });
});
