import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/ai/rateLimiter';
import {
  retrieveLegalEvidence,
  type LegalChunk,
  type LegalCitation,
} from '@/lib/ai/legalRag';
import {
  preGuard,
  postGuard,
  COLLOQUIAL_LEGAL_MAPPINGS,
  DEFAULT_REJECT_REASON,
  type PreGuardResult,
  type PostGuardResult,
} from '@/lib/ai/safety/legalGuard';
import type { LegalCategory } from '@/lib/types';
import {
  runLlmOpsContext,
  updateLlmOpsContext,
  newTraceId,
  newRunId,
  hashId,
  resolveVersions,
  llmopsLogger,
  LLMOPS_EVENTS,
  runStore,
} from '@/lib/llmops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { preGuard, postGuard, COLLOQUIAL_LEGAL_MAPPINGS };
export type { PreGuardResult, PostGuardResult };

export interface StructuredCaseSummary {
  case_type: string;
  risk_level: 'low' | 'medium' | 'high';
  recommended_action: string;
  category?: string;
  executiveSummary?: string;
  aiStrategicRecommendation?: string;
  legalClaims?: string[];
}

function delay(ms: number): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function sendSseEvent(
  controller: ReadableStreamDefaultController,
  event: string,
  data: unknown
): void {
  const encoder = new TextEncoder();
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
}

/**
 * Normalizes article citation string to ensure standard Arabic legal phrasing
 * that verifyCitations() reliably detects (e.g. "م 122 & 69" -> "المادتين 69 و 122").
 */
function formatArticleCitation(rawArticle: string): string {
  if (!rawArticle) return 'المادة القانونية المقررة';
  const trimmed = rawArticle.trim();

  // If already properly phrased in Arabic
  if (trimmed.startsWith('المادة') || trimmed.startsWith('المادتين') || trimmed.startsWith('المادتان')) {
    return trimmed;
  }

  // Extract digits (e.g. "م 122 & 69" -> ["122", "69"])
  const digits = trimmed.match(/\d+/g) || [];
  if (digits.length === 2) {
    return `المادتين ${digits[1]} و ${digits[0]}`;
  }
  if (digits.length === 1) {
    return `المادة ${digits[0]}`;
  }
  if (digits.length > 2) {
    return `المواد ${digits.join(' و ')}`;
  }

  return `المادة ${trimmed.replace(/^[م\s/]+/, '')}`;
}

/**
 * Grounded Egyptian legal answer composition referencing ONLY verified retrieved chunks.
 * Zero fabricated article numbers.
 */
function generateGroundedAnswer(
  message: string,
  evidence: LegalChunk[],
  guard: PreGuardResult
): { text: string; isDisclaimer: boolean } {
  if (!evidence || evidence.length === 0) {
    return {
      text: `بناءً على الفحص الأولي، لم يتم العثور على نص تشريعي صريح أو سابقة قضائية مطابقة في قاعدة البيانات للواقعة المعروضة.\n\n⚖️ **إخلاء مسؤولية استشارية**:\nوفقاً لمبادئ المستشار القانوني، وحرصاً على عدم تقديم تأويل قانوني غير مدعم بنص تشريعي دقيق، يُرجى تزويدنا بمزيد من التفاصيل والوقائع أو مراجعة محامٍ مختص لبحث أوراق النزاع حضورياً.`,
      isDisclaimer: true,
    };
  }

  const top = evidence[0];
  const second = evidence.length > 1 ? evidence[1] : null;

  const topArtFormatted = formatArticleCitation(top.article_number);
  const secondArtFormatted = second ? formatArticleCitation(second.article_number) : null;

  const lines: string[] = [];
  lines.push(`بناءً على نصوص **${top.law_name}** وأحكام **${top.court || 'محكمة النقض المصرية'}**:`);
  lines.push('');
  lines.push('⚖️ **التكييف والرأي القانوني المستقر**:');
  lines.push(`وفقاً لما تقضي به **${topArtFormatted}** من ${top.law_name}:`);
  lines.push(`${top.summary || top.title}.`);

  if (second && secondArtFormatted && second.article_number !== top.article_number) {
    lines.push(`كما تتكامل معها أحكام **${secondArtFormatted}** من ${second.law_name} بشأن شروط وضوابط النزاع الموضوعي.`);
  }

  lines.push('');
  lines.push('📋 **الخطوات والإجراءات الرسمية الموصى بها**:');
  if (top.category === 'labor' || guard.domain === 'labor') {
    lines.push('1. التقدم بشكوى فورية إلى مكتب علاقات العمل المختص خلال المدة القانونية (10 أيام من تاريخ الواقعة).');
    lines.push('2. السعي لتسوية النزاع ودياً، وفي حال تعذر ذلك يُحال الملف إلى المحكمة العمالية المختصة.');
    lines.push('3. تجهيز أصل عقد العمل، كشوف استلام الراتب، والشهود لإثبات واقعة النزاع.');
  } else if (top.category === 'commercial' || guard.domain === 'commercial') {
    lines.push('1. الحصول على إفادة رفض الصرف الرسمية من البنك المسحوب عليه مبيناً بها سبب الرفض.');
    lines.push('2. تحرير محضر بقسم الشرطة أو توكيل محامٍ لرفع جنحة مباشرة خلال المواعيد المقررة قانوناً.');
    lines.push('3. المطالبة بالتعويض المدني المؤقت وقيمة السند محل النزاع.');
  } else {
    lines.push('1. توثيق وحفظ كافة المحررات والمراسلات المؤيدة للموقف القانوني.');
    lines.push('2. توجيه إنذار رسمي على يد محضر بالوفاء بالالتزامات العقدية أو القانونية.');
    lines.push('3. قيد الدعوى القضائية أمام المحكمة المختصة نوعياً ومكانياً.');
  }

  lines.push('');
  lines.push('💡 **السند التشريعي الموثق من واقع قاعدة البيانات التشريعية**:');
  const citedNames = evidence
    .slice(0, 3)
    .map((e) => `${e.law_name} (${formatArticleCitation(e.article_number)})`)
    .join('، ');
  lines.push(`تم الاستناد حصرياً إلى نصوص: ${citedNames}.`);

  return {
    text: lines.join('\n'),
    isDisclaimer: false,
  };
}

/**
 * Extracts structured summary for case brief generation
 */
function extractStructuredSummary(
  message: string,
  evidence: LegalChunk[],
  guard: PreGuardResult,
  isDisclaimer: boolean
): StructuredCaseSummary | null {
  if (isDisclaimer || !evidence || evidence.length === 0) {
    return null;
  }

  const top = evidence[0];
  const topArtFormatted = formatArticleCitation(top.article_number);
  const isLabor =
    guard.domain === 'labor' || top.category === 'labor' || top.law_name.includes('العمل');
  const isCommercial =
    guard.domain === 'commercial' ||
    top.category === 'commercial' ||
    top.law_name.includes('التجارة');

  if (isLabor) {
    return {
      case_type: 'نزاع عمالي - فصل تعسفي ومستحقات',
      risk_level: 'high',
      recommended_action:
        'تقديم شكوى فورية لمكتب علاقات العمل خلال 10 أيام وطلب إحالة النزاع للمحكمة العمالية.',
      category: 'labor',
      executiveSummary: `نزاع عمالي موضوعي يخضع لأحكام ${top.law_name} (${topArtFormatted}). واقعة المطالبة تتعلق بإنهاء الخدمة والحقوق المالية المترتبة.`,
      aiStrategicRecommendation:
        'اتخاذ المسار الإجرائي الرسمي عبر مكتب علاقات العمل ثم رفع دعوى عمالية موضوعية بطلب التعويض المقرر قانوناً ومقابل مهلة الإخطار.',
      legalClaims: [
        `التعويض عن الفصل التعسفي (${topArtFormatted})`,
        'مقابل مهلة الإخطار ورصيد الإجازات السنوية',
        'شهادة نهاية الخدمة وكامل المستحقات المالية المتأخرة',
      ],
    };
  }

  if (isCommercial) {
    return {
      case_type: 'منازعات تجارية - شيك وأوراق تجارية',
      risk_level: 'high',
      recommended_action:
        'استخراج إفادة رفض الصرف من البنك وإقامة جنحة مباشرة أو استصدار أمر أداء.',
      category: 'commercial',
      executiveSummary: `نزاع تجاري متعلق بسند مصرفي يخضع لـ ${topArtFormatted} من ${top.law_name}.`,
      aiStrategicRecommendation:
        'التحرك الجنائي عبر النيابة العامة أو المدني عبر أمر الأداء قبل فوات مواعيد السقوط القانونية.',
      legalClaims: [
        'قيمة السند التجاري محل النزاع',
        'الفوائد القانونية والتعويض عن التأخير',
      ],
    };
  }

  return {
    case_type: `استشارة قانونية - ${guard.domain || 'عامة'}`,
    risk_level: 'medium',
    recommended_action:
      'مراجعة المستندات والعقود وتوجيه إنذار رسمي قبل اتخاذ الإجراءات القضائية.',
    category: guard.domain || 'civil',
    executiveSummary: `استشارة قانونية مدعمة بنصوص ${top.law_name} (${topArtFormatted}).`,
    aiStrategicRecommendation:
      'إثبات الحقوق كتابةً واللجوء للمحكمة المختصة في حال عدم الوفاء الودي.',
    legalClaims: ['المطالبة بالحقوق المقررة قانوناً والتعويض عن الإخلال'],
  };
}

/**
 * Splits Arabic text into incremental UTF-8 chunks without mid-word splits
 */
function chunkArabicText(text: string): string[] {
  if (!text) return [];

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p];
    const lines = paragraph.split('\n');

    for (let l = 0; l < lines.length; l++) {
      const line = lines[l];
      if (!line.trim()) continue;

      if (line.length < 80) {
        chunks.push(line + '\n');
        continue;
      }

      const words = line.split(/\s+/).filter(Boolean);
      let currentChunk: string[] = [];

      for (const word of words) {
        currentChunk.push(word);
        if (
          word.endsWith('.') ||
          word.endsWith(':') ||
          word.endsWith('،') ||
          word.endsWith('؟') ||
          currentChunk.length >= 8
        ) {
          chunks.push(currentChunk.join(' ') + ' ');
          currentChunk = [];
        }
      }

      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(' ') + '\n');
      }
    }

    if (p < paragraphs.length - 1) {
      chunks.push('\n');
    }
  }

  return chunks.filter((c) => c.length > 0);
}

export async function POST(req: NextRequest) {
  const trace_id = req.headers.get('x-trace-id') || newTraceId();
  const run_id = newRunId();
  const session_id = req.headers.get('x-session-id') || null;

  return runLlmOpsContext(
    {
      trace_id,
      run_id,
      session_id,
      user_id_hash: hashId('demo-user'),
      persona: 'client',
      mode: 'chat_fast',
      route: '/api/ai/chat/stream',
    },
    async () => {
      const t_start = Date.now();
      let user: { id: string; email?: string } | null = null;

      try {
        // 1. Authentication & Session Verification
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        const credentialsExist = Boolean(
          supabaseUrl &&
            supabaseAnonKey &&
            !supabaseUrl.includes('placeholder') &&
            !supabaseUrl.includes('arabic-law-rag-demo')
        );

        if (credentialsExist) {
          try {
            const supabase = createServerClient(req);
            const { data, error: authError } = await supabase.auth.getUser();

            if (authError || !data?.user) {
              llmopsLogger.warn(LLMOPS_EVENTS.AUTH_FAIL, { reason: authError?.message || 'UNAUTHORIZED' });
              llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, { outcome: 'error', duration_ms: Date.now() - t_start });
              try {
                await runStore.finishRun(run_id, { outcome: 'error', t_total_ms: Date.now() - t_start, error_code: 'UNAUTHORIZED' });
              } catch (e) {
                console.error('[LLMOps] finishRun failed:', e);
              }
              return NextResponse.json(
                { error: 'غير مصرح بالدخول. يرجى تسجيل الدخول أولاً.', code: 'UNAUTHORIZED' },
                { status: 401, headers: { 'X-Trace-Id': trace_id } }
              );
            }
            user = data.user;
            updateLlmOpsContext({ user_id_hash: hashId(user.id) });
            llmopsLogger.info(LLMOPS_EVENTS.AUTH_OK, { user_id_hash: hashId(user.id) });
          } catch (err) {
            console.error('[AUTH ERROR] Supabase verification failed:', err);
            llmopsLogger.warn(LLMOPS_EVENTS.AUTH_FAIL, { reason: err instanceof Error ? err.message : 'UNAUTHORIZED' });
            llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, { outcome: 'error', duration_ms: Date.now() - t_start });
            try {
              await runStore.finishRun(run_id, { outcome: 'error', t_total_ms: Date.now() - t_start, error_code: 'UNAUTHORIZED' });
            } catch (e) {
              console.error('[LLMOps] finishRun failed:', e);
            }
            return NextResponse.json(
              { error: 'غير مصرح بالدخول. يرجى تسجيل الدخول أولاً.', code: 'UNAUTHORIZED' },
              { status: 401, headers: { 'X-Trace-Id': trace_id } }
            );
          }
        } else {
          // Demo / offline mode: permit guest access with audit warning
          try {
            const supabase = createServerClient(req);
            if (supabase?.auth?.getUser) {
              const { data, error: authError } = await supabase.auth.getUser();
              if (authError) {
                llmopsLogger.warn(LLMOPS_EVENTS.AUTH_FAIL, { reason: authError.message });
                llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, { outcome: 'error', duration_ms: Date.now() - t_start });
                try {
                  await runStore.finishRun(run_id, { outcome: 'error', t_total_ms: Date.now() - t_start, error_code: 'UNAUTHORIZED' });
                } catch (e) {
                  console.error('[LLMOps] finishRun failed:', e);
                }
                return NextResponse.json(
                  { error: 'غير مصرح بالدخول. يرجى تسجيل الدخول أولاً.', code: 'UNAUTHORIZED' },
                  { status: 401, headers: { 'X-Trace-Id': trace_id } }
                );
              }
              if (data?.user) {
                user = data.user;
                updateLlmOpsContext({ user_id_hash: hashId(user.id) });
                llmopsLogger.info(LLMOPS_EVENTS.AUTH_OK, { user_id_hash: hashId(user.id) });
              }
            }
          } catch {
            // Fall back gracefully in unconfigured offline demo mode
          }

          if (!user) {
            console.warn(
              '[SECURITY AUDIT] /api/ai/chat/stream accessed in DEMO/OFFLINE mode without Supabase credentials. Permitting guest access.'
            );
          }
        }

        // 2. Sliding-Window Rate Limiting (30 requests/minute)
        const forwardedFor = req.headers.get('x-forwarded-for');
        const realIp = req.headers.get('x-real-ip');
        const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : realIp || '127.0.0.1';
        const identifier = user?.id || clientIp;

        const rateLimit = checkRateLimit(identifier);
        if (!rateLimit.allowed) {
          llmopsLogger.warn(LLMOPS_EVENTS.RATELIMIT_HIT, {
            limit: 30,
            window: '60s',
            retry_after: Math.ceil(rateLimit.resetMs / 1000),
          });
          llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, { outcome: 'error', duration_ms: Date.now() - t_start });
          try {
            await runStore.finishRun(run_id, { outcome: 'error', t_total_ms: Date.now() - t_start, error_code: 'RATE_LIMIT_EXCEEDED' });
          } catch (e) {
            console.error('[LLMOps] finishRun failed:', e);
          }
          return NextResponse.json(
            {
              error:
                'لقد تجاوزت الحد المسموح به من الاستشارات (30 طلب في الدقيقة). يرجى الانتظار قليلاً ثم المحاولة مرة أخرى.',
              message: 'Too Many Requests',
              retryAfter: Math.ceil(rateLimit.resetMs / 1000),
            },
            {
              status: 429,
              headers: {
                'Retry-After': Math.ceil(rateLimit.resetMs / 1000).toString(),
                'X-RateLimit-Limit': '30',
                'X-RateLimit-Remaining': rateLimit.remaining.toString(),
                'X-RateLimit-Reset': rateLimit.resetMs.toString(),
                'X-Trace-Id': trace_id,
              },
            }
          );
        }

        // 3. Parse Request Payload
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, { outcome: 'error', duration_ms: Date.now() - t_start });
          try {
            await runStore.finishRun(run_id, { outcome: 'error', t_total_ms: Date.now() - t_start, error_code: 'BAD_REQUEST' });
          } catch (e) {
            console.error('[LLMOps] finishRun failed:', e);
          }
          return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400, headers: { 'X-Trace-Id': trace_id } });
        }

        const message =
          body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
            ? body.message
            : null;

        if (!message || !message.trim()) {
          llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, { outcome: 'error', duration_ms: Date.now() - t_start });
          try {
            await runStore.finishRun(run_id, { outcome: 'error', t_total_ms: Date.now() - t_start, error_code: 'BAD_REQUEST' });
          } catch (e) {
            console.error('[LLMOps] finishRun failed:', e);
          }
          return NextResponse.json({ error: 'Message is required' }, { status: 400, headers: { 'X-Trace-Id': trace_id } });
        }

        const trimmedMsg = message.trim();

        try {
          const versions = resolveVersions();
          await runStore.startRun({
            id: run_id,
            trace_id,
            session_id,
            user_id: user?.id || 'demo-user',
            persona: 'client',
            mode: 'chat_fast',
            route: '/api/ai/chat/stream',
            git_sha: versions.app_git_sha,
            prompt_version: versions.prompt_version,
            model_id: versions.model_id,
            rag_index_version: versions.rag_index_version,
            guard_version: versions.guard_version,
          });
        } catch (err) {
          console.error('[LLMOps] startRun failed:', err);
        }

        llmopsLogger.info(LLMOPS_EVENTS.REQUEST_START, {
          mode: 'chat_fast',
          locale: 'ar',
          message_len: trimmedMsg.length,
          history_turns: 0,
        });

        // 4. Initialize SSE Stream Pipeline
        const stream = new ReadableStream({
          async start(controller) {
            let isAborted = false;
            const abortListener = () => {
              isAborted = true;
            };
            req.signal.addEventListener('abort', abortListener);

            const cleanup = () => {
              req.signal.removeEventListener('abort', abortListener);
            };

            await runLlmOpsContext(
              {
                trace_id,
                run_id,
                session_id,
                user_id_hash: user ? hashId(user.id) : hashId('demo-user'),
                persona: 'client',
                mode: 'chat_fast',
                route: '/api/ai/chat/stream',
              },
              async () => {
                try {
                  // Pipeline Step 1: Pre-guard check
                  llmopsLogger.info(LLMOPS_EVENTS.GUARD_PRE_START, { query_length: trimmedMsg.length });
                  const t_guard_start = Date.now();
                  const guardResult = preGuard(trimmedMsg);
                  const t_guard = Date.now() - t_guard_start;

                  llmopsLogger.info(LLMOPS_EVENTS.GUARD_PRE_DONE, {
                    is_legal: guardResult.is_legal,
                    domain: guardResult.domain,
                    confidence: guardResult.confidence,
                    mapped_concepts_count: guardResult.mapped_legal_concepts?.length || 0,
                    latency_ms: t_guard,
                  });

                  if (!guardResult.is_legal) {
                    llmopsLogger.info(LLMOPS_EVENTS.GUARD_PRE_REFUSE, {
                      reject_reason: guardResult.reject_reason || 'OOD',
                    });

                    sendSseEvent(controller, 'metadata', {
                      trace_id,
                      domain: 'non_legal',
                      citations: [],
                    });
                    llmopsLogger.info(LLMOPS_EVENTS.STREAM_METADATA_EMITTED, { citation_count: 0 });

                    const rejectionText = guardResult.reject_reason || DEFAULT_REJECT_REASON;
                    const chunks = chunkArabicText(rejectionText);
                    let ttft_ms = 0;

                    for (let i = 0; i < chunks.length; i++) {
                      if (isAborted || req.signal.aborted) {
                        cleanup();
                        controller.close();
                        llmopsLogger.info(LLMOPS_EVENTS.STREAM_DONE, {
                          tokens_streamed: i,
                          t_total_ms: Date.now() - t_start,
                          client_disconnect: true,
                        });
                        llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, {
                          outcome: 'interrupted',
                          t_total_ms: Date.now() - t_start,
                          duration_ms: Date.now() - t_start,
                        });
                        try {
                          await runStore.finishRun(run_id, {
                            outcome: 'interrupted',
                            ttft_ms,
                            t_total_ms: Date.now() - t_start,
                            domain: 'non_legal',
                            is_legal: false,
                          });
                        } catch (e) {
                          console.error('[LLMOps] finishRun failed:', e);
                        }
                        return;
                      }
                      if (i === 0) {
                        ttft_ms = Date.now() - t_start;
                        llmopsLogger.info(LLMOPS_EVENTS.STREAM_FIRST_TOKEN, { ttft_ms });
                      }
                      sendSseEvent(controller, 'token', { text: chunks[i] });
                      await delay(15);
                    }

                    const t_total = Date.now() - t_start;
                    const timings = {
                      t_guard,
                      t_retrieval: 0,
                      t_metadata_emit: t_guard,
                      ttft_ms: ttft_ms || t_guard,
                      t_total,
                    };

                    sendSseEvent(controller, 'done', {
                      status: 'complete',
                      timings,
                    });
                    controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));

                    llmopsLogger.info(LLMOPS_EVENTS.STREAM_DONE, {
                      tokens_streamed: chunks.length,
                      t_total_ms: t_total,
                      client_disconnect: isAborted || req.signal.aborted,
                    });

                    llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, {
                      outcome: 'refuse',
                      t_total_ms: t_total,
                      duration_ms: t_total,
                    });

                    try {
                      await runStore.finishRun(run_id, {
                        outcome: 'refuse',
                        ttft_ms,
                        t_total_ms: t_total,
                        domain: 'non_legal',
                        is_legal: false,
                      });
                    } catch (e) {
                      console.error('[LLMOps] finishRun failed:', e);
                    }

                    console.log(
                      '[AI STREAM TIMINGS]',
                      JSON.stringify({
                        trace_id,
                        domain: 'non_legal',
                        timings,
                        evidence_count: 0,
                      })
                    );

                    cleanup();
                    controller.close();
                    return;
                  }

                  // Pipeline Step 2: Retrieve Legal Evidence from legalRag.ts
                  llmopsLogger.info(LLMOPS_EVENTS.RETRIEVE_START, { query: trimmedMsg });
                  const t_retrieval_start = Date.now();
                  const retrievalResult = await retrieveLegalEvidence(trimmedMsg, {
                    topK: 5,
                    domain: guardResult.domain || undefined,
                  });
                  const t_retrieval = Date.now() - t_retrieval_start;
                  const evidence = retrievalResult.evidence;

                  llmopsLogger.info(LLMOPS_EVENTS.RETRIEVE_DONE, {
                    top_chunk_ids: evidence.map((e) => e.id),
                    top_scores: evidence.map((e) => e.confidenceScore || e.score || 0.8),
                    empty: evidence.length === 0,
                    latency_ms: t_retrieval,
                    n_rerank: evidence.length,
                  });

                  // Map evidence to LegalCitation format
                  const citations: LegalCitation[] = evidence.map((chunk) => ({
                    id: `cit-${chunk.id}`,
                    title: chunk.title,
                    lawName: chunk.law_name,
                    court: chunk.court || 'محكمة النقض المصرية',
                    articleNumber: chunk.article_number,
                    summary: chunk.summary || chunk.title,
                    fullText: chunk.text,
                    category: (chunk.category as LegalCategory) || 'labor',
                    relevanceScore: Math.round(
                      (chunk.confidenceScore || chunk.score || 0.8) * 100
                    ),
                  }));

                  // Pipeline Step 3: Emit metadata immediately after retrieval (TTFT optimization)
                  sendSseEvent(controller, 'metadata', {
                    trace_id,
                    domain: guardResult.domain,
                    citations,
                  });
                  llmopsLogger.info(LLMOPS_EVENTS.STREAM_METADATA_EMITTED, {
                    citation_count: citations.length,
                  });
                  const t_metadata_emit = Date.now() - t_start;

                  // Pipeline Step 4: Local generation grounded in evidence
                  const { text: rawAnswer, isDisclaimer } = generateGroundedAnswer(
                    trimmedMsg,
                    evidence,
                    guardResult
                  );

                  // Pipeline Step 5: Post-guard citation verification
                  llmopsLogger.info(LLMOPS_EVENTS.GUARD_POST_START, {});
                  const t_post_start = Date.now();
                  const guardPost = postGuard(rawAnswer, evidence);
                  const t_post = Date.now() - t_post_start;
                  const evidence_score = guardPost.evidence_score;
                  const outcome: 'success' | 'disclaimer' | 'refuse' | 'error' | 'interrupted' =
                    guardPost.action === 'disclaimer' || isDisclaimer ? 'disclaimer' : 'success';

                  const verifiedCount = guardPost.verified_citations.length;
                  const rejectedCount = guardPost.unverified_citations?.length || 0;
                  llmopsLogger.info(LLMOPS_EVENTS.GUARD_POST_DONE, {
                    citations_checked: verifiedCount + rejectedCount,
                    verified: verifiedCount,
                    rejected: rejectedCount,
                    evidence_score: guardPost.evidence_score,
                    action: guardPost.action,
                    latency_ms: t_post,
                  });

                  const finalAnswer = guardPost.cleaned_text;

                  // Pipeline Step 6: Stream Arabic tokens incrementally without mid-word splits
                  const textChunks = chunkArabicText(finalAnswer);
                  let ttft_ms = 0;

                  for (let i = 0; i < textChunks.length; i++) {
                    if (isAborted || req.signal.aborted) {
                      cleanup();
                      controller.close();
                      llmopsLogger.info(LLMOPS_EVENTS.STREAM_DONE, {
                        tokens_streamed: i,
                        t_total_ms: Date.now() - t_start,
                        client_disconnect: true,
                      });
                      llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, {
                        outcome: 'interrupted',
                        t_total_ms: Date.now() - t_start,
                        duration_ms: Date.now() - t_start,
                      });
                      try {
                        await runStore.finishRun(run_id, {
                          outcome: 'interrupted',
                          ttft_ms,
                          t_total_ms: Date.now() - t_start,
                          evidence_score,
                          domain: guardResult.domain,
                          is_legal: true,
                        });
                      } catch (e) {
                        console.error('[LLMOps] finishRun failed:', e);
                      }
                      return;
                    }
                    if (i === 0) {
                      ttft_ms = Date.now() - t_start;
                      llmopsLogger.info(LLMOPS_EVENTS.STREAM_FIRST_TOKEN, { ttft_ms });
                    }
                    sendSseEvent(controller, 'token', { text: textChunks[i] });
                    await delay(15);
                  }

                  // Pipeline Step 7: Emit individual citation events for verified binds
                  for (const chunk of evidence) {
                    if (isAborted || req.signal.aborted) break;
                    sendSseEvent(controller, 'citation', {
                      chunk_id: chunk.id,
                      article_number: chunk.article_number,
                      law_name: chunk.law_name,
                    });
                  }

                  // Pipeline Step 8: Emit structured summary if case brief is extractable
                  const structuredSummary = extractStructuredSummary(
                    trimmedMsg,
                    evidence,
                    guardResult,
                    isDisclaimer || guardPost.action === 'disclaimer'
                  );
                  if (structuredSummary) {
                    sendSseEvent(controller, 'structured_summary', structuredSummary);
                  }

                  // Pipeline Step 9: Emit done event with complete timings
                  const t_total = Date.now() - t_start;
                  const timings = {
                    t_guard,
                    t_retrieval,
                    t_metadata_emit,
                    ttft_ms: ttft_ms || Date.now() - t_start,
                    t_total,
                  };

                  sendSseEvent(controller, 'done', {
                    status: 'complete',
                    timings,
                  });
                  controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));

                  llmopsLogger.info(LLMOPS_EVENTS.STREAM_DONE, {
                    tokens_streamed: textChunks.length,
                    t_total_ms: t_total,
                    client_disconnect: isAborted || req.signal.aborted,
                  });

                  const finalOutcome = isAborted || req.signal.aborted ? 'interrupted' : outcome;
                  llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, {
                    outcome: finalOutcome,
                    t_total_ms: t_total,
                    duration_ms: t_total,
                  });

                  try {
                    await runStore.finishRun(run_id, {
                      outcome: finalOutcome,
                      ttft_ms,
                      t_total_ms: t_total,
                      evidence_score,
                      domain: guardResult.domain,
                      is_legal: true,
                    });
                  } catch (e) {
                    console.error('[LLMOps] finishRun failed:', e);
                  }

                  console.log(
                    '[AI STREAM TIMINGS]',
                    JSON.stringify({
                      trace_id,
                      domain: guardResult.domain,
                      timings,
                      evidence_count: evidence.length,
                      verified_citations_count: guardPost.verified_citations.length,
                    })
                  );

                  cleanup();
                  controller.close();
                } catch (err: unknown) {
                  console.error('[AI STREAM ERROR] Streaming pipeline failure:', err);
                  llmopsLogger.error(
                    LLMOPS_EVENTS.REQUEST_DONE,
                    { outcome: 'error', duration_ms: Date.now() - t_start },
                    err
                  );
                  try {
                    await runStore.finishRun(run_id, {
                      outcome: 'error',
                      t_total_ms: Date.now() - t_start,
                      error_code: 'STREAM_PROCESSING_ERROR',
                    });
                  } catch (e) {
                    console.error('[LLMOps] finishRun failed:', e);
                  }
                  try {
                    sendSseEvent(controller, 'error', {
                      error:
                        'حدث خطأ غير متوقع أثناء معالجة الاستشارة القانونية. يرجى المحاولة مرة أخرى.',
                      code: 'STREAM_PROCESSING_ERROR',
                    });
                    controller.close();
                  } catch {
                    // Stream might already be closed
                  }
                  cleanup();
                }
              }
            );
          },
          cancel() {
            // Handled via isAborted flag
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Trace-Id': trace_id,
          },
        });
      } catch (error) {
        console.error('Fatal Stream API Error:', error);
        llmopsLogger.error(
          LLMOPS_EVENTS.REQUEST_DONE,
          { outcome: 'error', duration_ms: Date.now() - t_start },
          error
        );
        try {
          await runStore.finishRun(run_id, {
            outcome: 'error',
            t_total_ms: Date.now() - t_start,
            error_code: 'INTERNAL_ERROR',
          });
        } catch (e) {
          console.error('[LLMOps] finishRun failed:', e);
        }
        return NextResponse.json(
          { error: 'حدث خطأ أثناء معالجة الاستشارة القانونية.' },
          { status: 500, headers: { 'X-Trace-Id': trace_id } }
        );
      }
    }
  );
}
