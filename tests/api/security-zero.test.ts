import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { RateLimiter, checkRateLimit, defaultRateLimiter } from '@/lib/ai/rateLimiter';
import { middleware } from '@/middleware';
import { POST as aiChatPost } from '@/app/api/ai/chat/route';

describe('Phase 1: Secure-0 Rate Limiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 1000); // 3 requests per 1000ms for fast testing
    defaultRateLimiter.reset();
  });

  it('allows requests within limit and tracks remaining quota', () => {
    const r1 = limiter.check('test-client-1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check('test-client-1');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check('test-client-1');
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('rejects requests exceeding the limit with allowed=false', () => {
    limiter.check('test-client-2');
    limiter.check('test-client-2');
    limiter.check('test-client-2');

    const blocked = limiter.check('test-client-2');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetMs).toBeGreaterThan(0);
  });

  it('isolates quotas across different identifiers', () => {
    limiter.check('user-A');
    limiter.check('user-A');
    limiter.check('user-A');
    expect(limiter.check('user-A').allowed).toBe(false);

    // user-B is untouched
    const userB = limiter.check('user-B');
    expect(userB.allowed).toBe(true);
    expect(userB.remaining).toBe(2);
  });

  it('exports checkRateLimit function supporting default 30 requests limit', () => {
    const result = checkRateLimit('check-fn-user');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(29);
  });
});

describe('Phase 1: Secure-0 Middleware Route Protection', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sets x-hakmdar-demo-mode header when Supabase credentials are missing or placeholder', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const req = new NextRequest('http://localhost:3000/lawyer/dashboard');
    const res = await middleware(req);

    expect(res.headers.get('x-hakmdar-demo-mode')).toBe('1');
    expect(res.status).toBe(200);
  });

  it('exempts static assets, _next, and public routes from auth redirects', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://real-test-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'real-anon-key-12345';

    const reqStatic = new NextRequest('http://localhost:3000/_next/static/chunks/main.js');
    const resStatic = await middleware(reqStatic);
    expect(resStatic.status).toBe(200);

    const reqLogin = new NextRequest('http://localhost:3000/login');
    const resLogin = await middleware(reqLogin);
    expect(resLogin.status).toBe(200);
  });

  it('redirects unauthenticated lawyer to /login?role=lawyer when configured', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://real-test-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'real-anon-key-12345';

    const req = new NextRequest('http://localhost:3000/lawyer/cases');
    const res = await middleware(req);

    expect(res.status).toBe(307); // NextResponse.redirect
    const location = res.headers.get('location');
    expect(location).toContain('/login?role=lawyer');
  });

  it('redirects unauthenticated client to /login?role=client when configured', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://real-test-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'real-anon-key-12345';

    const req = new NextRequest('http://localhost:3000/client/cases');
    const res = await middleware(req);

    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toContain('/login?role=client');
  });
});

describe('Phase 1: Secure-0 /api/ai/chat Authentication & Rate Limiting', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    defaultRateLimiter.reset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 401 Unauthorized when credentials exist and user is unauthenticated', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://real-test-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'real-anon-key-12345';

    const req = new NextRequest('http://localhost:3000/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'ما هي عقوبة الشيك بدون رصيد؟' }),
    });

    const res = await aiChatPost(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('permits guest access in demo mode when credentials are not configured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const req = new NextRequest('http://localhost:3000/api/ai/chat', {
      method: 'POST',
      headers: {
        'x-real-ip': '192.168.1.50',
      },
      body: JSON.stringify({ message: 'ما هي عقوبة الشيك بدون رصيد؟' }),
    });

    const res = await aiChatPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBeDefined();
  });

  it('enforces rate limiting of 30 requests/minute and returns 429 on excess', { timeout: 30_000 }, async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const ip = '10.0.0.99';

    // Dispatch 30 requests
    for (let i = 0; i < 30; i++) {
      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: { 'x-real-ip': ip },
        body: JSON.stringify({ message: 'استشارة قانونية' }),
      });
      const res = await aiChatPost(req);
      expect(res.status).toBe(200);
    }

    // 31st request should be rejected with 429
    const blockedReq = new NextRequest('http://localhost:3000/api/ai/chat', {
      method: 'POST',
      headers: { 'x-real-ip': ip },
      body: JSON.stringify({ message: 'استشارة قانونية' }),
    });
    const blockedRes = await aiChatPost(blockedReq);
    expect(blockedRes.status).toBe(429);

    const data = await blockedRes.json();
    expect(data.message).toBe('Too Many Requests');
    expect(blockedRes.headers.get('Retry-After')).toBeDefined();
    expect(blockedRes.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(blockedRes.headers.get('X-RateLimit-Remaining')).toBe('0');
  });
});
