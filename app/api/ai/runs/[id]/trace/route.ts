import { NextRequest, NextResponse } from 'next/server';
import { memoryCheckpointStore } from '@/lib/ai/agents/checkpoint';
import { runStore } from '@/lib/llmops/runs/store';
type Props = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/ai/runs/[id]/trace
 * Retrieve full execution trace for an AI run or checkpoint,
 * including step timings, guard scores, and citations with chunk_ids.
 */
export async function GET(req: NextRequest, { params }: Props) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'معرف سجل التتبع مطلوب' }, { status: 400 });
    }

    const state = await memoryCheckpointStore.getTrace(id);
    const runRecord = await runStore.getByTraceId(id);

    if (!state && !runRecord) {
      return NextResponse.json({ error: 'سجل التتبع غير موجود' }, { status: 404 });
    }

    if (!state && runRecord) {
      return NextResponse.json(
        {
          run_id: runRecord.id,
          trace_id: runRecord.trace_id,
          case_id: runRecord.case_id,
          status: runRecord.outcome,
          timings: [],
          citations: [],
          retrieved_chunks: [],
          guard_pre: null,
          guard_post: null,
          route_plan: null,
          specialist_outputs: {},
          structured_summary: null,
          hitl: null,
          episodic_memory: [],
          run_record: runRecord,
          prompt_version: runRecord.prompt_version,
          model_id: runRecord.model_id,
          rag_index_version: runRecord.rag_index_version,
          guard_version: runRecord.guard_version,
          git_sha: runRecord.git_sha,
          outcome: runRecord.outcome,
          ttft_ms: runRecord.ttft_ms,
          t_total_ms: runRecord.t_total_ms,
          tokens_in: runRecord.tokens_in,
          tokens_out: runRecord.tokens_out,
          cost_usd_est: runRecord.cost_usd_est,
          evidence_score: runRecord.evidence_score,
        },
        { status: 200 }
      );
    }

    const citationsWithChunkIds = (state!.citations || []).map((c) => ({
      ...c,
      chunk_id: ('chunk_id' in c && typeof c.chunk_id === 'string') ? c.chunk_id : c.id,
    }));

    const baseResponse = {
      run_id: state!.run_id,
      trace_id: state!.trace_id,
      case_id: state!.case_id,
      status: state!.hitl?.status,
      timings: state!.timings || [],
      citations: citationsWithChunkIds,
      retrieved_chunks: (state!.retrieved_chunks || []).map((chunk) => ({
        id: chunk.id,
        chunk_id: chunk.id,
        article_number: chunk.article_number,
        law_name: chunk.law_name,
        title: chunk.title,
        court: chunk.court,
        category: chunk.category,
      })),
      guard_pre: state!.guard_pre,
      guard_post: state!.guard_post,
      route_plan: state!.route_plan,
      specialist_outputs: state!.specialist_outputs,
      structured_summary: state!.structured_summary,
      hitl: state!.hitl,
      episodic_memory: state!.episodic_memory,
    };

    if (runRecord) {
      return NextResponse.json(
        {
          ...baseResponse,
          run_record: runRecord,
          prompt_version: runRecord.prompt_version,
          model_id: runRecord.model_id,
          rag_index_version: runRecord.rag_index_version,
          guard_version: runRecord.guard_version,
          git_sha: runRecord.git_sha,
          outcome: runRecord.outcome || baseResponse.status,
          ttft_ms: runRecord.ttft_ms,
          t_total_ms: runRecord.t_total_ms,
          tokens_in: runRecord.tokens_in,
          tokens_out: runRecord.tokens_out,
          cost_usd_est: runRecord.cost_usd_est,
          evidence_score: runRecord.evidence_score,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(baseResponse, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
