import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { resumeCaseDeep } from '@/lib/ai/agents/graph';
import { memoryCheckpointStore } from '@/lib/ai/agents/checkpoint';

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
  submitFeedback,
} from '@/lib/llmops';

type Props = {
  params: Promise<{ id: string }>;
};

interface ReviewRequestBody {
  checkpoint_id: string;
  decision: 'approve' | 'modify' | 'reject';
  notes?: string;
  modified_draft?: string;
}

/**
 * POST /api/ai/cases/[id]/review
 * Lawyer-only endpoint to submit HITL decision on drafted legal memo.
 * Resumes execution to finalize response with verified citations and episodic memory.
 */
export async function POST(req: NextRequest, { params }: Props) {
  const { id } = await params;
  let trace_id = req.headers.get('x-trace-id') || newTraceId();
  const run_id = newRunId();
  const session_id = req.headers.get('x-session-id') || null;

  return runLlmOpsContext(
    {
      trace_id,
      run_id,
      session_id,
      user_id_hash: hashId('demo-lawyer'),
      persona: 'lawyer',
      mode: 'case_deep',
      route: '/api/ai/cases/[id]/review',
      case_id: id || null,
    },
    async () => {
      const t_start = Date.now();
      let outcome: 'success' | 'disclaimer' | 'refuse' | 'error' | 'interrupted' = 'success';
      let evidence_score: number | null = null;
      let error_code: string | null = null;

      try {
        const versions = resolveVersions();
        await runStore.startRun({
          id: run_id,
          trace_id,
          session_id,
          user_id: 'demo-lawyer',
          case_id: id || null,
          persona: 'lawyer',
          mode: 'case_deep',
          route: '/api/ai/cases/[id]/review',
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
        mode: 'case_deep',
        locale: 'ar',
        message_len: 0,
        history_turns: 0,
        case_id: id,
      });

      try {
        if (!id) {
          outcome = 'error';
          error_code = 'BAD_REQUEST';
          return NextResponse.json(
            { error: 'معرف القضية مطلوب' },
            { status: 400, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        let supabase;
        try {
          supabase = createServerClient(req);
        } catch {
          llmopsLogger.warn(LLMOPS_EVENTS.AUTH_FAIL, { reason: 'UNAUTHORIZED' });
          outcome = 'error';
          error_code = 'UNAUTHORIZED';
          return NextResponse.json(
            { error: 'يجب تسجيل الدخول أولاً (Unauthorized)' },
            { status: 401, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
          llmopsLogger.warn(LLMOPS_EVENTS.AUTH_FAIL, { reason: authError?.message || 'UNAUTHORIZED' });
          outcome = 'error';
          error_code = 'UNAUTHORIZED';
          return NextResponse.json(
            { error: 'يجب تسجيل الدخول أولاً (Unauthorized)' },
            { status: 401, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        const metaRole = user.user_metadata && typeof user.user_metadata === 'object' && 'role' in user.user_metadata
          ? user.user_metadata.role
          : undefined;
        const directRole = 'role' in user && typeof user.role === 'string' ? user.role : undefined;
        const role = metaRole || directRole || 'client';
        if (role !== 'lawyer') {
          llmopsLogger.warn(LLMOPS_EVENTS.AUTH_FAIL, { reason: 'FORBIDDEN_NOT_LAWYER' });
          outcome = 'error';
          error_code = 'FORBIDDEN';
          return NextResponse.json(
            { error: 'غير مصرح: التحليل القانوني المتعمق مخصص للمحامين فقط (Forbidden)' },
            { status: 403, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        updateLlmOpsContext({ user_id_hash: hashId(user.id) });
        llmopsLogger.info(LLMOPS_EVENTS.AUTH_OK, { user_id_hash: hashId(user.id), persona: 'lawyer' });

        let parsedBody: unknown;
        try {
          parsedBody = await req.json();
        } catch {
          outcome = 'error';
          error_code = 'BAD_REQUEST';
          return NextResponse.json(
            { error: 'جسم الطلب غير صالح (Invalid JSON)' },
            { status: 400, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        if (!parsedBody || typeof parsedBody !== 'object') {
          outcome = 'error';
          error_code = 'BAD_REQUEST';
          return NextResponse.json(
            { error: 'جسم الطلب فارغ أو غير صالح' },
            { status: 400, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        const body = parsedBody as Partial<ReviewRequestBody>;
        const { checkpoint_id, decision, notes, modified_draft } = body;

        if (!checkpoint_id || typeof checkpoint_id !== 'string') {
          outcome = 'error';
          error_code = 'BAD_REQUEST';
          return NextResponse.json(
            { error: 'معرف نقطة التحقق (checkpoint_id) مطلوب' },
            { status: 400, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        if (!decision || !['approve', 'modify', 'reject'].includes(decision)) {
          outcome = 'error';
          error_code = 'BAD_REQUEST';
          return NextResponse.json(
            { error: 'القرار يجب أن يكون أحد الخيارات: approve أو modify أو reject' },
            { status: 400, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        const existingState = await memoryCheckpointStore.get(checkpoint_id);
        if (!existingState) {
          outcome = 'error';
          error_code = 'NOT_FOUND';
          return NextResponse.json(
            { error: 'نقطة التحقق غير موجودة أو منتهية الصلاحية' },
            { status: 404, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        if (existingState.trace_id) {
          trace_id = existingState.trace_id;
          updateLlmOpsContext({ trace_id: existingState.trace_id });
        }

        llmopsLogger.info(LLMOPS_EVENTS.HITL_RESUME, {
          action: decision,
          checkpoint_id,
          reviewer_id: user.id,
        });

        const finalizedState = await resumeCaseDeep(existingState, {
          decision,
          notes,
          modified_draft,
          reviewer_id: user.id,
        });

        // Map review decision to feedback record (spec L5.5 / LLMOPS-C)
        try {
          let kind: 'accepted' | 'corrected' | 'rejected' = 'accepted';
          let correction_text: string | null = null;
          if (decision === 'modify') {
            kind = 'corrected';
            correction_text = modified_draft || notes || 'modified';
          } else if (decision === 'reject') {
            kind = 'rejected';
            correction_text = notes || null;
          } else {
            kind = 'accepted';
          }

          const effectiveTraceId = finalizedState.trace_id || existingState.trace_id || trace_id;
          const effectiveRunId = finalizedState.run_id || existingState.run_id || run_id;

          // Ensure run exists in runStore so submitFeedback can verify run
          const existingRun = await runStore.getByTraceId(effectiveTraceId);
          if (!existingRun) {
            await runStore.startRun({
              id: effectiveRunId,
              trace_id: effectiveTraceId,
              session_id: session_id || null,
              user_id: user.id,
              case_id: id || null,
              persona: 'lawyer',
              mode: 'case_deep',
              route: '/api/ai/cases/[id]/review',
            });
          }

          await submitFeedback(
            {
              trace_id: effectiveTraceId,
              run_id: effectiveRunId,
              session_id: session_id || null,
              case_id: id || null,
              lawyer_id: user.id,
              persona: 'lawyer',
              mode: 'case_deep',
              kind,
              correction_text,
              target_span: 'final_answer',
              tags: ['hitl_review', decision],
            },
            {
              id: user.id,
              role: 'lawyer',
            }
          );
        } catch (fbErr) {
          llmopsLogger.warn(LLMOPS_EVENTS.FEEDBACK_RECEIVED, {
            error: fbErr instanceof Error ? fbErr.message : String(fbErr),
            case_id: id,
          });
        }

        evidence_score = finalizedState.guard_post?.evidence_score ?? null;
        if (finalizedState.guard_post?.action === 'disclaimer') {
          outcome = 'disclaimer';
        } else if (decision === 'reject') {
          outcome = 'refuse';
        } else {
          outcome = 'success';
        }

        return NextResponse.json(
          {
            run_id: finalizedState.run_id,
            trace_id: finalizedState.trace_id,
            status: finalizedState.hitl.status,
            final_response: finalizedState.final_response,
            disclaimer: finalizedState.guard_post?.disclaimer ?? null,
            citations: (finalizedState.citations || []).map((c) => ({
              ...c,
              chunk_id: ('chunk_id' in c && typeof c.chunk_id === 'string') ? c.chunk_id : c.id,
            })),
            episodic_memory: finalizedState.episodic_memory,
          },
          { status: 200, headers: { 'X-Trace-Id': finalizedState.trace_id || trace_id } }
        );
      } catch (err: unknown) {
        outcome = 'error';
        error_code = 'REVIEW_FAILED';
        const message = err instanceof Error ? err.message : 'Internal Server Error';
        return NextResponse.json(
          { error: message },
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
            case_id: id,
            error_code,
          });
        } catch (storeErr) {
          console.error('[LLMOps] finishRun failed:', storeErr);
        }
      }
    }
  );
}
