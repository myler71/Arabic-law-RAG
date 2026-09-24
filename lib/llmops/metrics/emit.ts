import { redactDeep } from '../logging/redact';

export type MetricLabelValue = string | number | boolean;
export type MetricLabels = Record<string, MetricLabelValue | undefined | null>;

export interface CounterEntry {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface HistogramEntry {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  buckets: Record<string, number>;
}

export interface MetricsSnapshot {
  counters: CounterEntry[];
  histograms: HistogramEntry[];
  timestamp: number;
}

// -----------------------------------------------------------------------------
// Internal In-Memory State
// -----------------------------------------------------------------------------

const DEFAULT_HISTOGRAM_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

interface InternalHistogramRecord {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Map<number, number>;
  plusInf: number;
}

const counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>();
const histograms = new Map<string, InternalHistogramRecord>();

function serializeLabels(labels?: MetricLabels): { key: string; sanitized: Record<string, string> } {
  if (!labels || Object.keys(labels).length === 0) {
    return { key: '{}', sanitized: {} };
  }

  const sanitized: Record<string, string> = {};
  const entries: Array<[string, string]> = [];

  for (const [k, v] of Object.entries(labels)) {
    if (v !== undefined && v !== null) {
      const strVal = String(v);
      sanitized[k] = strVal;
      entries.push([k, strVal]);
    }
  }

  entries.sort(([a], [b]) => a.localeCompare(b));
  const serialized = entries.map(([k, v]) => `${k}="${v}"`).join(',');
  return { key: `{${serialized}}`, sanitized };
}

// -----------------------------------------------------------------------------
// OTLP Metric Export Support (Optional via OTLP_ENDPOINT)
// -----------------------------------------------------------------------------

let pendingOtlpQueue: Array<
  | { type: 'counter'; name: string; labels: Record<string, string>; value: number; timestamp: number }
  | { type: 'histogram'; name: string; labels: Record<string, string>; value: number; timestamp: number }
> = [];
let otlpTimer: NodeJS.Timeout | null = null;

function getOtlpMetricsEndpoint(): string | null {
  const ep =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    process.env.OTLP_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!ep) return null;
  return ep.endsWith('/v1/metrics') ? ep : `${ep.replace(/\/+$/, '')}/v1/metrics`;
}

function queueOtlpMetric(
  item:
    | { type: 'counter'; name: string; labels: Record<string, string>; value: number; timestamp: number }
    | { type: 'histogram'; name: string; labels: Record<string, string>; value: number; timestamp: number }
): void {
  const endpoint = getOtlpMetricsEndpoint();
  if (!endpoint) return;

  pendingOtlpQueue.push(item);

  if (pendingOtlpQueue.length >= 50) {
    void flushOtlpMetrics();
  } else if (!otlpTimer) {
    otlpTimer = setTimeout(() => {
      otlpTimer = null;
      void flushOtlpMetrics();
    }, 1000);
    if (typeof otlpTimer?.unref === 'function') {
      otlpTimer.unref();
    }
  }
}

async function flushOtlpMetrics(): Promise<void> {
  if (otlpTimer) {
    clearTimeout(otlpTimer);
    otlpTimer = null;
  }

  const endpoint = getOtlpMetricsEndpoint();
  if (!endpoint || pendingOtlpQueue.length === 0) {
    pendingOtlpQueue = [];
    return;
  }

  const items = pendingOtlpQueue.splice(0, pendingOtlpQueue.length);

  const payload = {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'hakmdar-next' } },
            { key: 'service.version', value: { stringValue: process.env.APP_GIT_SHA ?? 'dev' } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'hakmdar.llmops' },
            metrics: items.map((item) => ({
              name: item.name,
              data:
                item.type === 'counter'
                  ? {
                      dataPoints: [
                        {
                          asInt: Math.round(item.value).toString(),
                          timeUnixNano: (item.timestamp * 1_000_000).toString(),
                          attributes: Object.entries(item.labels).map(([k, v]) => ({
                            key: k,
                            value: { stringValue: v },
                          })),
                        },
                      ],
                    }
                  : {
                      dataPoints: [
                        {
                          asDouble: item.value,
                          timeUnixNano: (item.timestamp * 1_000_000).toString(),
                          attributes: Object.entries(item.labels).map(([k, v]) => ({
                            key: k,
                            value: { stringValue: v },
                          })),
                        },
                      ],
                    },
            })),
          },
        ],
      },
    ],
  };

  try {
    const res = fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res && typeof res.catch === 'function') {
      res.catch(() => {});
    }
  } catch {
    // Failure-safe
  }
}

// -----------------------------------------------------------------------------
// Public Emit API
// -----------------------------------------------------------------------------

/**
 * Increment or add to a monotonically increasing metric counter.
 * Fire-and-forget, non-blocking, never throws.
 */
export function emitCounter(
  name: string,
  labels?: MetricLabels,
  value = 1
): void {
  try {
    if (typeof name !== 'string' || !name) {
      return;
    }

    const delta = typeof value === 'number' && !Number.isNaN(value) ? value : 1;
    if (delta <= 0) {
      return;
    }

    const { key, sanitized } = serializeLabels(labels);
    const metricKey = `${name}${key}`;

    const existing = counters.get(metricKey);
    if (existing) {
      existing.value += delta;
    } else {
      counters.set(metricKey, {
        name,
        labels: sanitized,
        value: delta,
      });
    }

    queueOtlpMetric({
      type: 'counter',
      name,
      labels: sanitized,
      value: delta,
      timestamp: Date.now(),
    });
  } catch {
    // Never crash caller
  }
}

/**
 * Record a value or duration in a histogram metric.
 * Aggregates count, sum, min, max, average, and discrete buckets.
 * Fire-and-forget, non-blocking, never throws.
 */
export function emitHistogram(
  name: string,
  valueMs: number,
  labels?: MetricLabels
): void {
  try {
    if (typeof name !== 'string' || !name) {
      return;
    }

    if (typeof valueMs !== 'number' || Number.isNaN(valueMs)) {
      return;
    }

    const { key, sanitized } = serializeLabels(labels);
    const metricKey = `${name}${key}`;

    let record = histograms.get(metricKey);
    if (!record) {
      const initialBuckets = new Map<number, number>();
      for (const b of DEFAULT_HISTOGRAM_BOUNDS) {
        initialBuckets.set(b, 0);
      }
      record = {
        name,
        labels: sanitized,
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        buckets: initialBuckets,
        plusInf: 0,
      };
      histograms.set(metricKey, record);
    }

    record.count += 1;
    record.sum += valueMs;
    if (valueMs < record.min) record.min = valueMs;
    if (valueMs > record.max) record.max = valueMs;

    for (const b of DEFAULT_HISTOGRAM_BOUNDS) {
      if (valueMs <= b) {
        record.buckets.set(b, (record.buckets.get(b) ?? 0) + 1);
      }
    }
    record.plusInf += 1;

    queueOtlpMetric({
      type: 'histogram',
      name,
      labels: sanitized,
      value: valueMs,
      timestamp: Date.now(),
    });
  } catch {
    // Never crash caller
  }
}

/**
 * Read current snapshot of all in-memory counters and histograms.
 */
export function readMetricsSnapshot(): MetricsSnapshot {
  const counterSnapshots: CounterEntry[] = [];
  counters.forEach((c) => {
    counterSnapshots.push({
      name: c.name,
      labels: { ...c.labels },
      value: c.value,
    });
  });

  const histogramSnapshots: HistogramEntry[] = [];
  histograms.forEach((h) => {
    const bucketsObj: Record<string, number> = {};
    h.buckets.forEach((count, bound) => {
      bucketsObj[bound.toString()] = count;
    });
    bucketsObj['+Inf'] = h.plusInf;

    histogramSnapshots.push({
      name: h.name,
      labels: { ...h.labels },
      count: h.count,
      sum: h.sum,
      min: h.count > 0 ? h.min : 0,
      max: h.count > 0 ? h.max : 0,
      avg: h.count > 0 ? h.sum / h.count : 0,
      buckets: bucketsObj,
    });
  });

  return {
    counters: counterSnapshots,
    histograms: histogramSnapshots,
    timestamp: Date.now(),
  };
}

/**
 * Reset all in-memory counters and histograms.
 * Primarily used in automated testing.
 */
export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
  pendingOtlpQueue = [];
  if (otlpTimer) {
    clearTimeout(otlpTimer);
    otlpTimer = null;
  }
}

/**
 * Force flush any pending OTLP metric payloads.
 */
export async function flushMetrics(): Promise<void> {
  await flushOtlpMetrics();
}
