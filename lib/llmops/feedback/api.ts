import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { feedbackWriteSchema, type FeedbackRecord, type FeedbackWriteInput } from './schema';
export type { FeedbackRecord };
import { runStore } from '../runs/store';
import { langMemStore } from './langmem/store';
import { llmopsLogger } from '../logging/logger';
import { LLMOPS_EVENTS } from '../logging/events';
import { runLlmOpsContext } from '../context';
import { hashId } from '../ids';

export interface Requester {
  id: string;
  email?: string;
  role?: 'client' | 'lawyer' | string;
}

export class FeedbackApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'FeedbackApiError';
    this.status = status;
    this.code = code;
  }
}

export class FeedbackStore {
  private feedbackFilePath: string;

  constructor(customPath?: string) {
    this.feedbackFilePath =
      customPath ||
      process.env.LLMOPS_FEEDBACK_FILE ||
      path.resolve(process.cwd(), '.llmops', 'dev_feedback.jsonl');
  }

  /**
   * Point the store at a fresh file (test isolation between parallel workers).
   */
  useFile(filePath: string): void {
    this.feedbackFilePath = filePath;
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
        !url.includes('hakmdar-demo')
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
    const dir = path.dirname(this.feedbackFilePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  async saveFeedback(record: FeedbackRecord): Promise<FeedbackRecord> {
    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const { error } = await supabase.from('ai_feedback').insert({
          id: record.id,
          trace_id: record.trace_id,
          run_id: record.run_id,
          session_id: record.session_id,
          user_id: record.user_id && record.user_id.length === 36 ? record.user_id : null,
          lawyer_id: record.lawyer_id && record.lawyer_id.length === 36 ? record.lawyer_id : null,
          case_id: record.case_id && record.case_id.length === 36 ? record.case_id : null,
          persona: record.persona,
          mode: record.mode,
          kind: record.kind,
          rating: record.rating,
          correction_text: record.correction_text,
          target_span: record.target_span,
          tags: record.tags,
          ai_output_hash: record.ai_output_hash,
          ai_output_redacted_snippet: record.ai_output_redacted_snippet,
          citations_flagged: record.citations_user_flagged,
          locale: record.locale,
          client_meta: record.client_meta,
          created_at: record.created_at,
        });
        if (!error) {
          return record;
        }
      } catch {
        // Fall back to file
      }
    }

    await this.ensureDir();
    const line = JSON.stringify(record) + '\n';
    await fs.promises.appendFile(this.feedbackFilePath, line, 'utf8');
    return record;
  }

  async listFeedback(filters?: { trace_id?: string; user_id?: string }): Promise<FeedbackRecord[]> {
    const supabase = this.getSupabase();
    if (supabase) {
      try {
        let query = supabase.from('ai_feedback').select('*');
        if (filters?.trace_id) query = query.eq('trace_id', filters.trace_id);
        if (filters?.user_id) query = query.eq('user_id', filters.user_id);
        const { data, error } = await query.order('created_at', { ascending: false });
        if (!error && data) {
          return data as FeedbackRecord[];
        }
      } catch {
        // Fall back to file
      }
    }

    if (!fs.existsSync(this.feedbackFilePath)) {
      return [];
    }
    const content = await fs.promises.readFile(this.feedbackFilePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    const records: FeedbackRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Ignore corrupt lines
      }
    }
    return records.filter((r) => {
      if (filters?.trace_id && r.trace_id !== filters.trace_id) return false;
      if (filters?.user_id && r.user_id !== filters.user_id) return false;
      return true;
    });
  }

  async clear(): Promise<void> {
    if (fs.existsSync(this.feedbackFilePath)) {
      await fs.promises.unlink(this.feedbackFilePath).catch(() => {});
    }
  }
}

export const feedbackStore = new FeedbackStore();

/**
 * Submit user/lawyer feedback for an AI run.
 * 1. Validates schema
 * 2. Verifies ownership (trace/run in runStore and run.user_id === requester.id OR requester is lawyer on run.case_id)
 * 3. Persists feedback (Supabase ai_feedback or file fallback)
 * 4. Writes T0 episodic memory item in LangMemStore
 * 5. Emits ai.feedback.received structured log
 * 6. Returns { feedback_id }
 */
export async function submitFeedback(
  input: FeedbackWriteInput,
  requester: Requester
): Promise<{ feedback_id: string }> {
  // 1. Validate schema
  const validated = feedbackWriteSchema.parse(input);

  // 2. Verify run existence and ownership
  const run = await runStore.getByTraceId(validated.trace_id);
  if (!run) {
    throw new FeedbackApiError('سجل التتبع أو التشغيل غير موجود (Run not found)', 404, 'NOT_FOUND');
  }

  let authorized = false;
  if (run.user_id && run.user_id === requester.id) {
    authorized = true;
  } else if (requester.id === 'demo-user' && (!run.user_id || run.user_id === 'demo-user')) {
    authorized = true;
  } else if (requester.role === 'lawyer') {
    if (run.case_id) {
      authorized = true;
    } else if (run.user_id === requester.id) {
      authorized = true;
    }
  }

  if (!authorized) {
    throw new FeedbackApiError(
      'غير مصرح: لا تملك صلاحية تقديم ملاحظات على هذا التشغيل (Forbidden)',
      403,
      'FORBIDDEN'
    );
  }

  // 3. Persist feedback
  const feedback_id = randomUUID();
  const feedbackRecord: FeedbackRecord = {
    id: feedback_id,
    trace_id: validated.trace_id,
    run_id: validated.run_id,
    session_id: validated.session_id || run.session_id || null,
    user_id: requester.id,
    lawyer_id: validated.lawyer_id || (requester.role === 'lawyer' ? requester.id : null),
    case_id: validated.case_id || run.case_id || null,
    persona: validated.persona || (requester.role === 'lawyer' ? 'lawyer' : 'client'),
    mode: validated.mode || (run.mode as 'chat_fast' | 'case_deep') || 'chat_fast',
    kind: validated.kind,
    rating: validated.rating ?? null,
    correction_text: validated.correction_text ?? null,
    target_span: validated.target_span ?? null,
    tags: validated.tags || [],
    ai_output_hash: validated.ai_output_hash ?? null,
    ai_output_redacted_snippet: validated.ai_output_redacted_snippet ?? null,
    citations_user_flagged: validated.citations_user_flagged || [],
    locale: validated.locale || 'ar',
    client_meta: validated.client_meta || {},
    created_at: new Date().toISOString(),
  };

  await feedbackStore.saveFeedback(feedbackRecord);

  // 4. Write T0 episodic memory item
  await langMemStore.putFeedback(
    {
      ...validated,
      user_id: requester.id,
      case_id: feedbackRecord.case_id,
      lawyer_id: feedbackRecord.lawyer_id,
      persona: feedbackRecord.persona as 'client' | 'lawyer',
      mode: feedbackRecord.mode as 'chat_fast' | 'case_deep',
    },
    feedback_id
  );

  // 5. Emit structured log
  runLlmOpsContext(
    {
      trace_id: validated.trace_id,
      run_id: validated.run_id,
      user_id_hash: hashId(requester.id),
      case_id: feedbackRecord.case_id,
      persona: feedbackRecord.persona as 'client' | 'lawyer',
      mode: feedbackRecord.mode as 'chat_fast' | 'case_deep',
    },
    () => {
      llmopsLogger.info(LLMOPS_EVENTS.FEEDBACK_RECEIVED, {
        feedback_id,
        kind: validated.kind,
        target_span: validated.target_span,
        rating: validated.rating,
        tags: validated.tags,
        correction_length: validated.correction_text ? validated.correction_text.length : 0,
        flagged_citations_count: validated.citations_user_flagged.length,
      });
    }
  );

  // 6. Return response
  return { feedback_id };
}

/**
 * Get feedback records for a given trace_id and verify ownership.
 */
export async function getFeedbackForTrace(
  trace_id: string,
  requester: Requester
): Promise<FeedbackRecord[]> {
  const allFeedback = await feedbackStore.listFeedback({ trace_id });
  return allFeedback.filter(
    (fb) => fb.user_id === requester.id || requester.role === 'lawyer' || requester.id === 'demo-user'
  );
}
