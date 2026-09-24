import { AsyncLocalStorage } from 'node:async_hooks';

export type LlmOpsPersona = 'client' | 'lawyer' | 'system' | 'unknown';
export type LlmOpsMode = 'chat_fast' | 'case_deep' | 'ingest' | 'eval';

export interface LlmOpsContext {
  trace_id: string | null;
  run_id: string | null;
  session_id: string | null;
  user_id_hash: string | null;
  persona: LlmOpsPersona | null;
  mode: LlmOpsMode | null;
  route: string | null;
  case_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
}

const DEFAULT_CONTEXT: Readonly<LlmOpsContext> = Object.freeze({
  trace_id: null,
  run_id: null,
  session_id: null,
  user_id_hash: null,
  persona: null,
  mode: null,
  route: null,
  case_id: null,
  span_id: null,
  parent_span_id: null,
});

const storage = new AsyncLocalStorage<LlmOpsContext>();

/**
 * Execute a function within an active LLMOps request context.
 * Inherits any active parent context fields when nested.
 */
export function runLlmOpsContext<T>(ctx: Partial<LlmOpsContext>, fn: () => T): T {
  const parent = storage.getStore();
  const merged: LlmOpsContext = {
    ...(parent ?? DEFAULT_CONTEXT),
    ...ctx,
  };
  return storage.run(merged, fn);
}

/**
 * Retrieve the current LLMOps request context.
 * Returns an object with safe null values when invoked outside an active context.
 */
export function getLlmOpsContext(): LlmOpsContext {
  return storage.getStore() ?? DEFAULT_CONTEXT;
}

/**
 * Mutate the active request context in-place (e.g. after authentication or route resolution).
 * Safe no-op if invoked outside an active context.
 */
export function updateLlmOpsContext(partial: Partial<LlmOpsContext>): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, partial);
  }
}
