import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface RunRecord {
  id: string; // run_id
  trace_id: string;
  session_id?: string | null;
  user_id?: string | null;
  case_id?: string | null;
  persona?: 'client' | 'lawyer' | string | null;
  mode?: 'chat_fast' | 'case_deep' | string | null;
  route?: string | null;
  prompt_version?: string | null;
  model_id?: string | null;
  rag_index_version?: string | null;
  guard_version?: string | null;
  git_sha?: string | null;
  outcome?: 'success' | 'error' | 'rejected' | string | null;
  ttft_ms?: number | null;
  t_total_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd_est?: number | null;
  evidence_score?: number | null;
  domain?: string | null;
  is_legal?: boolean | null;
  error_code?: string | null;
  created_at?: string;
  finished_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Fold append-only records: start records carry the base run; 'finish' records
 * patch over their start. Concurrent workers append; nobody rewrites history.
 */
function foldRunRecords(records: RunRecord[], matchIdOrTrace?: string): RunRecord[] {
  const byKey = new Map<string, RunRecord>();
  for (const r of records) {
    const startKey = `${r.id}|${r.trace_id}`;
    const finishPatch = (r as RunRecord & { type?: string }).type === 'finish';
    const key = startKey;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
    } else if (finishPatch) {
      byKey.set(key, { ...existing, ...r } as RunRecord);
    }
  }
  const folded = [...byKey.values()];
  if (matchIdOrTrace === undefined) return folded;
  return folded.filter(
    (r) => r.trace_id === matchIdOrTrace || r.id === matchIdOrTrace
  );
}

export class RunRecordStore {
  private runsFilePath: string;

  constructor(customFilePath?: string) {
    this.runsFilePath =
      customFilePath ||
      process.env.LLMOPS_RUNS_FILE ||
      path.resolve(process.cwd(), '.llmops', 'dev_runs.jsonl');
  }

  /**
   * Point the store at a fresh file (test isolation between parallel workers).
   */
  useFile(filePath: string): void {
    this.runsFilePath = filePath;
  }

  private isSupabaseConfigured(): boolean {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    return Boolean(
      url &&
        key &&
        !url.includes('placeholder') &&
        !url.includes('arabic-law-rag-demo')
    );
  }

  private getSupabase(): SupabaseClient | null {
    if (!this.isSupabaseConfigured()) return null;
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const key =
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
      return createClient(url, key, { auth: { persistSession: false } });
    } catch {
      return null;
    }
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.runsFilePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  private async appendToFile(record: RunRecord): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(record) + '\n';
    await fs.promises.appendFile(this.runsFilePath, line, 'utf8');
  }

  private async readFileRecords(): Promise<RunRecord[]> {
    if (!fs.existsSync(this.runsFilePath)) {
      return [];
    }
    const content = await fs.promises.readFile(this.runsFilePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    const records: RunRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Ignore corrupt lines
      }
    }
    return records;
  }

  /**
   * Start a new run record.
   * Persists to Supabase if configured; falls back to .llmops/dev_runs.jsonl.
   */
  async startRun(record: RunRecord): Promise<RunRecord> {
    const fullRecord: RunRecord = {
      ...record,
      created_at: record.created_at || new Date().toISOString(),
    };

    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const { error } = await supabase.from('ai_runs').insert({
          id: fullRecord.id,
          trace_id: fullRecord.trace_id,
          session_id: fullRecord.session_id || null,
          user_id: fullRecord.user_id && fullRecord.user_id.includes('-') && fullRecord.user_id.length === 36 ? fullRecord.user_id : null,
          case_id: fullRecord.case_id && fullRecord.case_id.includes('-') && fullRecord.case_id.length === 36 ? fullRecord.case_id : null,
          persona: fullRecord.persona || null,
          mode: fullRecord.mode || null,
          route: fullRecord.route || null,
          prompt_version: fullRecord.prompt_version || null,
          model_id: fullRecord.model_id || null,
          rag_index_version: fullRecord.rag_index_version || null,
          guard_version: fullRecord.guard_version || null,
          git_sha: fullRecord.git_sha || null,
          outcome: fullRecord.outcome || 'running',
          ttft_ms: fullRecord.ttft_ms || null,
          t_total_ms: fullRecord.t_total_ms || null,
          tokens_in: fullRecord.tokens_in || null,
          tokens_out: fullRecord.tokens_out || null,
          cost_usd_est: fullRecord.cost_usd_est || null,
          evidence_score: fullRecord.evidence_score || null,
          domain: fullRecord.domain || null,
          is_legal: typeof fullRecord.is_legal === 'boolean' ? fullRecord.is_legal : null,
          error_code: fullRecord.error_code || null,
          created_at: fullRecord.created_at,
          finished_at: fullRecord.finished_at || null,
        });

        if (!error) {
          return fullRecord;
        }
      } catch {
        // Fall back to file if DB operation fails
      }
    }

    // File fallback
    await this.appendToFile(fullRecord);
    return fullRecord;
  }

  /**
   * Finish an existing run with patch data (timings, outcome, tokens, etc.).
   */
  async finishRun(
    run_id: string,
    patch: Partial<RunRecord>
  ): Promise<RunRecord | null> {
    const finished_at = patch.finished_at || new Date().toISOString();
    const fullPatch = { ...patch, finished_at };

    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const updatePayload: Record<string, unknown> = {
          finished_at: fullPatch.finished_at,
        };
        if (fullPatch.outcome !== undefined) updatePayload.outcome = fullPatch.outcome;
        if (fullPatch.ttft_ms !== undefined) updatePayload.ttft_ms = fullPatch.ttft_ms;
        if (fullPatch.t_total_ms !== undefined) updatePayload.t_total_ms = fullPatch.t_total_ms;
        if (fullPatch.tokens_in !== undefined) updatePayload.tokens_in = fullPatch.tokens_in;
        if (fullPatch.tokens_out !== undefined) updatePayload.tokens_out = fullPatch.tokens_out;
        if (fullPatch.cost_usd_est !== undefined) updatePayload.cost_usd_est = fullPatch.cost_usd_est;
        if (fullPatch.evidence_score !== undefined) updatePayload.evidence_score = fullPatch.evidence_score;
        if (fullPatch.error_code !== undefined) updatePayload.error_code = fullPatch.error_code;

        const { data, error } = await supabase
          .from('ai_runs')
          .update(updatePayload)
          .eq('id', run_id)
          .select('*')
          .single();

        if (!error && data) {
          return data as RunRecord;
        }
      } catch {
        // Fall back to file
      }
    }

    // Append-only finish record: concurrent workers never clobber each other.
    // trace_id must match the START record so folds work — recover it from disk.
    const existingRecords = await this.readFileRecords();
    const startRecord =
      existingRecords.find((r) => r.id === run_id && r.trace_id) ?? null;
    const finishTraceId = patch.trace_id || startRecord?.trace_id || run_id;
    const finishRecord: RunRecord = {
      ...fullPatch,
      id: run_id,
      trace_id: finishTraceId,
      type: 'finish',
    } as RunRecord & { type?: string };
    await this.appendToFile(finishRecord);
    return finishRecord;
  }

  /**
   * Retrieve a run record by trace_id or run_id.
   */
  async getByTraceId(trace_id: string): Promise<RunRecord | null> {
    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('ai_runs')
          .select('*')
          .or(`trace_id.eq.${trace_id},id.eq.${trace_id}`)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!error && data) {
          return data as RunRecord;
        }
      } catch {
        // Fall back to file
      }
    }

    const records = await this.readFileRecords();
    return foldRunRecords(records, trace_id)[0] ?? null;
  }

  /**
   * Retrieve a run record by run_id or trace_id.
   */
  async getRun(idOrTraceId: string): Promise<RunRecord | null> {
    return this.getByTraceId(idOrTraceId);
  }

  /**
   * List runs for a given user.
   */
  async listByUserId(user_id: string): Promise<RunRecord[]> {
    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('ai_runs')
          .select('*')
          .eq('user_id', user_id)
          .order('created_at', { ascending: false });

        if (!error && data) {
          return data as RunRecord[];
        }
      } catch {
        // Fall back
      }
    }

    const records = await this.readFileRecords();
    return foldRunRecords(records).filter((r) => r.user_id === user_id);
  }

  /**
   * Clear file store (for testing).
   */
  async clear(): Promise<void> {
    if (fs.existsSync(this.runsFilePath)) {
      await fs.promises.unlink(this.runsFilePath).catch(() => {});
    }
  }
}

export const runStore = new RunRecordStore();
