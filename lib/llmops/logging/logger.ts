import { getLlmOpsContext } from '../context';
import { resolveVersions } from '../versions';
import { LlmopsEvent } from './events';
import { redactDeep, redactValue } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LlmopsErrorPayload {
  type: string;
  message_safe: string;
  code: string;
}

export interface LlmopsLogEnvelope {
  ts: string;
  level: LogLevel;
  service: string;
  env: string;
  event: LlmopsEvent;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  run_id: string | null;
  session_id: string | null;
  user_id_hash: string | null;
  case_id: string | null;
  persona: string | null;
  route: string | null;
  mode: string | null;
  git_sha: string;
  prompt_version: string;
  model_id: string;
  rag_index_version: string;
  duration_ms: number;
  outcome: string | null;
  msg: string;
  data: Record<string, unknown>;
  error: LlmopsErrorPayload | null;
}

export type LogSink = (line: string, envelope: LlmopsLogEnvelope) => void;

let activeSink: LogSink | null = null;

/**
 * Configure a custom log sink (primarily used in automated tests).
 * Pass null to restore default process.stdout emission.
 */
export function setLogSink(sink: LogSink | null): void {
  activeSink = sink;
}

function normalizeError(err?: unknown): LlmopsErrorPayload | null {
  if (!err) {
    return null;
  }

  if (err instanceof Error) {
    let code = '';
    if ('code' in err && typeof err.code === 'string') {
      code = err.code;
    }
    return {
      type: err.name || 'Error',
      message_safe: redactValue(err.message || ''),
      code,
    };
  }

  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    const message =
      typeof obj.message === 'string'
        ? obj.message
        : typeof obj.message_safe === 'string'
        ? obj.message_safe
        : 'Unknown error';
    return {
      type: typeof obj.type === 'string' ? obj.type : 'Error',
      message_safe: redactValue(message),
      code: typeof obj.code === 'string' ? obj.code : '',
    };
  }

  return {
    type: 'Error',
    message_safe: redactValue(String(err)),
    code: '',
  };
}

function resolveEnv(): string {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'production') return 'prod';
  if (nodeEnv === 'test') return 'test';
  return 'dev';
}

/**
 * Emit a structured JSON log line according to Spec L3.2 envelope.
 */
export function emitLog(
  level: LogLevel,
  event: LlmopsEvent,
  data?: Record<string, unknown>,
  err?: unknown
): void {
  const ctx = getLlmOpsContext();
  const versions = resolveVersions();

  const duration_ms = typeof data?.duration_ms === 'number' ? data.duration_ms : 0;
  const outcome = (typeof data?.outcome === 'string' ? data.outcome : null) ?? (err ? 'error' : null);
  const msg = typeof data?.msg === 'string' ? data.msg : typeof data?.message === 'string' ? data.message : '';

  // Extract explicit overrides from data if provided, fallback to context
  const trace_id = (typeof data?.trace_id === 'string' ? data.trace_id : null) ?? ctx.trace_id;
  const span_id = (typeof data?.span_id === 'string' ? data.span_id : null) ?? ctx.span_id;
  const parent_span_id = (typeof data?.parent_span_id === 'string' ? data.parent_span_id : null) ?? ctx.parent_span_id;
  const run_id = (typeof data?.run_id === 'string' ? data.run_id : null) ?? ctx.run_id;
  const session_id = (typeof data?.session_id === 'string' ? data.session_id : null) ?? ctx.session_id;
  const user_id_hash = (typeof data?.user_id_hash === 'string' ? data.user_id_hash : null) ?? ctx.user_id_hash;
  const case_id = (typeof data?.case_id === 'string' ? data.case_id : null) ?? ctx.case_id;
  const persona = (typeof data?.persona === 'string' ? data.persona : null) ?? ctx.persona ?? 'unknown';
  const route = (typeof data?.route === 'string' ? data.route : null) ?? ctx.route;
  const mode = (typeof data?.mode === 'string' ? data.mode : null) ?? ctx.mode;

  const prompt_version = (typeof data?.prompt_version === 'string' ? data.prompt_version : null) ?? versions.prompt_version;
  const model_id = (typeof data?.model_id === 'string' ? data.model_id : null) ?? versions.model_id;
  const rag_index_version = (typeof data?.rag_index_version === 'string' ? data.rag_index_version : null) ?? versions.rag_index_version;

  // Clean data dictionary to avoid duplicating top-level envelope fields
  const dataPayload: Record<string, unknown> = {};
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (
        ![
          'duration_ms',
          'outcome',
          'msg',
          'message',
          'trace_id',
          'span_id',
          'parent_span_id',
          'run_id',
          'session_id',
          'user_id_hash',
          'case_id',
          'persona',
          'route',
          'mode',
          'prompt_version',
          'model_id',
          'rag_index_version',
        ].includes(k)
      ) {
        dataPayload[k] = v;
      }
    }
  }

  const envelope: LlmopsLogEnvelope = {
    ts: new Date().toISOString(),
    level,
    service: 'hakmdar-next',
    env: resolveEnv(),
    event,
    trace_id,
    span_id,
    parent_span_id,
    run_id,
    session_id,
    user_id_hash,
    case_id,
    persona,
    route,
    mode,
    git_sha: versions.app_git_sha,
    prompt_version,
    model_id,
    rag_index_version,
    duration_ms,
    outcome,
    msg,
    data: redactDeep(dataPayload),
    error: normalizeError(err),
  };

  const line = JSON.stringify(envelope);

  if (activeSink) {
    activeSink(line, envelope);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const llmopsLogger = {
  debug(event: LlmopsEvent, data?: Record<string, unknown>, err?: unknown): void {
    emitLog('debug', event, data, err);
  },
  info(event: LlmopsEvent, data?: Record<string, unknown>, err?: unknown): void {
    emitLog('info', event, data, err);
  },
  warn(event: LlmopsEvent, data?: Record<string, unknown>, err?: unknown): void {
    emitLog('warn', event, data, err);
  },
  error(event: LlmopsEvent, data?: Record<string, unknown>, err?: unknown): void {
    emitLog('error', event, data, err);
  },
  log(level: LogLevel, event: LlmopsEvent, data?: Record<string, unknown>, err?: unknown): void {
    emitLog(level, event, data, err);
  },
};
