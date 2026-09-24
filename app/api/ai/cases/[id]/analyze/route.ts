import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { runCaseDeep } from '@/lib/ai/agents/graph';
import type { LegalGraphState } from '@/lib/ai/agents/types';
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


type Props = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/ai/cases/[id]/analyze
 * Lawyer-only endpoint to initiate multi-agent deep legal analysis.
 * Runs graph sequentially up to human_review checkpoint.
 */
export async function POST(req: NextRequest, { params }: Props) {
  const { id } = await params;
  const trace_id = req.headers.get('x-trace-id') || newTraceId();
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
      route: '/api/ai/cases/[id]/analyze',
      case_id: id || null,
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
          user_id: 'demo-lawyer',
          case_id: id || null,
          persona: 'lawyer',
          mode: 'case_deep',
          route: '/api/ai/cases/[id]/analyze',
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

        let body: { query?: string } = {};
        try {
          body = await req.json();
        } catch {
          body = {};
        }

        let queryText = body.query?.trim() || '';

        // If query not passed explicitly in request body, retrieve case facts from Supabase
        if (!queryText) {
          const { data: caseRecord } = await supabase
            .from('cases')
            .select('*')
            .eq('id', id)
            .single();

          if (caseRecord) {
            queryText = caseRecord.description || caseRecord.title || caseRecord.notes || '';
          }
        }

        if (!queryText) {
          queryText = `تحليل وتكييف قانوني موضوعي للنزاع رقم ${id}`;
        }

        const initialState: LegalGraphState = {
          trace_id,
          run_id,
          user_id: user.id,
          case_id: id,
          raw_query: queryText,
          normalized_query: '',
          guard_pre: null,
          route_plan: null,
          retrieved_chunks: [],
          specialist_outputs: {},
          citations: [],
          hitl: { status: 'pending' },
          timings: [],
        };

        const state = await runCaseDeep(initialState);

        if (state.hitl?.status === 'awaiting_review') {
          outcome = 'interrupted';
          llmopsLogger.info(LLMOPS_EVENTS.HITL_INTERRUPT, {
            checkpoint_id: state.hitl.checkpoint_id,
            case_id: id,
          });
        }

        return NextResponse.json(
          {
            run_id: state.run_id,
            trace_id: state.trace_id,
            checkpoint_id: state.hitl.checkpoint_id,
            status: state.hitl.status,
            draft: state.draft_answer,
            specialist_outputs: state.specialist_outputs,
            structured_summary: state.structured_summary,
          },
          { status: 200, headers: { 'X-Trace-Id': trace_id } }
        );
      } catch (err: unknown) {
        outcome = 'error';
        error_code = 'ANALYZE_FAILED';
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
