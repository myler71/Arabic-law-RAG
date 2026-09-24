import { NextRequest, NextResponse } from 'next/server';
import { MOCK_LAWYERS } from '@/lib/data/lawyersData';
import { LegalCategory, LawyerMatchResult } from '@/lib/types';
import {
  runLlmOpsContext,
  newTraceId,
  newRunId,
  hashId,
  resolveVersions,
  llmopsLogger,
  LLMOPS_EVENTS,
  runStore,
} from '@/lib/llmops';


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
      route: '/api/ai/match',
    },
    async () => {
      const t_start = Date.now();
      let outcome: 'success' | 'disclaimer' | 'refuse' | 'error' | 'interrupted' = 'success';
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
          route: '/api/ai/match',
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
        message_len: 0,
        history_turns: 0,
      });

      try {
        const body = (await req.json()) as {
          category?: string;
          location?: string;
          caseDescription?: string;
          budget?: string | number;
        };
        const { category, location, caseDescription } = body;

        const cat = (category || 'labor') as LegalCategory;
        const locLower = (location || '').toLowerCase();
        const descLower = (caseDescription || '').toLowerCase();

        const scoredLawyers: LawyerMatchResult[] = MOCK_LAWYERS.map((lawyer) => {
          let score = 70; // baseline
          const matchReasons: string[] = [];

          // Specialty match
          if (lawyer.specialties.includes(cat)) {
            score += 20;
            matchReasons.push(`تخصص دقيق ومعتمد في ${cat === 'labor' ? 'قضايا العمل' : cat === 'criminal' ? 'القانون الجنائي' : cat === 'corporate' ? 'قضايا الشركات' : cat === 'family' ? 'الأحوال الشخصية' : 'القانون المدني'}`);
          }

          // Location match
          if (locLower && (lawyer.location.toLowerCase().includes(locLower) || locLower.includes('مصر') || locLower.includes('قاهرة'))) {
            score += 5;
            matchReasons.push(`نطاق الممارسة الجغرافية يغطي موقعك (${lawyer.location})`);
          }

          // Experience & Win rate bonus
          if (lawyer.winRate >= 94) {
            score += 5;
            matchReasons.push(`نسبة نجاح استثنائية بلغت ${lawyer.winRate}% في القضايا المماثلة`);
          }

          if (lawyer.experienceYears >= 15) {
            matchReasons.push(`خبرة قضائية تتجاوز ${lawyer.experienceYears} عاماً أمام محاكم الاستئناف والنقض`);
          }

          const costRange = lawyer.consultationFee <= 600 ? 'اقتصادي - مناسب للميزانية' : lawyer.consultationFee <= 800 ? 'متوسط - أتعاب قياسية' : 'متميز - كبار المستشارين';

          return {
            lawyer,
            matchScore: Math.min(score, 99),
            matchReasons,
            estimatedCostRange: `${lawyer.consultationFee} ج.م للاستشارة الأولى (${costRange})`,
          };
        });

        // Sort descending by score
        scoredLawyers.sort((a, b) => b.matchScore - a.matchScore);

        return NextResponse.json(
          {
            matches: scoredLawyers.slice(0, 3),
            totalMatches: scoredLawyers.length,
            category: cat,
          },
          { headers: { 'X-Trace-Id': trace_id } }
        );
      } catch (error: unknown) {
        outcome = 'error';
        error_code = 'MATCHING_FAILED';
        const details = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
          { error: 'Matching failed', details },
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
            error_code,
          });
        } catch (storeErr) {
          console.error('[LLMOps] finishRun failed:', storeErr);
        }
      }
    }
  );
}
