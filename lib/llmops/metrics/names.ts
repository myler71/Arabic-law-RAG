/**
 * LLMOps Metrics Catalog (Spec L4.2)
 * Standard metric names for traffic, reliability, quality, performance, cost, RAG, and eval.
 */

// Traffic & reliability
export const METRIC_AI_REQUESTS_TOTAL = 'ai_requests_total';
export const METRIC_AI_REQUEST_DURATION_MS = 'ai_request_duration_ms';
export const METRIC_AI_ERRORS_TOTAL = 'ai_errors_total';
export const METRIC_AI_RATELIMIT_TOTAL = 'ai_ratelimit_total';
export const METRIC_AI_CLIENT_DISCONNECT_TOTAL = 'ai_client_disconnect_total';

// Quality proxies (online)
export const METRIC_AI_GUARD_REFUSE_TOTAL = 'ai_guard_refuse_total';
export const METRIC_AI_DISCLAIMER_TOTAL = 'ai_disclaimer_total';
export const METRIC_AI_CITATIONS_EMITTED_TOTAL = 'ai_citations_emitted_total';
export const METRIC_AI_CITATIONS_REJECTED_TOTAL = 'ai_citations_rejected_total';
export const METRIC_AI_EVIDENCE_SCORE = 'ai_evidence_score';
export const METRIC_AI_FEEDBACK_TOTAL = 'ai_feedback_total';
export const METRIC_AI_HITL_ACTIONS_TOTAL = 'ai_hitl_actions_total';

// Performance
export const METRIC_AI_TTFT_MS = 'ai_ttft_ms';
export const METRIC_AI_RETRIEVE_MS = 'ai_retrieve_ms';
export const METRIC_AI_LLM_MS = 'ai_llm_ms';
export const METRIC_AI_GUARD_PRE_MS = 'ai_guard_pre_ms';
export const METRIC_AI_GUARD_POST_MS = 'ai_guard_post_ms';

// Cost
export const METRIC_AI_TOKENS_IN_TOTAL = 'ai_tokens_in_total';
export const METRIC_AI_TOKENS_OUT_TOTAL = 'ai_tokens_out_total';
export const METRIC_AI_COST_USD_TOTAL = 'ai_cost_usd_total';

// RAG
export const METRIC_AI_RETRIEVE_EMPTY_TOTAL = 'ai_retrieve_empty_total';
export const METRIC_AI_RETRIEVE_HIT_AT_K = 'ai_retrieve_hit_at_k';
export const METRIC_AI_INDEX_VERSION_INFO = 'ai_index_version_info';

// Eval
export const METRIC_AI_EVAL_SUITE_PASS = 'ai_eval_suite_pass';
export const METRIC_AI_EVAL_METRIC = 'ai_eval_metric';

/**
 * Grouped catalog object for convenient dictionary access.
 */
export const METRIC_NAMES = {
  // Traffic & reliability
  REQUESTS_TOTAL: METRIC_AI_REQUESTS_TOTAL,
  REQUEST_DURATION_MS: METRIC_AI_REQUEST_DURATION_MS,
  ERRORS_TOTAL: METRIC_AI_ERRORS_TOTAL,
  RATELIMIT_TOTAL: METRIC_AI_RATELIMIT_TOTAL,
  CLIENT_DISCONNECT_TOTAL: METRIC_AI_CLIENT_DISCONNECT_TOTAL,

  // Quality proxies (online)
  GUARD_REFUSE_TOTAL: METRIC_AI_GUARD_REFUSE_TOTAL,
  DISCLAIMER_TOTAL: METRIC_AI_DISCLAIMER_TOTAL,
  CITATIONS_EMITTED_TOTAL: METRIC_AI_CITATIONS_EMITTED_TOTAL,
  CITATIONS_REJECTED_TOTAL: METRIC_AI_CITATIONS_REJECTED_TOTAL,
  EVIDENCE_SCORE: METRIC_AI_EVIDENCE_SCORE,
  FEEDBACK_TOTAL: METRIC_AI_FEEDBACK_TOTAL,
  HITL_ACTIONS_TOTAL: METRIC_AI_HITL_ACTIONS_TOTAL,

  // Performance
  TTFT_MS: METRIC_AI_TTFT_MS,
  RETRIEVE_MS: METRIC_AI_RETRIEVE_MS,
  LLM_MS: METRIC_AI_LLM_MS,
  GUARD_PRE_MS: METRIC_AI_GUARD_PRE_MS,
  GUARD_POST_MS: METRIC_AI_GUARD_POST_MS,

  // Cost
  TOKENS_IN_TOTAL: METRIC_AI_TOKENS_IN_TOTAL,
  TOKENS_OUT_TOTAL: METRIC_AI_TOKENS_OUT_TOTAL,
  COST_USD_TOTAL: METRIC_AI_COST_USD_TOTAL,

  // RAG
  RETRIEVE_EMPTY_TOTAL: METRIC_AI_RETRIEVE_EMPTY_TOTAL,
  RETRIEVE_HIT_AT_K: METRIC_AI_RETRIEVE_HIT_AT_K,
  INDEX_VERSION_INFO: METRIC_AI_INDEX_VERSION_INFO,

  // Eval
  EVAL_SUITE_PASS: METRIC_AI_EVAL_SUITE_PASS,
  EVAL_METRIC: METRIC_AI_EVAL_METRIC,
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES] | (string & {});
