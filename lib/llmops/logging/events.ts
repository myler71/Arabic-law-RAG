/**
 * LLMOps Event Catalog (Spec L3.3)
 * Mandatory, strongly-typed event names for all AI lifecycle checkpoints.
 */
export const LLMOPS_EVENTS = {
  // Request lifecycle
  REQUEST_START: 'ai.request.start',
  AUTH_OK: 'ai.auth.ok',
  AUTH_FAIL: 'ai.auth.fail',
  RATELIMIT_HIT: 'ai.ratelimit.hit',
  REQUEST_DONE: 'ai.request.done',

  // Pre-guard
  GUARD_PRE_START: 'ai.guard_pre.start',
  GUARD_PRE_DONE: 'ai.guard_pre.done',
  GUARD_PRE_REFUSE: 'ai.guard_pre.refuse',

  // Retrieval
  RETRIEVE_START: 'ai.retrieve.start',
  RETRIEVE_DONE: 'ai.retrieve.done',
  RETRIEVE_ERROR: 'ai.retrieve.error',

  // LLM Generation
  LLM_START: 'ai.llm.start',
  LLM_DONE: 'ai.llm.done',
  LLM_ERROR: 'ai.llm.error',

  // Post-guard
  GUARD_POST_START: 'ai.guard_post.start',
  GUARD_POST_DONE: 'ai.guard_post.done',

  // Streaming
  STREAM_METADATA_EMITTED: 'ai.stream.metadata_emitted',
  STREAM_FIRST_TOKEN: 'ai.stream.first_token',
  STREAM_DONE: 'ai.stream.done',

  // LangGraph (case_deep)
  GRAPH_NODE_START: 'ai.graph.node.start',
  GRAPH_NODE_DONE: 'ai.graph.node.done',

  // HITL (Human-in-the-loop)
  HITL_INTERRUPT: 'ai.hitl.interrupt',
  HITL_RESUME: 'ai.hitl.resume',

  // Feedback & Memory
  FEEDBACK_RECEIVED: 'ai.feedback.received',
  MEMORY_WRITE: 'ai.memory.write',
  MEMORY_INJECT: 'ai.memory.inject',

  // Evals & Ingestion & Quality Alerts
  EVAL_RUN_START: 'ai.eval.run.start',
  EVAL_RUN_DONE: 'ai.eval.run.done',
  INGEST_JOB_START: 'ai.ingest.job.start',
  INGEST_JOB_DONE: 'ai.ingest.job.done',
  ALERT_QUALITY_DROP: 'ai.alert.quality_drop',
} as const;

export type LlmopsEventKey = keyof typeof LLMOPS_EVENTS;
export type LlmopsEvent = (typeof LLMOPS_EVENTS)[LlmopsEventKey] | (string & {});
