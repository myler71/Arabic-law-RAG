import { NextRequest, NextResponse } from 'next/server';
import { MOCK_LEGAL_DATABASE } from '@/lib/data/legalData';
import { LegalCategory } from '@/lib/types';
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


export async function GET(req: NextRequest) {
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
      route: '/api/ai/research',
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
          route: '/api/ai/research',
          git_sha: versions.app_git_sha,
          prompt_version: versions.prompt_version,
          model_id: versions.model_id,
          rag_index_version: versions.rag_index_version,
          guard_version: versions.guard_version,
        });
      } catch (err) {
        console.error('[LLMOps] startRun failed:', err);
      }

      try {
        const { searchParams } = new URL(req.url);
        const query = (searchParams.get('q') || '').trim().toLowerCase();
        const category = searchParams.get('category') as LegalCategory | 'all' | null;

        llmopsLogger.info(LLMOPS_EVENTS.REQUEST_START, {
          mode: 'chat_fast',
          locale: 'ar',
          message_len: query.length,
          history_turns: 0,
        });

        let results = MOCK_LEGAL_DATABASE;

        if (category && category !== 'all') {
          results = results.filter((item) => item.category === category);
        }

        if (query) {
          results = results.filter((item) => {
            return (
              item.title.toLowerCase().includes(query) ||
              item.code.toLowerCase().includes(query) ||
              item.articleNumber.toLowerCase().includes(query) ||
              item.text.toLowerCase().includes(query) ||
              item.keyTakeaway.toLowerCase().includes(query) ||
              item.tags.some((tag) => tag.toLowerCase().includes(query))
            );
          });
        }

        return NextResponse.json(
          {
            query,
            category: category || 'all',
            totalCount: results.length,
            results,
          },
          { headers: { 'X-Trace-Id': trace_id } }
        );
      } catch (error: unknown) {
        outcome = 'error';
        error_code = 'SEARCH_FAILED';
        const details = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
          { error: 'Search failed', details },
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
