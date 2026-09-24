import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ai/chat/stream/route';
import { defaultRateLimiter } from '@/lib/ai/rateLimiter';
import { resetKnowledgeBaseCache } from '@/lib/ai/legalRag';

interface ParsedEvent {
  event: string;
  data: string;
}

async function parseSseStream(response: Response): Promise<ParsedEvent[]> {
  const text = await response.text();
  const blocks = text.split('\n\n').filter((block) => block.trim().length > 0);
  const events: ParsedEvent[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let event = 'message';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.replace('event: ', '').trim();
      } else if (line.startsWith('data: ')) {
        data = line.replace('data: ', '').trim();
      }
    }

    if (data) {
      events.push({ event, data });
    }
  }

  return events;
}

describe('HKM-AI-01: SSE Streaming Route Handler (/api/ai/chat/stream)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetKnowledgeBaseCache();
    defaultRateLimiter.reset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('1. Authentication & Security Guardrails', () => {
    it('returns 401 when Supabase credentials exist but user is unauthenticated', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://real-test-ref.supabase.co';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'real-anon-key-12345';

      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        body: JSON.stringify({ message: 'فصلني تعسفياً' }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('UNAUTHORIZED');
    });

    it('permits guest access in demo/offline mode without credentials', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'x-real-ip': '192.168.1.100' },
        body: JSON.stringify({ message: 'فصلني تعسفياً' }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });

    it('enforces 30 req/min rate limiting and returns 429 when quota is exceeded', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const ip = '10.0.0.88';

      // 30 requests within quota
      for (let i = 0; i < 30; i++) {
        const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
          method: 'POST',
          headers: { 'x-real-ip': ip },
          body: JSON.stringify({ message: 'استشارة' }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
      }

      // 31st request exceeds rate limit
      const blockedReq = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'x-real-ip': ip },
        body: JSON.stringify({ message: 'استشارة' }),
      });
      const blockedRes = await POST(blockedReq);
      expect(blockedRes.status).toBe(429);
      const data = await blockedRes.json();
      expect(data.message).toBe('Too Many Requests');
      expect(blockedRes.headers.get('X-RateLimit-Limit')).toBe('30');
      expect(blockedRes.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('returns 400 when message is missing or invalid', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        body: JSON.stringify({ message: '   ' }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Message is required');
    });
  });

  describe('2. Pipeline and SSE Stream Event Contract', () => {
    it('handles non-legal query by emitting polite refusal stream with metadata and tokens', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'x-real-ip': '10.0.0.1' },
        body: JSON.stringify({ message: 'طريقة عمل الملوخية بالفراخ' }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const events = await parseSseStream(res);
      expect(events.length).toBeGreaterThan(0);

      // Verify metadata event
      const metadataEvent = events.find((e) => e.event === 'metadata');
      expect(metadataEvent).toBeDefined();
      const meta = JSON.parse(metadataEvent!.data);
      expect(meta.domain).toBe('non_legal');
      expect(meta.citations).toEqual([]);

      // Verify token event with refusal text
      const tokenEvents = events.filter((e) => e.event === 'token');
      expect(tokenEvents.length).toBeGreaterThan(0);
      const fullText = tokenEvents.map((e) => JSON.parse(e.data).text).join('');
      expect(fullText).toContain('المستشار القانوني حِكِمْدار');

      // Verify done event
      const doneEvent = events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();
      const donePayload = JSON.parse(doneEvent!.data);
      expect(donePayload.status).toBe('complete');
      expect(donePayload.timings).toBeDefined();
    });

    it('streams offline legal consultation for "فصلني تعسفياً" in exact event order', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'x-real-ip': '10.0.0.2' },
        body: JSON.stringify({ message: 'فصلني تعسفياً' }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const events = await parseSseStream(res);

      // Event order verification: metadata MUST be emitted first
      expect(events[0].event).toBe('metadata');
      const meta = JSON.parse(events[0].data);
      expect(meta.trace_id).toBeDefined();
      expect(meta.domain).toBe('labor');
      expect(Array.isArray(meta.citations)).toBe(true);
      expect(meta.citations.length).toBeGreaterThan(0);
      // Verify that citations contain Labor Law Article 122 or 69
      const hasArticle122or69 = meta.citations.some(
        (c: { articleNumber: string; title: string }) =>
          c.articleNumber.includes('122') ||
          c.articleNumber.includes('69') ||
          c.title.includes('122') ||
          c.title.includes('69')
      );
      expect(hasArticle122or69).toBe(true);

      // Token events (Arabic incremental stream)
      const tokenEvents = events.filter((e) => e.event === 'token');
      expect(tokenEvents.length).toBeGreaterThan(0);
      const assembledText = tokenEvents.map((e) => JSON.parse(e.data).text).join('');
      expect(assembledText).toContain('قانون العمل');
      expect(assembledText).toContain('122');

      // Citation events
      const citationEvents = events.filter((e) => e.event === 'citation');
      expect(citationEvents.length).toBeGreaterThan(0);
      for (const cit of citationEvents) {
        const payload = JSON.parse(cit.data);
        expect(payload.chunk_id).toBeDefined();
        expect(payload.article_number).toBeDefined();
        expect(payload.law_name).toBeDefined();
      }

      // Structured summary event
      const summaryEvent = events.find((e) => e.event === 'structured_summary');
      expect(summaryEvent).toBeDefined();
      const summary = JSON.parse(summaryEvent!.data);
      expect(summary.case_type).toContain('عمالي');
      expect(summary.risk_level).toBe('high');
      expect(summary.recommended_action).toBeDefined();
      expect(summary.category).toBe('labor');
      expect(Array.isArray(summary.legalClaims)).toBe(true);

      // Done event
      const doneEvent = events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();
      const doneData = JSON.parse(doneEvent!.data);
      expect(doneData.status).toBe('complete');
      expect(doneData.timings.t_guard).toBeDefined();
      expect(doneData.timings.t_retrieval).toBeDefined();
      expect(doneData.timings.t_metadata_emit).toBeDefined();
      expect(doneData.timings.ttft_ms).toBeDefined();
      expect(doneData.timings.t_total).toBeDefined();

      // Ensure TTFT is under target threshold (≤ 800ms)
      expect(doneData.timings.ttft_ms).toBeLessThanOrEqual(800);

      // [DONE] marker event
      const doneMarker = events.find((e) => e.data === '[DONE]');
      expect(doneMarker).toBeDefined();
    });

    it('guarantees zero fabricated article numbers: all citations in answer match retrieved evidence', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'x-real-ip': '10.0.0.3' },
        body: JSON.stringify({ message: 'فصلني تعسفياً' }),
      });

      const res = await POST(req);
      const events = await parseSseStream(res);

      const metadataEvent = events.find((e) => e.event === 'metadata');
      const meta = JSON.parse(metadataEvent!.data);
      const validArticleNumbers = meta.citations.map(
        (c: { articleNumber: string }) => c.articleNumber
      );

      const tokenEvents = events.filter((e) => e.event === 'token');
      const assembledText = tokenEvents.map((e) => JSON.parse(e.data).text).join('');

      // Extract all article numbers mentioned in assembledText
      const matches = assembledText.match(/(?:المادة|مادة)\s*(\d+)/g) || [];
      expect(matches.length).toBeGreaterThan(0);

      for (const match of matches) {
        const num = match.replace(/[^\d]/g, '');
        const existsInEvidence = validArticleNumbers.some((art: string) => art.includes(num));
        expect(existsInEvidence).toBe(true);
      }
    });

    it('stops generation gracefully when client disconnects (req.signal aborted)', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const controller = new AbortController();
      const req = new NextRequest('http://localhost:3000/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'x-real-ip': '10.0.0.4' },
        body: JSON.stringify({ message: 'فصلني تعسفياً' }),
        signal: controller.signal,
      });

      // Abort immediately
      controller.abort();

      const res = await POST(req);
      expect(res.status).toBe(200);

      // Stream should close cleanly without throwing unhandled error
      const reader = res.body?.getReader();
      if (reader) {
        let chunkCount = 0;
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
            chunkCount++;
          }
        } catch {
          // Expected on abrupt abort
        }
        // Should have aborted early
        expect(chunkCount).toBeLessThan(10);
      }
    });
  });
});
