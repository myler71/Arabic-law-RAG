import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/ai/rateLimiter';
import {
  submitFeedback,
  getFeedbackForTrace,
  FeedbackApiError,
  type Requester,
} from '@/lib/llmops/feedback/api';
import type { FeedbackWriteInput } from '@/lib/llmops/feedback/schema';

interface AuthUser {
  id: string;
  email?: string;
  role?: string;
  user_metadata?: Record<string, unknown>;
}

type AuthResult =
  | { user: AuthUser; errorResponse: null }
  | { user: null; errorResponse: NextResponse };

async function resolveUser(req: NextRequest): Promise<AuthResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const credentialsExist = Boolean(
    supabaseUrl &&
      supabaseAnonKey &&
      !supabaseUrl.includes('placeholder') &&
      !supabaseUrl.includes('arabic-law-rag-demo')
  );

  let user: AuthUser | null = null;

  if (credentialsExist) {
    try {
      const supabase = createServerClient(req);
      const { data, error: authError } = await supabase.auth.getUser();

      if (authError || !data?.user) {
        return {
          user: null,
          errorResponse: NextResponse.json(
            { error: 'غير مصرح بالدخول. يرجى تسجيل الدخول أولاً.', code: 'UNAUTHORIZED' },
            { status: 401 }
          ),
        };
      }
      user = data.user;
    } catch {
      return {
        user: null,
        errorResponse: NextResponse.json(
          { error: 'غير مصرح بالدخول. يرجى تسجيل الدخول أولاً.', code: 'UNAUTHORIZED' },
          { status: 401 }
        ),
      };
    }
  } else {
    // Demo / offline mode: permit guest access or inspect mock if provided
    try {
      const supabase = createServerClient(req);
      if (supabase?.auth?.getUser) {
        const { data, error: authError } = await supabase.auth.getUser();
        if (authError) {
          return {
            user: null,
            errorResponse: NextResponse.json(
              { error: 'غير مصرح بالدخول. يرجى تسجيل الدخول أولاً.', code: 'UNAUTHORIZED' },
              { status: 401 }
            ),
          };
        }
        if (data?.user) {
          user = data.user;
        }
      }
    } catch {
      // Fall back in demo mode
    }

    if (!user) {
      user = { id: 'demo-user', email: 'demo@arabic-law-rag.local', role: 'client' };
    }
  }

  return { user, errorResponse: null };
}

/**
 * POST /api/ai/feedback
 * Submit user/lawyer feedback for an AI run.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await resolveUser(req);
    if (auth.errorResponse) {
      return auth.errorResponse;
    }
    const user = auth.user;

    // Rate Limiting (60 feedback submissions/min per user/IP)
    const forwardedFor = req.headers.get('x-forwarded-for');
    const realIp = req.headers.get('x-real-ip');
    const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : realIp || '127.0.0.1';
    const identifier = `feedback:${user.id || clientIp}`;

    const rateLimit = checkRateLimit(identifier);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'لقد تجاوزت الحد المسموح به من التقييمات. يرجى الانتظار قليلاً.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(rateLimit.resetMs / 1000),
        },
        { status: 429 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'جسم الطلب غير صالح (Invalid JSON body)', code: 'BAD_REQUEST' },
        { status: 400 }
      );
    }

    const requester: Requester = {
      id: user.id,
      email: user.email,
      role: (user.user_metadata?.role as string) || user.role || 'client',
    };

    const result = await submitFeedback(body as FeedbackWriteInput, requester);
    return NextResponse.json(result, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'بيانات التقييم غير صالحة (Validation Error)',
          details: err.errors,
          code: 'VALIDATION_ERROR',
        },
        { status: 400 }
      );
    }
    if (err instanceof FeedbackApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code || 'FEEDBACK_ERROR' },
        { status: err.status }
      );
    }
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

/**
 * GET /api/ai/feedback?trace_id=...
 * Retrieve own feedback records for a given trace.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await resolveUser(req);
    if (auth.errorResponse) {
      return auth.errorResponse;
    }
    const user = auth.user;

    const traceId = req.nextUrl.searchParams.get('trace_id');
    if (!traceId) {
      return NextResponse.json(
        { error: 'معرف التتبع trace_id مطلوب (trace_id query param is required)', code: 'BAD_REQUEST' },
        { status: 400 }
      );
    }

    const requester: Requester = {
      id: user.id,
      email: user.email,
      role: (user.user_metadata?.role as string) || user.role || 'client',
    };

    const records = await getFeedbackForTrace(traceId, requester);
    return NextResponse.json({ feedback: records }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof FeedbackApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code || 'FEEDBACK_ERROR' },
        { status: err.status }
      );
    }
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
