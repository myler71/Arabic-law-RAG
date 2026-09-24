import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { langMemStore, type MemoryItem } from './store';
import { feedbackStore } from '../api';
import type { FeedbackRecord } from '../schema';
import { llmopsLogger } from '../../logging/logger';
import { LLMOPS_EVENTS } from '../../logging/events';

export interface ApproverInfo {
  id: string;
  role?: 'lawyer' | 'admin' | 'client' | string;
}

export interface PromoteToInstructionOptions {
  role?: 'lawyer' | 'admin' | string;
  scope?: string;
}

export interface EvalGoldRecord {
  id: string;
  source_feedback_id: string;
  source_trace_id?: string | null;
  curator_id: string;
  promoted_at: string;
  query: string;
  expected_output: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

function isSupabaseConfigured(): boolean {
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

function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
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

/**
 * Promote an episodic feedback item to a durable T1 instruction memory item.
 * Requires an approver with role 'lawyer' or 'admin'.
 * Emits ai.memory.write log with promoted=true and validated_by.
 */
export async function promoteToInstruction(
  feedback_id: string,
  approver: string | ApproverInfo,
  reason: string,
  options?: PromoteToInstructionOptions
): Promise<MemoryItem> {
  const approverId = typeof approver === 'string' ? approver : approver?.id;
  if (!approverId || !approverId.trim()) {
    throw new Error('مطلوب معتمد لترقية الملاحظة إلى تعليمات (Approver required to promote to instruction)');
  }

  // Determine approver role
  let role = typeof approver === 'object' && approver?.role ? approver.role : options?.role;
  if (!role) {
    const lowerId = approverId.toLowerCase();
    if (lowerId.includes('client')) {
      role = 'client';
    } else if (lowerId.includes('admin')) {
      role = 'admin';
    } else {
      role = 'lawyer';
    }
  }

  if (role !== 'lawyer' && role !== 'admin') {
    throw new Error('غير مصرح: يجب أن يكون المعتمد محامياً أو مسؤولاً (Approver must have role lawyer or admin)');
  }

  if (!reason || !reason.trim()) {
    throw new Error('سبب الترقية مطلوب (Promotion reason is required)');
  }

  // Retrieve source feedback or existing T0 memory item
  const allFeedback = await feedbackStore.listFeedback();
  const feedback = allFeedback.find((fb) => fb.id === feedback_id);

  let correctionText = feedback?.correction_text || '';
  let traceId = feedback?.trace_id || null;
  let lawyerId = feedback?.lawyer_id || (role === 'lawyer' ? approverId : null);

  if (!correctionText) {
    // Check if feedback_id matches a memory item
    const memoryItems = await langMemStore.readFileItems();
    const mem = memoryItems.find(
      (m) => m.source_feedback_id === feedback_id || m.id === feedback_id
    );
    if (mem) {
      correctionText = mem.content;
      traceId = traceId || mem.source_trace_id || null;
      lawyerId = lawyerId || mem.lawyer_id || null;
    }
  }

  if (!correctionText) {
    correctionText = `تعليمات مصوبة بناءً على ملاحظة (${feedback_id}): ${reason}`;
  }

  // Determine T1 scope
  let scope = options?.scope;
  if (!scope) {
    if (role === 'admin') {
      scope = 'global';
    } else if (lawyerId) {
      scope = `lawyer:${lawyerId}`;
    } else {
      scope = `lawyer:${approverId}`;
    }
  }

  const now = new Date().toISOString();
  const t1Item: MemoryItem = {
    id: randomUUID(),
    tier: 'T1',
    scope,
    owner_user_id: approverId,
    lawyer_id: lawyerId,
    content: correctionText,
    source_feedback_id: feedback_id,
    source_trace_id: traceId,
    confidence: 1.0,
    validated_by: approverId,
    validated_at: now,
    active: true,
    created_at: now,
    updated_at: now,
    metadata: {
      promoted: true,
      promoted_from: feedback_id,
      approver_id: approverId,
      approver_role: role,
      reason,
      tags: feedback?.tags || [],
    },
  };

  // Persist T1 memory item
  await langMemStore.putItem(t1Item);

  // Emit structured log
  llmopsLogger.info(LLMOPS_EVENTS.MEMORY_WRITE, {
    memory_id: t1Item.id,
    tier: 'T1',
    scope: t1Item.scope,
    source_feedback_id: feedback_id,
    source_trace_id: t1Item.source_trace_id,
    promoted: true,
    validated_by: approverId,
    reason,
  });

  return t1Item;
}

/**
 * Promote an episodic feedback item to an evaluation gold dataset case (T3).
 * Returns the generated eval_case_id.
 * Emits ai.memory.write log with promoted=true and validated_by.
 */
export async function promoteToEvalGold(
  feedback_id: string,
  curator_id: string,
  options?: { query?: string; expected_output?: string }
): Promise<string> {
  if (!curator_id || !curator_id.trim()) {
    throw new Error('مطلوب قيّم أو معتمد لترقية الملاحظة إلى حالات التقييم الذهبية (Curator required to promote to eval gold)');
  }

  const allFeedback = await feedbackStore.listFeedback();
  const feedback = allFeedback.find((fb) => fb.id === feedback_id);

  let traceId = feedback?.trace_id || null;
  let expectedOutput =
    options?.expected_output || feedback?.correction_text || '';
  const query = options?.query || feedback?.target_span || '';

  if (!expectedOutput) {
    const memoryItems = await langMemStore.readFileItems();
    const mem = memoryItems.find(
      (m) => m.source_feedback_id === feedback_id || m.id === feedback_id
    );
    if (mem) {
      expectedOutput = mem.content;
      traceId = traceId || mem.source_trace_id || null;
    }
  }

  const eval_case_id = randomUUID();
  const now = new Date().toISOString();

  const evalRecord: EvalGoldRecord = {
    id: eval_case_id,
    source_feedback_id: feedback_id,
    source_trace_id: traceId,
    curator_id,
    promoted_at: now,
    query: query || `استفسار قانوني مرتبط بالملاحظة ${feedback_id}`,
    expected_output: expectedOutput,
    tags: feedback?.tags || ['promoted_gold'],
    metadata: {
      feedback_id,
      curator_id,
      rating: feedback?.rating,
      kind: feedback?.kind,
    },
  };

  // 1. Offline storage: append to .llmops/eval_gold_promotions.jsonl
  const filePath = path.resolve(process.cwd(), '.llmops', 'eval_gold_promotions.jsonl');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  await fs.promises.appendFile(filePath, JSON.stringify(evalRecord) + '\n', 'utf8');

  // 2. Online storage attempt: insert to public.ai_eval_cases if available
  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from('ai_eval_cases').insert({
        id: evalRecord.id,
        source_feedback_id: evalRecord.source_feedback_id.length === 36 ? evalRecord.source_feedback_id : null,
        curator_id: evalRecord.curator_id.length === 36 ? evalRecord.curator_id : null,
        suite: 'eval_gold_promotions',
        query: evalRecord.query,
        expected_output: evalRecord.expected_output,
        tags: evalRecord.tags,
        metadata: evalRecord.metadata,
        created_at: now,
      });
    } catch {
      // Offline fallback already succeeded
    }
  }

  // 3. Emit structured log
  llmopsLogger.info(LLMOPS_EVENTS.MEMORY_WRITE, {
    eval_case_id,
    tier: 'T3',
    source_feedback_id: feedback_id,
    source_trace_id: traceId,
    promoted: true,
    validated_by: curator_id,
    target: 'eval_gold',
  });

  return eval_case_id;
}
