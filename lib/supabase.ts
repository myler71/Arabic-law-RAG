import { createServerClient as createSsrClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';

function getSupabaseEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  }

  return { supabaseUrl, supabaseAnonKey };
}

/**
 * Factory to create a Supabase client instance using standard environment variables.
 */
export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();
  return createSupabaseClient(supabaseUrl, supabaseAnonKey);
}

/**
 * Helper to get a configured Supabase client for Server Actions & App Router API endpoints.
 * Integrates @supabase/ssr for Next.js App Router while passing Authorization Bearer tokens
 * to global headers so database queries respect PostgreSQL Row Level Security (RLS).
 */
export function createServerClient(context?: NextRequest | Request | Headers | string) {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();

  let token: string | undefined;

  if (typeof context === 'string') {
    token = context.startsWith('Bearer ') ? context.substring(7) : context;
  } else if (context instanceof Headers) {
    const authHeader = context.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  } else if (context && 'headers' in context && context.headers) {
    const authHeader = typeof context.headers.get === 'function'
      ? context.headers.get('authorization')
      : (context.headers as unknown as Record<string, string>)['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  }

  const globalHeaders: Record<string, string> = {};
  if (token) {
    globalHeaders['Authorization'] = `Bearer ${token}`;
  }

  return createSsrClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      async getAll() {
        try {
          const cookieStore = await cookies();
          return cookieStore.getAll();
        } catch {
          return [];
        }
      },
      async setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        try {
          const cookieStore = await cookies();
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options as Record<string, string>)
          );
        } catch {
          // Ignored when setting cookies is unsupported
        }
      },
    },
    global: {
      headers: globalHeaders,
    },
  });
}
