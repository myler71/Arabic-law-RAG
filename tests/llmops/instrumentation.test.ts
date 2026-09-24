import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import os from 'os';
import path from 'path';
import { POST as chatPost } from '@/app/api/ai/chat/route';
import { POST as chatStreamPost } from '@/app/api/ai/chat/stream/route';
import { POST as summarizePost } from '@/app/api/ai/summarize/route';
import { POST as matchPost } from '@/app/api/ai/match/route';
import { GET as researchGet } from '@/app/api/ai/research/route';
import { defaultRateLimiter } from '@/lib/ai/rateLimiter';
import { resetKnowledgeBaseCache } from '@/lib/ai/legalRag';
import { setLogSink, LLMOPS_EVENTS, runStore, type LlmopsLogEnvelope } from '@/lib/llmops';

describe('LLMOps Instrumentation & Event Emission', () => {
  const originalEnv = { ...process.env };
  let stdoutLines: string[] = [];
  let stdoutSpy: MockInstance;

  beforeEach(async () => {
    stdoutLines = [];
    setLogSink(null); // Direct output to process.stdout
    resetKnowledgeBaseCache();
    defaultRateLimiter.reset();
    // Isolate run store per worker: parallel test files share the default file otherwise.
    runStore.useFile(
      path.join(os.tmpdir(), `hakmdar_runs_${process.pid}_${Date.now()}.jsonl`)
    );
    await runStore.clear();

    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      if (typeof chunk === 'string') {
        stdoutLines.push(chunk);
      }
      return true;
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function getLlmopsLogs(): LlmopsLogEnvelope[] {
    const logs: LlmopsLogEnvelope[] = [];
    for (const line of stdoutLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.service === 'hakmdar-next' && parsed.event) {
          logs.push(parsed);
        }
      } catch {
        // ignore non-json
      }
    }
    return logs;
  }

  describe('1. Chat Route Instrumentation (/api/ai/chat)', () => {
    it('emits ai.request.start -> ai.guard_pre.* -> ai.retrieve.* -> ai.guard_post.* -> ai.request.done with matching trace_id and X-Trace-Id header', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: { 'x-real-ip': '10.0.0.1' },
        body: JSON.stringify({
          message: 'صاحب الشركة طردني تعسفياً ورافض يديني مستحقاتي وباقي أوراقي',
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const headerTraceId = res.headers.get('X-Trace-Id');
      expect(headerTraceId).toBeDefined();
      expect(typeof headerTraceId).toBe('string');
      expect(headerTraceId!.length).toBeGreaterThan(10);

      const logs = getLlmopsLogs();
      expect(logs.length).toBeGreaterThanOrEqual(5);

      // Verify log sequence events
      const events = logs.map((l) => l.event);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_START);
      expect(events).toContain(LLMOPS_EVENTS.GUARD_PRE_START);
      expect(events).toContain(LLMOPS_EVENTS.GUARD_PRE_DONE);
      expect(events).toContain(LLMOPS_EVENTS.RETRIEVE_START);
      expect(events).toContain(LLMOPS_EVENTS.RETRIEVE_DONE);
      expect(events).toContain(LLMOPS_EVENTS.GUARD_POST_START);
      expect(events).toContain(LLMOPS_EVENTS.GUARD_POST_DONE);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_DONE);

      // Verify all emitted logs correlate with the same trace_id
      for (const log of logs) {
        expect(log.trace_id).toBe(headerTraceId);
        expect(log.service).toBe('hakmdar-next');
        expect(log.mode).toBe('chat_fast');
        expect(log.route).toBe('/api/ai/chat');
      }

      // Terminal event checks
      const doneLog = logs.find((l) => l.event === LLMOPS_EVENTS.REQUEST_DONE);
      expect(doneLog).toBeDefined();
      expect(doneLog?.outcome).toBe('success');
      expect(typeof doneLog?.data?.t_total_ms).toBe('number');
      expect(doneLog?.duration_ms).toBeGreaterThanOrEqual(0);

      // Verify run was persisted in runStore
      const run = await runStore.getByTraceId(headerTraceId!);
      expect(run).toBeDefined();
      expect(run?.trace_id).toBe(headerTraceId);
      expect(run?.outcome).toBe('success');
      expect(run?.mode).toBe('chat_fast');
    });

    it('emits ai.guard_pre.refuse and marks outcome refuse on non-legal query', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: { 'x-real-ip': '10.0.0.2' },
        body: JSON.stringify({
          message: 'طريقة عمل الكنافة بالمانجو في المنزل',
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const headerTraceId = res.headers.get('X-Trace-Id');
      expect(headerTraceId).toBeDefined();

      const logs = getLlmopsLogs();
      const events = logs.map((l) => l.event);

      expect(events).toContain(LLMOPS_EVENTS.REQUEST_START);
      expect(events).toContain(LLMOPS_EVENTS.GUARD_PRE_START);
      expect(events).toContain(LLMOPS_EVENTS.GUARD_PRE_DONE);
      expect(events).toContain(LLMOPS_EVENTS.GUARD_PRE_REFUSE);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_DONE);

      const doneLog = logs.find((l) => l.event === LLMOPS_EVENTS.REQUEST_DONE);
      expect(doneLog?.outcome).toBe('refuse');

      const run = await runStore.getByTraceId(headerTraceId!);
      expect(run?.outcome).toBe('refuse');
      expect(run?.is_legal).toBe(false);
    });

    it('honors incoming X-Trace-Id header from client', async () => {
      const customTraceId = 'custom-test-trace-999888';
      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: {
          'x-real-ip': '10.0.0.3',
          'x-trace-id': customTraceId,
        },
        body: JSON.stringify({
          message: 'طريقة عمل الشاي بالنعناع',
        }),
      });

      const res = await chatPost(req);
      expect(res.headers.get('X-Trace-Id')).toBe(customTraceId);

      const logs = getLlmopsLogs();
      expect(logs.length).toBeGreaterThan(0);
      for (const log of logs) {
        expect(log.trace_id).toBe(customTraceId);
      }
    });

    it('emits ai.ratelimit.hit on 429 and logs terminal request.done with error outcome', async () => {
      const ip = '10.0.0.42';
      // Saturate rate limiter (30 requests)
      for (let i = 0; i < 30; i++) {
        defaultRateLimiter.check(ip);
      }

      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: { 'x-real-ip': ip },
        body: JSON.stringify({ message: 'استشارة' }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(429);
      expect(res.headers.get('X-Trace-Id')).toBeDefined();

      const logs = getLlmopsLogs();
      const events = logs.map((l) => l.event);
      expect(events).toContain(LLMOPS_EVENTS.RATELIMIT_HIT);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_DONE);

      const doneLog = logs.find((l) => l.event === LLMOPS_EVENTS.REQUEST_DONE);
      expect(doneLog?.outcome).toBe('error');
    });
  });

  describe('2. Streaming Route Instrumentation (/api/ai/chat/stream)', () => {
    it('emits streaming events (metadata, first_token, done) and echoes X-Trace-Id', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'x-real-ip': '10.0.0.4' },
        body: JSON.stringify({ message: 'فصلني صاحب العمل تعسفياً' }),
      });

      const res = await chatStreamPost(req);
      expect(res.status).toBe(200);
      const traceId = res.headers.get('X-Trace-Id');
      expect(traceId).toBeDefined();

      // Consume stream completely
      await res.text();

      const logs = getLlmopsLogs();
      const events = logs.map((l) => l.event);

      expect(events).toContain(LLMOPS_EVENTS.REQUEST_START);
      expect(events).toContain(LLMOPS_EVENTS.STREAM_METADATA_EMITTED);
      expect(events).toContain(LLMOPS_EVENTS.STREAM_FIRST_TOKEN);
      expect(events).toContain(LLMOPS_EVENTS.STREAM_DONE);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_DONE);

      for (const log of logs) {
        expect(log.trace_id).toBe(traceId);
        expect(log.route).toBe('/api/ai/chat/stream');
      }
    });
  });

  describe('3. Summarize, Match, and Research Routes Instrumentation', () => {
    it('/api/ai/summarize echoes X-Trace-Id and records start and done events', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/summarize', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ text: 'طردني صاحب العمل بدون إنذار' }],
          clientInfo: { name: 'علي حسن' },
        }),
      });

      const res = await summarizePost(req);
      expect(res.status).toBe(200);
      const traceId = res.headers.get('X-Trace-Id');
      expect(traceId).toBeDefined();

      const logs = getLlmopsLogs();
      const events = logs.map((l) => l.event);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_START);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_DONE);

      const run = await runStore.getByTraceId(traceId!);
      expect(run?.route).toBe('/api/ai/summarize');
      expect(run?.outcome).toBe('success');
    });

    it('/api/ai/match echoes X-Trace-Id and records start and done events', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/match', {
        method: 'POST',
        body: JSON.stringify({
          category: 'labor',
          location: 'القاهرة',
        }),
      });

      const res = await matchPost(req);
      expect(res.status).toBe(200);
      const traceId = res.headers.get('X-Trace-Id');
      expect(traceId).toBeDefined();

      const logs = getLlmopsLogs();
      const events = logs.map((l) => l.event);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_START);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_DONE);

      const run = await runStore.getByTraceId(traceId!);
      expect(run?.route).toBe('/api/ai/match');
      expect(run?.outcome).toBe('success');
    });

    it('/api/ai/research echoes X-Trace-Id and records start and done events', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/research?q=عمل', {
        method: 'GET',
      });

      const res = await researchGet(req);
      expect(res.status).toBe(200);
      const traceId = res.headers.get('X-Trace-Id');
      expect(traceId).toBeDefined();

      const logs = getLlmopsLogs();
      const events = logs.map((l) => l.event);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_START);
      expect(events).toContain(LLMOPS_EVENTS.REQUEST_DONE);

      const run = await runStore.getByTraceId(traceId!);
      expect(run?.route).toBe('/api/ai/research');
      expect(run?.outcome).toBe('success');
    });
  });
});
