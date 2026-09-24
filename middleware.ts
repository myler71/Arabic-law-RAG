import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next.js Edge Middleware for Arabic Law RAG
 *
 * Enforces session management, tenant & portal route protection,
 * and seamless fallback for local offline / demo execution.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Exempt static assets, next internal paths, and public directory
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/public') ||
    pathname === '/favicon.ico' ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf|eot)$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  // 2. Check whether Supabase environment variables are properly configured
  const supabaseUrl: string = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseAnonKey: string = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

  const isConfigured = Boolean(
    supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('placeholder') &&
    !supabaseUrl.includes('arabic-law-rag-demo')
  );

  // 3. Offline / Demo execution fallback: allow access with demo banner header
  if (!isConfigured) {
    const response = NextResponse.next();
    response.headers.set('x-arabic-law-rag-demo-mode', '1');
    return response;
  }

  // 4. Supabase SSR cookie refresh
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 5. Exempt public & auth routes from redirection
  const isExempt =
    pathname === '/' ||
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname === '/register' ||
    pathname.startsWith('/register/') ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/');

  if (isExempt) {
    return supabaseResponse;
  }

  // 6. Protect lawyer and client portals
  const isLawyerRoute = pathname === '/lawyer' || pathname.startsWith('/lawyer/');
  const isClientRoute = pathname === '/client' || pathname.startsWith('/client/');

  if (isLawyerRoute || isClientRoute) {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = '/login';
      const role = isLawyerRoute ? 'lawyer' : 'client';
      redirectUrl.search = `?role=${role}`;
      return NextResponse.redirect(redirectUrl);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - Static media extensions
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
