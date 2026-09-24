import { getTracer, type Span, type TracingProvider } from './provider';
import { getLlmOpsContext, updateLlmOpsContext, type LlmOpsMode } from '../context';
import { resolveVersions } from '../versions';

/**
 * Minimum span attributes per spec L4.1.
 */
export interface StandardSpanAttributes {
  mode: string;
  persona: string;
  model_id: string;
  prompt_version: string;
  rag_index_version: string;
  chunk_ids: string[];
  evidence_score: number | null;
  outcome: string | null;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd_est: number | null;
  guard_domain: string | null;
  is_legal: boolean | null;
  [key: string]: unknown;
}

/**
 * Root span helper: initiates the 'hakmdar.ai.run' trace root.
 * Populates all minimum required spec L4.1 attributes from active context and version registry.
 */
export function startRunSpan(
  mode: LlmOpsMode | string,
  attrs?: Partial<StandardSpanAttributes> & Record<string, unknown>,
  tracer?: TracingProvider
): Span {
  const t = tracer ?? getTracer();
  const ctx = getLlmOpsContext();
  const versions = resolveVersions();

  const standardAttrs: StandardSpanAttributes = {
    mode: (attrs?.mode as string) ?? ctx.mode ?? mode,
    persona: (attrs?.persona as string) ?? ctx.persona ?? 'unknown',
    model_id: (attrs?.model_id as string) ?? versions.model_id,
    prompt_version: (attrs?.prompt_version as string) ?? versions.prompt_version,
    rag_index_version: (attrs?.rag_index_version as string) ?? versions.rag_index_version,
    chunk_ids: Array.isArray(attrs?.chunk_ids) ? (attrs.chunk_ids as string[]) : [],
    evidence_score: typeof attrs?.evidence_score === 'number' ? attrs.evidence_score : null,
    outcome: typeof attrs?.outcome === 'string' ? attrs.outcome : null,
    ttft_ms: typeof attrs?.ttft_ms === 'number' ? attrs.ttft_ms : null,
    tokens_in: typeof attrs?.tokens_in === 'number' ? attrs.tokens_in : null,
    tokens_out: typeof attrs?.tokens_out === 'number' ? attrs.tokens_out : null,
    cost_usd_est: typeof attrs?.cost_usd_est === 'number' ? attrs.cost_usd_est : null,
    guard_domain: typeof attrs?.guard_domain === 'string' ? attrs.guard_domain : null,
    is_legal: typeof attrs?.is_legal === 'boolean' ? attrs.is_legal : null,
    app_git_sha: versions.app_git_sha,
    guard_version: versions.guard_version,
    graph_version: versions.graph_version,
    route: ctx.route,
    session_id: ctx.session_id,
    user_id_hash: ctx.user_id_hash,
    case_id: ctx.case_id,
    ...(attrs ?? {}),
  };

  const span = t.startSpan('hakmdar.ai.run', standardAttrs, null);
  updateLlmOpsContext({ span_id: span.id, mode: mode as LlmOpsMode });
  return span;
}

export interface ChatFastSpanTree {
  root: Span;
  auth(attrs?: Record<string, unknown>): Span;
  guardPre(attrs?: Record<string, unknown>): Span;
  retrieve(attrs?: {
    dense?: unknown;
    bm25?: unknown;
    rrf?: unknown;
    rerank?: unknown;
    chunk_ids?: string[];
    [key: string]: unknown;
  }): Span;
  retrieveDense(attrs?: Record<string, unknown>): Span;
  retrieveBm25(attrs?: Record<string, unknown>): Span;
  retrieveRrf(attrs?: Record<string, unknown>): Span;
  retrieveRerank(attrs?: Record<string, unknown>): Span;
  memoryRecall(attrs?: Record<string, unknown>): Span;
  llmSynthesize(attrs?: Record<string, unknown>): Span;
  guardPost(attrs?: Record<string, unknown>): Span;
  stream(attrs?: Record<string, unknown>): Span;
  end(status?: 'ok' | 'error', finalAttrs?: Record<string, unknown>): void;
}

/**
 * Convenience builder for the chat_fast span tree:
 * hakmdar.ai.run
 * ├─ ai.auth
 * ├─ ai.guard_pre
 * ├─ ai.retrieve [.dense/.bm25/.rrf/.rerank child attrs]
 * ├─ ai.memory.recall
 * ├─ ai.llm.synthesize
 * ├─ ai.guard_post
 * └─ ai.stream
 */
export function spanChatFast(rootSpan?: Span, tracer?: TracingProvider): ChatFastSpanTree {
  const t = tracer ?? getTracer();
  const root = rootSpan ?? startRunSpan('chat_fast', undefined, t);

  return {
    root,
    auth: (attrs) => t.startSpan('ai.auth', attrs, root.id),
    guardPre: (attrs) => t.startSpan('ai.guard_pre', attrs, root.id),
    retrieve: (attrs) => {
      const merged: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attrs ?? {})) {
        if (k === 'dense') {
          merged['retrieve.dense'] = v;
        } else if (k === 'bm25') {
          merged['retrieve.bm25'] = v;
        } else if (k === 'rrf') {
          merged['retrieve.rrf'] = v;
        } else if (k === 'rerank') {
          merged['retrieve.rerank'] = v;
        } else {
          merged[k] = v;
        }
      }
      return t.startSpan('ai.retrieve', merged, root.id);
    },
    retrieveDense: (attrs) => t.startSpan('ai.retrieve.dense', attrs, root.id),
    retrieveBm25: (attrs) => t.startSpan('ai.retrieve.bm25', attrs, root.id),
    retrieveRrf: (attrs) => t.startSpan('ai.retrieve.rrf', attrs, root.id),
    retrieveRerank: (attrs) => t.startSpan('ai.retrieve.rerank', attrs, root.id),
    memoryRecall: (attrs) => t.startSpan('ai.memory.recall', attrs, root.id),
    llmSynthesize: (attrs) => t.startSpan('ai.llm.synthesize', attrs, root.id),
    guardPost: (attrs) => t.startSpan('ai.guard_post', attrs, root.id),
    stream: (attrs) => t.startSpan('ai.stream', attrs, root.id),
    end: (status, finalAttrs) => {
      if (finalAttrs) {
        Object.assign(root.attributes, finalAttrs);
      }
      t.endSpan(root, status);
    },
  };
}

export interface CaseDeepSpanTree {
  root: Span;
  guardPre(attrs?: Record<string, unknown>): Span;
  retrieve(attrs?: Record<string, unknown>): Span;
  graphNode(
    node: 'statutory' | 'cassation' | 'procedural' | 'contract' | (string & {}),
    attrs?: Record<string, unknown>
  ): Span;
  graphSynthesize(attrs?: Record<string, unknown>): Span;
  hitl(attrs?: Record<string, unknown>): Span;
  guardPost(attrs?: Record<string, unknown>): Span;
  memoryWrite(attrs?: Record<string, unknown>): Span;
  end(status?: 'ok' | 'error', finalAttrs?: Record<string, unknown>): void;
}

/**
 * Convenience builder for the case_deep span tree:
 * hakmdar.ai.run
 * ├─ ai.guard_pre
 * ├─ ai.retrieve
 * ├─ ai.graph.statutory|cassation|procedural|contract
 * ├─ ai.graph.synthesize
 * ├─ ai.hitl
 * ├─ ai.guard_post
 * └─ ai.memory.write
 */
export function spanCaseDeep(rootSpan?: Span, tracer?: TracingProvider): CaseDeepDeepSpanTree {
  const t = tracer ?? getTracer();
  const root = rootSpan ?? startRunSpan('case_deep', undefined, t);

  return {
    root,
    guardPre: (attrs) => t.startSpan('ai.guard_pre', attrs, root.id),
    retrieve: (attrs) => t.startSpan('ai.retrieve', attrs, root.id),
    graphNode: (node, attrs) => t.startSpan(`ai.graph.${node}`, attrs, root.id),
    graphSynthesize: (attrs) => t.startSpan('ai.graph.synthesize', attrs, root.id),
    hitl: (attrs) => t.startSpan('ai.hitl', attrs, root.id),
    guardPost: (attrs) => t.startSpan('ai.guard_post', attrs, root.id),
    memoryWrite: (attrs) => t.startSpan('ai.memory.write', attrs, root.id),
    end: (status, finalAttrs) => {
      if (finalAttrs) {
        Object.assign(root.attributes, finalAttrs);
      }
      t.endSpan(root, status);
    },
  };
}

// Alias for typing flexibility
export type CaseDeepDeepSpanTree = CaseDeepSpanTree;

/**
 * Execute an async or sync operation wrapped safely within an individual active span.
 * Records exceptions as span error status and rethrows.
 */
export async function withActiveSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (span: Span) => Promise<T> | T,
  parentId?: string | null,
  tracer?: TracingProvider
): Promise<T> {
  const t = tracer ?? getTracer();
  const span = t.startSpan(name, attrs, parentId);
  try {
    const result = await fn(span);
    t.endSpan(span, 'ok');
    return result;
  } catch (err) {
    t.endSpan(span, 'error', [
      {
        name: 'exception',
        timestamp: Date.now(),
        attributes: {
          'exception.message': err instanceof Error ? err.message : String(err),
          'exception.type': err instanceof Error ? err.name : typeof err,
        },
      },
    ]);
    throw err;
  }
}
