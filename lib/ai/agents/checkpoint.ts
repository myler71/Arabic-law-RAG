import type { LegalGraphState } from './types';

/**
 * ADR: Case-Deep Multi-Agent Checkpoint Store
 *
 * Status: Accepted (v1 Implementation)
 *
 * Context:
 * The Case-Deep legal analysis workflow is a multi-agent state graph that interrupts
 * at the `human_review` step to await licensed lawyer validation, modifications,
 * or rejection before issuing a final binding legal opinion.
 * State must persist reliably across asynchronous HTTP roundtrips between
 * `/analyze` and `/review`.
 *
 * Decision:
 * For v1, an in-memory asynchronous CheckpointStore interface is implemented.
 * This guarantees zero external runtime dependencies while testing and operating
 * in local/edge runtimes.
 *
 * Future Upgrade Path:
 * Swap `memoryCheckpointStore` for:
 * 1. PostgreSQL (Supabase `case_checkpoints` / `ai_runs` tables with JSONB state columns).
 * 2. Distributed Redis / Upstash KV for low-latency multi-region edge hydration.
 * The async interface `CheckpointStore` is designed to be a 100% drop-in swap.
 */

export interface CheckpointStore {
  get(checkpointId: string): Promise<LegalGraphState | null>;
  set(checkpointId: string, state: LegalGraphState): Promise<void>;
  delete(checkpointId: string): Promise<void>;
  getTrace(traceIdOrRunId: string): Promise<LegalGraphState | null>;
  setTrace(traceIdOrRunId: string, state: LegalGraphState): Promise<void>;
  clear?(): Promise<void> | void;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoints: Map<string, LegalGraphState> = new Map();
  private traces: Map<string, LegalGraphState> = new Map();

  async get(checkpointId: string): Promise<LegalGraphState | null> {
    const state = this.checkpoints.get(checkpointId);
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  async set(checkpointId: string, state: LegalGraphState): Promise<void> {
    const cloned = JSON.parse(JSON.stringify(state));
    this.checkpoints.set(checkpointId, cloned);
    if (state.trace_id) {
      this.traces.set(state.trace_id, cloned);
    }
    if (state.run_id) {
      this.traces.set(state.run_id, cloned);
    }
  }

  async delete(checkpointId: string): Promise<void> {
    this.checkpoints.delete(checkpointId);
  }

  async getTrace(traceIdOrRunId: string): Promise<LegalGraphState | null> {
    const state = this.traces.get(traceIdOrRunId);
    if (state) {
      return JSON.parse(JSON.stringify(state));
    }
    // Fallback: search in checkpoints if trace ID matches
    for (const chk of this.checkpoints.values()) {
      if (chk.trace_id === traceIdOrRunId || chk.run_id === traceIdOrRunId || chk.hitl?.checkpoint_id === traceIdOrRunId) {
        return JSON.parse(JSON.stringify(chk));
      }
    }
    return null;
  }

  async setTrace(traceIdOrRunId: string, state: LegalGraphState): Promise<void> {
    const cloned = JSON.parse(JSON.stringify(state));
    this.traces.set(traceIdOrRunId, cloned);
  }

  clear(): void {
    this.checkpoints.clear();
    this.traces.clear();
  }
}

export const memoryCheckpointStore = new InMemoryCheckpointStore();
