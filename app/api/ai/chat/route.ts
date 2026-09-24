import { NextRequest, NextResponse } from 'next/server';
import { LegalCitation } from '@/lib/types';
import { EGYPTIAN_COMPREHENSIVE_LEGAL_DATABASE, ComprehensiveLegalEntry } from '@/lib/data/legalData';
import { createServerClient } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/ai/rateLimiter';
import { preGuard, postGuard } from '@/lib/ai/safety/legalGuard';
import { retrieveLegalEvidence } from '@/lib/ai/legalRag';
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

// System prompt defining strict legal boundaries and Karnak integration guidelines
const LEGAL_SYSTEM_PROMPT = `أنت "المستشار القانوني حِكِمْدار"، نظام ذكاء اصطناعي سيادي متخصص حصرياً في القوانين والتشريعات والدستور المصري وقضاء محكمة النقض والمحكمة الدستورية العليا والقضاء العسكري ومجلس الدولة.

أسلوبك في العمل والتحقيق القانوني:
1. الدقة والواقعية: استند دائماً إلى أرقام مواد القوانين المصرية ونصوصها الحرفية دون أي خطأ.
2. التفاعل الاستيضاحي: عندما يطرح الموكل واقعة تحتاج لتوضيح، سله عن التفاصيل المحورية قبل الحكم النهائي.
3. التوجيه الإجرائي: وضّح للمواطن الخطوات القضائية العملية (أين يتوجه، ما هي المستندات، وما هي المواعيد القانونية لسقوط الحق).
4. حارس النطاق (Guardrail): إذا كان السؤال خارج إطار القانون والتقاضي (طبخ، برمجة، رياضة)، ارفض الإجابة بلباقة وأكد تخصصك القانوني الحصري.`;


// Semantic Matching and Scoring against the Egyptian Legal Encyclopedia
function findBestLegalMatch(queryText: string, historyContext: string): ComprehensiveLegalEntry | null {
  const combined = (queryText + ' ' + historyContext).toLowerCase();

  let bestMatch: ComprehensiveLegalEntry | null = null;
  let highestScore = 0;

  for (const entry of EGYPTIAN_COMPREHENSIVE_LEGAL_DATABASE) {
    let score = 0;

    // Check keyword matches
    for (const kw of entry.keywords) {
      if (combined.includes(kw.toLowerCase())) {
        score += 10;
      }
    }

    // Check subcategory and title matches
    if (combined.includes(entry.category.toLowerCase())) score += 5;
    if (combined.includes(entry.subCategory.toLowerCase())) score += 8;

    if (score > highestScore && score >= 10) {
      highestScore = score;
      bestMatch = entry;
    }
  }

  return bestMatch;
}

// Conversational Dynamic Legal Reasoning Engine
function processInteractiveLegalReasoning(message: string, history: Array<{ sender: string; text: string }>) {
  const query = message.trim();
  const lowerQuery = query.toLowerCase();

  // Combine full dialogue history for accurate context continuity
  const previousUserMessages = history.filter((h) => h.sender === 'user').map((h) => h.text.toLowerCase());
  const historyContext = previousUserMessages.join(' ');
  const allContext = [historyContext, lowerQuery].join(' ');

  // 1. Check matched law entry in Egyptian database
  const matchedEntry = findBestLegalMatch(lowerQuery, historyContext);

  if (matchedEntry) {
    // Generate specialized interactive response
    const reply = `بناءً على نصوص **${matchedEntry.codeName}** وأحكام **${matchedEntry.court}** (${matchedEntry.articles}):

⚖️ **التكييف والرأي القانوني المستقر**:
${matchedEntry.legalAnalysis}

📋 **الخطوات والإجراءات الرسمية الموصى بها**:
${matchedEntry.proceduralSteps.map((step, idx) => `${idx + 1}. ${step}`).join('\n')}

💡 **السند التشريعي الموثق**:
${matchedEntry.title}

هل تود تحويل هذه المعطيات إلى **ملف قضية رسمي (Case Brief)** وإرساله لأحد المحامين المتخصصين المعتمدين في شبكة حِكِمْدار؟`;

    return {
      reply,
      citations: matchedEntry.citations,
      caseBriefReady: true,
    };
  }

  // 2. Default Dynamic Legal Analysis for complex custom legal queries
  return {
    reply: `أهلاً بك، بصفتي **المستشار القانوني لمنصة حِكِمْدار**، قمت بتحليل استشارتك: "${query}".

وفقاً للقواعد العامة في **التشريع المصري وقانون الإثبات في المواد المدنية والتجارية رقم 25 لسنة 1968**:

1. **المركز القانوني والتكييف الأولي**:
   الواقعة المعروضة تخضع للاختصاص القضائي لمحاكم الموضوع، ويثبت الحق بكافة طرق الإثبات المقررة قانوناً (الكتابة، شهادة الشهود، أو القرائن القضائية).

2. **الاستيضاح المطلوب لتحديد المادة القانونية بدقة**:
   - ما هي صفتك المباشرة في النزاع (مدعي / متهم / متضرر / شريك)؟
   - هل توجد عقود، إيصالات، أو محررات رسمية محررة بين أطراف الواقعة؟
   - ما هو المطلب المالي أو القضائي المباشر الذي تسعى إليه؟

أخبرني بهذه التفاصيل وسأقوم فوراً بربط الواقعة برقم المادة الدقيقة في القانون المصري وسوابق محكمة النقض المنطبقة عليها.`,
    citations: [
      {
        id: 'cit-evidence-general',
        title: 'قانون الإثبات في المواد المدنية والتجارية رقم 25 لسنة 1968',
        lawName: 'قانون الإثبات المصري',
        court: 'محكمة النقض المصرية',
        articleNumber: 'المادة 1 والمادة 60',
        summary: 'قواعد توزيع عبء الإثبات وحجية المحررات الرسمية والعرفية أمام القضاء.',
        category: 'civil',
        relevanceScore: 90,
      }
    ],
    caseBriefReady: true,
  };
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
      route: '/api/ai/chat',
    },
    async () => {
      const t_start = Date.now();
      let outcome: 'success' | 'disclaimer' | 'refuse' | 'error' | 'interrupted' = 'success';
      let evidence_score: number | null = null;
      let domain: string | null = null;
      let is_legal: boolean | null = null;
      let error_code: string | null = null;

      try {
        const versions = resolveVersions();
        await runStore.startRun({
          id: run_id,
          trace_id,
          session_id,
          user_id: 'demo-user',
          persona: 'client',
          mode: 'chat_fast',
          route: '/api/ai/chat',
          git_sha: versions.app_git_sha,
          prompt_version: versions.prompt_version,
          model_id: versions.model_id,
          rag_index_version: versions.rag_index_version,
          guard_version: versions.guard_version,
        });
      } catch (err) {
        console.error('[LLMOps] Failed to start run in store:', err);
      }

      llmopsLogger.info(LLMOPS_EVENTS.REQUEST_START, {
        mode: 'chat_fast',
        locale: 'ar',
        message_len: 0,
        history_turns: 0,
      });

      try {
        // 1. Authentication & Session Verification
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        const credentialsExist = Boolean(
          supabaseUrl &&
          supabaseAnonKey &&
          !supabaseUrl.includes('placeholder') &&
          !supabaseUrl.includes('hakmdar-demo')
        );

        let user: { id: string; email?: string } | null = null;

        if (credentialsExist) {
          try {
            const supabase = createServerClient(req);
            const { data, error: authError } = await supabase.auth.getUser();

            if (authError || !data?.user) {
              llmopsLogger.warn(LLMOPS_EVENTS.AUTH_FAIL, { reason: authError?.message || 'UNAUTHORIZED' });
              outcome = 'error';
              error_code = 'UNAUTHORIZED';
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
            outcome = 'error';
            error_code = 'UNAUTHORIZED';
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
                outcome = 'error';
                error_code = 'UNAUTHORIZED';
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
            console.warn('[SECURITY AUDIT] /api/ai/chat accessed in DEMO/OFFLINE mode without Supabase credentials. Permitting guest access.');
          }
        }

        // 2. Sliding-Window Rate Limiting (30 requests/minute)
        const forwardedFor = req.headers.get('x-forwarded-for');
        const realIp = req.headers.get('x-real-ip');
        const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : (realIp || '127.0.0.1');
        const identifier = user?.id || clientIp;

        const rateLimit = checkRateLimit(identifier);
        if (!rateLimit.allowed) {
          llmopsLogger.warn(LLMOPS_EVENTS.RATELIMIT_HIT, {
            limit: 30,
            window: '60s',
            retry_after: Math.ceil(rateLimit.resetMs / 1000),
          });
          outcome = 'error';
          error_code = 'RATE_LIMIT_EXCEEDED';
          return NextResponse.json(
            {
              error: 'لقد تجاوزت الحد المسموح به من الاستشارات (30 طلب في الدقيقة). يرجى الانتظار قليلاً ثم المحاولة مرة أخرى.',
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

        const { message, history } = await req.json();

        if (!message || typeof message !== 'string') {
          outcome = 'error';
          error_code = 'BAD_REQUEST';
          return NextResponse.json({ error: 'Message is required' }, { status: 400, headers: { 'X-Trace-Id': trace_id } });
        }

        const trimmedMsg = message.trim();

        // 1. Guardrail: Legal Domain Guard (HKM-AI-02)
        llmopsLogger.info(LLMOPS_EVENTS.GUARD_PRE_START, { query_length: trimmedMsg.length });
        const t_pre_start = Date.now();
        const guardResult = preGuard(trimmedMsg);
        const t_pre = Date.now() - t_pre_start;

        is_legal = guardResult.is_legal;
        domain = guardResult.domain || null;

        llmopsLogger.info(LLMOPS_EVENTS.GUARD_PRE_DONE, {
          is_legal: guardResult.is_legal,
          domain: guardResult.domain,
          confidence: guardResult.confidence,
          mapped_concepts_count: guardResult.mapped_legal_concepts?.length || 0,
          latency_ms: t_pre,
        });

        if (!guardResult.is_legal) {
          outcome = 'refuse';
          llmopsLogger.info(LLMOPS_EVENTS.GUARD_PRE_REFUSE, {
            reject_reason: guardResult.reject_reason || 'OOD',
          });
          return NextResponse.json({
            reply: guardResult.reject_reason || `⚖️ **تنبيه التخصص القانوني:**\n\nعذراً، أنا **المستشار القانوني حِكِمْدار**، نظام ذكاء اصطناعي مخصص ومقيد حصرياً للإجابة على **الاستفسارات القانونية، التشريعية، الدستورية، وإجراءات التقاضي في جمهورية مصر العربية**.\n\nيرجى طرح استفسار يتعلق بموضوع قانوني (مثل: قضايا العمل، العقود، الشركات، الشيكات، الإيجارات، أو الحقوق الدستورية).`,
            citations: [],
            caseBriefReady: false,
          }, { headers: { 'X-Trace-Id': trace_id } });
        }

        // 2. Retrieval from Legal Evidence
        llmopsLogger.info(LLMOPS_EVENTS.RETRIEVE_START, { query: trimmedMsg });
        const t_ret_start = Date.now();
        const retrievalResult = await retrieveLegalEvidence(trimmedMsg, {
          topK: 5,
          domain: guardResult.domain || undefined,
        });
        const t_ret = Date.now() - t_ret_start;

        llmopsLogger.info(LLMOPS_EVENTS.RETRIEVE_DONE, {
          top_chunk_ids: retrievalResult.evidence.map((e) => e.id),
          top_scores: retrievalResult.evidence.map((e) => e.confidenceScore || e.score || 0.8),
          empty: retrievalResult.evidence.length === 0,
          latency_ms: t_ret,
          n_rerank: retrievalResult.evidence.length,
        });

        // 3. External Karnak/LLM Endpoint if active
        const externalApiUrl = process.env.KARNAK_API_URL || process.env.AI_INFERENCE_URL;
        const externalApiKey = process.env.KARNAK_API_KEY || process.env.AI_INFERENCE_KEY;

        if (externalApiUrl) {
          try {
            const payload = {
              model: 'Applied-Innovation-Center/Karnak-40B-v1.0',
              messages: [
                { role: 'system', content: LEGAL_SYSTEM_PROMPT },
                ...(Array.isArray(history) ? history.slice(-6).map((h: any) => ({
                  role: h.sender === 'assistant' ? 'assistant' : 'user',
                  content: h.text || ''
                })) : []),
                { role: 'user', content: trimmedMsg }
              ],
              temperature: 0.2,
              max_tokens: 1500,
            };

            const response = await fetch(externalApiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(externalApiKey ? { 'Authorization': `Bearer ${externalApiKey}` } : {})
              },
              body: JSON.stringify(payload),
            });

            if (response.ok) {
              const aiData = await response.json();
              const replyContent = aiData.choices?.[0]?.message?.content || aiData.generated_text || '';
              if (replyContent) {
                const t_post_start = Date.now();
                llmopsLogger.info(LLMOPS_EVENTS.GUARD_POST_START, {});
                const guardPost = postGuard(replyContent, retrievalResult.evidence);
                const t_post = Date.now() - t_post_start;
                evidence_score = guardPost.evidence_score;
                if (guardPost.action === 'disclaimer') {
                  outcome = 'disclaimer';
                }
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
                return NextResponse.json({
                  reply: replyContent,
                  citations: [],
                  caseBriefReady: true,
                }, { headers: { 'X-Trace-Id': trace_id } });
              }
            }
          } catch (externalErr) {
            console.warn('External Karnak AI endpoint offline, using comprehensive local legal RAG engine:', externalErr);
          }
        }

        // 4. High-Precision Egyptian Legal Encyclopedia & RAG Engine
        const result = processInteractiveLegalReasoning(trimmedMsg, Array.isArray(history) ? history : []);

        const t_post_start = Date.now();
        llmopsLogger.info(LLMOPS_EVENTS.GUARD_POST_START, {});
        const guardPost = postGuard(result.reply, retrievalResult.evidence);
        const t_post = Date.now() - t_post_start;
        evidence_score = guardPost.evidence_score;
        if (guardPost.action === 'disclaimer') {
          outcome = 'disclaimer';
        }
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
        return NextResponse.json(result, { headers: { 'X-Trace-Id': trace_id } });
      } catch (error) {
        console.error('Legal AI Chat API Error:', error);
        outcome = 'error';
        error_code = 'INTERNAL_ERROR';
        return NextResponse.json(
          { error: 'حدث خطأ أثناء معالجة الاستشارة القانونية.' },
          { status: 500, headers: { 'X-Trace-Id': trace_id } }
        );
      } finally {
        const t_total_ms = Date.now() - t_start;
        llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, {
          outcome,
          t_total_ms,
          duration_ms: t_total_ms,
        });
        try {
          await runStore.finishRun(run_id, {
            outcome,
            t_total_ms,
            evidence_score,
            domain,
            is_legal,
            error_code,
          });
        } catch (storeErr) {
          console.error('[LLMOps] Failed to finish run in store:', storeErr);
        }
      }
    }
  );
}
