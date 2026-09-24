import { newSpanId, newTraceId } from '../ids';
import { getLlmOpsContext } from '../context';
import { redactDeep } from '../logging/redact';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export interface Span {
  id: string;
  traceId: string;
  parentId?: string | null;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  status: SpanStatus;
  events: SpanEvent[];
}

export interface TracingProvider {
  readonly name: string;
  startSpan(name: string, attrs?: Record<string, unknown>, parentId?: string | null): Span;
  endSpan(
    span: Span,
    status?: 'ok' | 'error',
    events?: Array<{ name: string; timestamp?: number; attributes?: Record<string, unknown> }>
  ): void;
  flush?(): Promise<void>;
}

// -----------------------------------------------------------------------------
// NoopTracer (always available, default, zero I/O)
// -----------------------------------------------------------------------------

export class NoopTracer implements TracingProvider {
  readonly name = 'noop';

  startSpan(name: string, attrs?: Record<string, unknown>, parentId?: string | null): Span {
    const ctx = getLlmOpsContext();
    const traceId = ctx.trace_id ?? newTraceId();
    const resolvedParentId = parentId !== undefined ? parentId : (ctx.span_id ?? null);
    const sanitizedAttrs = attrs ? redactDeep(attrs) : {};

    return {
      id: newSpanId(),
      traceId,
      parentId: resolvedParentId,
      name,
      startTime: Date.now(),
      attributes: sanitizedAttrs,
      status: 'unset',
      events: [],
    };
  }

  endSpan(
    span: Span,
    status?: 'ok' | 'error',
    events?: Array<{ name: string; timestamp?: number; attributes?: Record<string, unknown> }>
  ): void {
    span.endTime = Date.now();
    span.status = status ?? (span.status === 'unset' ? 'ok' : span.status);
    if (events && events.length > 0) {
      for (const ev of events) {
        span.events.push({
          name: ev.name,
          timestamp: ev.timestamp ?? Date.now(),
          attributes: ev.attributes ? redactDeep(ev.attributes) : undefined,
        });
      }
    }
  }

  async flush(): Promise<void> {
    // No-op
  }
}

// -----------------------------------------------------------------------------
// OtlpTracer (OTLP/JSON over HTTP — fire-and-forget, non-blocking, batched)
// -----------------------------------------------------------------------------

export interface OtlpTracerOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
  fetchFn?: typeof fetch;
}

export class OtlpTracer implements TracingProvider {
  readonly name = 'otlp';
  private endpoint: string;
  private headers: Record<string, string>;
  private batchSize: number;
  private queue: Span[] = [];
  private timer: NodeJS.Timeout | null = null;
  private fetchFn: typeof fetch;

  constructor(options?: OtlpTracerOptions) {
    const rawEndpoint =
      options?.endpoint ??
      process.env.OTLP_ENDPOINT ??
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      'http://localhost:4318/v1/traces';

    // Normalize endpoint URL: append /v1/traces if bare host:port provided
    this.endpoint = rawEndpoint.endsWith('/v1/traces')
      ? rawEndpoint
      : `${rawEndpoint.replace(/\/+$/, '')}/v1/traces`;

    this.headers = {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    };
    this.batchSize = options?.batchSize ?? 20;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  startSpan(name: string, attrs?: Record<string, unknown>, parentId?: string | null): Span {
    const ctx = getLlmOpsContext();
    const traceId = ctx.trace_id ?? newTraceId();
    const resolvedParentId = parentId !== undefined ? parentId : (ctx.span_id ?? null);
    const sanitizedAttrs = attrs ? redactDeep(attrs) : {};

    return {
      id: newSpanId(),
      traceId,
      parentId: resolvedParentId,
      name,
      startTime: Date.now(),
      attributes: sanitizedAttrs,
      status: 'unset',
      events: [],
    };
  }

  endSpan(
    span: Span,
    status?: 'ok' | 'error',
    events?: Array<{ name: string; timestamp?: number; attributes?: Record<string, unknown> }>
  ): void {
    span.endTime = Date.now();
    span.status = status ?? (span.status === 'unset' ? 'ok' : span.status);
    if (events && events.length > 0) {
      for (const ev of events) {
        span.events.push({
          name: ev.name,
          timestamp: ev.timestamp ?? Date.now(),
          attributes: ev.attributes ? redactDeep(ev.attributes) : undefined,
        });
      }
    }

    this.queue.push(span);

    if (this.queue.length >= this.batchSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 500);
      if (typeof this.timer?.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);
    const payload = this.formatOtlpPayload(batch);

    try {
      // Fire-and-forget: failure-safe, never throws
      const res = this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      // Handle async promise rejection without unhandled rejection
      if (res && typeof res.catch === 'function') {
        res.catch(() => {});
      }
    } catch {
      // Silent suppress: tracing network failures must never crash runtime
    }
  }

  private formatOtlpPayload(spans: Span[]): Record<string, unknown> {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'hakmdar-next' } },
              { key: 'service.version', value: { stringValue: process.env.APP_GIT_SHA ?? 'dev' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'hakmdar.llmops', version: '1.0.0' },
              spans: spans.map((s) => ({
                traceId: s.traceId.replace(/-/g, '').padEnd(32, '0'),
                spanId: s.id.padEnd(16, '0'),
                parentSpanId: s.parentId ? s.parentId.replace(/-/g, '').padEnd(16, '0') : undefined,
                name: s.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: (s.startTime * 1_000_000).toString(),
                endTimeUnixNano: ((s.endTime ?? Date.now()) * 1_000_000).toString(),
                attributes: Object.entries(s.attributes).map(([key, val]) => ({
                  key,
                  value: this.toOtlpValue(val),
                })),
                status: {
                  code: s.status === 'ok' ? 1 : s.status === 'error' ? 2 : 0,
                },
                events: s.events.map((ev) => ({
                  name: ev.name,
                  timeUnixNano: (ev.timestamp * 1_000_000).toString(),
                  attributes: ev.attributes
                    ? Object.entries(ev.attributes).map(([k, v]) => ({
                        key: k,
                        value: this.toOtlpValue(v),
                      }))
                    : [],
                })),
              })),
            },
          ],
        },
      ],
    };
  }

  private toOtlpValue(val: unknown): Record<string, unknown> {
    if (typeof val === 'string') {
      return { stringValue: val };
    }
    if (typeof val === 'boolean') {
      return { boolValue: val };
    }
    if (typeof val === 'number') {
      return Number.isInteger(val) ? { intValue: val.toString() } : { doubleValue: val };
    }
    return { stringValue: JSON.stringify(val) };
  }
}

// -----------------------------------------------------------------------------
// LangSmithTracer (REST API create_run — fire-and-forget, non-blocking)
// -----------------------------------------------------------------------------

export interface LangSmithTracerOptions {
  apiKey?: string;
  endpoint?: string;
  projectName?: string;
  fetchFn?: typeof fetch;
}

export class LangSmithTracer implements TracingProvider {
  readonly name = 'langsmith';
  private apiKey: string;
  private endpoint: string;
  private projectName: string;
  private fetchFn: typeof fetch;

  constructor(options?: LangSmithTracerOptions) {
    this.apiKey =
      options?.apiKey ??
      process.env.LANGSMITH_API_KEY ??
      process.env.LANGCHAIN_API_KEY ??
      '';
    this.endpoint = (
      options?.endpoint ??
      process.env.LANGSMITH_ENDPOINT ??
      'https://api.smith.langchain.com'
    ).replace(/\/+$/, '');
    this.projectName =
      options?.projectName ??
      process.env.LANGSMITH_PROJECT ??
      process.env.LANGCHAIN_PROJECT ??
      'hakmdar-dev';
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  startSpan(name: string, attrs?: Record<string, unknown>, parentId?: string | null): Span {
    const ctx = getLlmOpsContext();
    const traceId = ctx.trace_id ?? newTraceId();
    const resolvedParentId = parentId !== undefined ? parentId : (ctx.span_id ?? null);
    const sanitizedAttrs = attrs ? redactDeep(attrs) : {};

    return {
      id: newSpanId(),
      traceId,
      parentId: resolvedParentId,
      name,
      startTime: Date.now(),
      attributes: sanitizedAttrs,
      status: 'unset',
      events: [],
    };
  }

  endSpan(
    span: Span,
    status?: 'ok' | 'error',
    events?: Array<{ name: string; timestamp?: number; attributes?: Record<string, unknown> }>
  ): void {
    span.endTime = Date.now();
    span.status = status ?? (span.status === 'unset' ? 'ok' : span.status);
    if (events && events.length > 0) {
      for (const ev of events) {
        span.events.push({
          name: ev.name,
          timestamp: ev.timestamp ?? Date.now(),
          attributes: ev.attributes ? redactDeep(ev.attributes) : undefined,
        });
      }
    }

    if (!this.apiKey) {
      return;
    }

    // Determine LangSmith run_type heuristic from span name
    let runType = 'chain';
    if (span.name.includes('llm') || span.name.includes('synthesize')) {
      runType = 'llm';
    } else if (span.name.includes('retrieve')) {
      runType = 'retriever';
    } else if (span.name.includes('guard') || span.name.includes('auth')) {
      runType = 'tool';
    }

    const payload = {
      id: newTraceId(), // LangSmith requires UUID for run ID
      name: span.name,
      run_type: runType,
      start_time: new Date(span.startTime).toISOString(),
      end_time: new Date(span.endTime).toISOString(),
      extra: {
        metadata: {
          ...span.attributes,
          span_id_hex: span.id,
          trace_id: span.traceId,
          parent_span_id: span.parentId,
          events: span.events,
        },
      },
      session_name: this.projectName,
      error: span.status === 'error' ? 'Span ended with error' : undefined,
    };

    try {
      const res = this.fetchFn(`${this.endpoint}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (res && typeof res.catch === 'function') {
        res.catch(() => {});
      }
    } catch {
      // Fire-and-forget: ignore any sync errors
    }
  }

  async flush(): Promise<void> {
    // REST calls sent immediately
  }
}

// -----------------------------------------------------------------------------
// CompositeTracer (fans out to multiple adapters)
// -----------------------------------------------------------------------------

export class CompositeTracer implements TracingProvider {
  readonly name = 'composite';
  readonly providers: TracingProvider[];

  constructor(providers: TracingProvider[]) {
    this.providers = providers;
  }

  startSpan(name: string, attrs?: Record<string, unknown>, parentId?: string | null): Span {
    if (this.providers.length === 0) {
      return new NoopTracer().startSpan(name, attrs, parentId);
    }

    // Create the master span using the first provider
    const span = this.providers[0].startSpan(name, attrs, parentId);

    // Ensure downstream providers receive the start notification if needed
    for (let i = 1; i < this.providers.length; i++) {
      this.providers[i].startSpan(name, attrs, parentId);
    }

    return span;
  }

  endSpan(
    span: Span,
    status?: 'ok' | 'error',
    events?: Array<{ name: string; timestamp?: number; attributes?: Record<string, unknown> }>
  ): void {
    for (const provider of this.providers) {
      try {
        provider.endSpan(span, status, events);
      } catch {
        // Individual provider failures must never stop others
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.providers.map(async (p) => {
        try {
          if (p.flush) {
            await p.flush();
          }
        } catch {
          // Suppress flush error
        }
      })
    );
  }
}

// -----------------------------------------------------------------------------
// Factory: getTracer()
// -----------------------------------------------------------------------------

let cachedTracer: TracingProvider | null = null;

export function getTracer(forceNew = false): TracingProvider {
  if (cachedTracer && !forceNew) {
    return cachedTracer;
  }

  const activeProviders: TracingProvider[] = [];

  const hasOtlp = Boolean(
    process.env.OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  );

  const hasLangSmith = Boolean(
    process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY
  );

  if (hasOtlp) {
    activeProviders.push(new OtlpTracer());
  }

  if (hasLangSmith) {
    activeProviders.push(new LangSmithTracer());
  }

  if (activeProviders.length === 0) {
    cachedTracer = new NoopTracer();
  } else if (activeProviders.length === 1) {
    cachedTracer = activeProviders[0];
  } else {
    cachedTracer = new CompositeTracer(activeProviders);
  }

  return cachedTracer;
}

/**
 * Reset the cached tracer instance. Useful in tests when simulating environment variables.
 */
export function resetTracer(): void {
  cachedTracer = null;
}
