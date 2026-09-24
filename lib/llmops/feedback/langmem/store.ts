import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { FeedbackWrite, FeedbackWriteInput } from '../schema';
import {
  rankAndFilterMemories,
  type MemoryRecallFilters,
} from './retrieve';

export interface MemoryItem {
  id: string;
  tier: 'T0' | 'T1' | 'T2' | 'T3' | 'T4';
  scope: string;
  owner_user_id?: string | null;
  lawyer_id?: string | null;
  content: string;
  source_feedback_id?: string | null;
  source_trace_id?: string | null;
  confidence: number;
  validated_by?: string | null;
  validated_at?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  deprecated_at?: string | null;
  deprecate_reason?: string | null;
  metadata: Record<string, unknown>;
}

export interface MemoryHit {
  memory_id: string;
  tier: 'T0' | 'T1' | 'T2';
  content: string;
  score: number;
  source_trace_id?: string | null;
  confidence: number;
  scope: string;
}

export interface MemoryListFilters {
  tier?: 'T0' | 'T1' | 'T2' | 'T3';
  scope?: string;
  lawyer_id?: string;
  user_id?: string;
  case_id?: string;
  active?: boolean;
  limit?: number;
}
export interface MemoryListResult {
  items: MemoryItem[];
  next_cursor?: string | null;
}

export class LangMemStore {
  private memoryFilePath: string;

  constructor(customFilePath?: string) {
    this.memoryFilePath =
      customFilePath || path.resolve(process.cwd(), '.llmops', 'dev_memory_items.jsonl');
  }

  setFilePath(customFilePath: string): void {
    this.memoryFilePath = customFilePath;
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
    const dir = path.dirname(this.memoryFilePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  private async appendToFile(item: MemoryItem): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(item) + '\n';
    await fs.promises.appendFile(this.memoryFilePath, line, 'utf8');
  }

  private async rewriteFile(items: MemoryItem[]): Promise<void> {
    await this.ensureDir();
    const content = items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : '');
    await fs.promises.writeFile(this.memoryFilePath, content, 'utf8');
  }

  async readFileItems(): Promise<MemoryItem[]> {
    if (!fs.existsSync(this.memoryFilePath)) {
      return [];
    }
    const content = await fs.promises.readFile(this.memoryFilePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    const items: MemoryItem[] = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line));
      } catch {
        // Ignore corrupt lines
      }
    }
    return items;
  }

  /**
   * Persist a generic memory item (T0, T1, T2, T3) into the store.
   */
  async putItem(item: MemoryItem): Promise<MemoryItem> {
    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const { error } = await supabase.from('ai_memory_items').upsert({
          id: item.id,
          tier: item.tier,
          scope: item.scope,
          owner_user_id: item.owner_user_id && item.owner_user_id.length === 36 ? item.owner_user_id : null,
          lawyer_id: item.lawyer_id && item.lawyer_id.length === 36 ? item.lawyer_id : null,
          content: item.content,
          source_feedback_id: item.source_feedback_id && item.source_feedback_id.length === 36 ? item.source_feedback_id : null,
          source_trace_id: item.source_trace_id || null,
          confidence: item.confidence,
          validated_by: item.validated_by && item.validated_by.length === 36 ? item.validated_by : null,
          validated_at: item.validated_at || null,
          active: item.active,
          created_at: item.created_at,
          updated_at: item.updated_at,
          deprecated_at: item.deprecated_at || null,
          deprecate_reason: item.deprecate_reason || null,
          metadata: item.metadata,
        });
        if (!error) {
          return item;
        }
      } catch {
        // Fall back to file
      }
    }

    // Offline file fallback
    const items = await this.readFileItems();
    const existingIndex = items.findIndex((it) => it.id === item.id);
    if (existingIndex >= 0) {
      items[existingIndex] = item;
      await this.rewriteFile(items);
    } else {
      await this.appendToFile(item);
    }
    return item;
  }

  /**
   * Persist a feedback item into T0 episodic memory.
   */
  async putFeedback(
    input: FeedbackWriteInput | FeedbackWrite,
    feedback_id?: string
  ): Promise<MemoryItem> {
    const content = input.correction_text
      ? `[${input.kind}] ${input.target_span || 'general'}: ${input.correction_text}`
      : `[${input.kind}] ${input.target_span || 'general'}${
          input.tags && input.tags.length ? ` tags: ${input.tags.join(', ')}` : ''
        }`;

    const scope = input.case_id
      ? `case:${input.case_id}`
      : input.lawyer_id
      ? `lawyer:${input.lawyer_id}`
      : input.user_id
      ? `user:${input.user_id}`
      : 'global';

    const item: MemoryItem = {
      id: randomUUID(),
      tier: 'T0',
      scope,
      owner_user_id: input.user_id || null,
      lawyer_id: input.lawyer_id || null,
      content,
      source_feedback_id: feedback_id || null,
      source_trace_id: input.trace_id,
      confidence: 1.0,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        kind: input.kind,
        target_span: input.target_span || null,
        tags: input.tags || [],
        rating: input.rating || null,
        citations_user_flagged: input.citations_user_flagged || [],
        run_id: input.run_id,
        persona: input.persona || null,
        mode: input.mode || null,
      },
    };

    return this.putItem(item);
  }

  /**
   * Retrieve memory items for a specific trace_id.
   */
  async getForRun(trace_id: string): Promise<MemoryItem[]> {
    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('ai_memory_items')
          .select('*')
          .eq('source_trace_id', trace_id)
          .eq('active', true);

        if (!error && data) {
          return data as MemoryItem[];
        }
      } catch {
        // Fall back
      }
    }

    const items = await this.readFileItems();
    return items.filter((it) => it.source_trace_id === trace_id && it.active);
  }

  /**
   * Retrieve a single memory item by its ID.
   */
  async getItem(id: string): Promise<MemoryItem | null> {
    const supabase = this.getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('ai_memory_items')
          .select('*')
          .eq('id', id)
          .single();

        if (!error && data) {
          return data as MemoryItem;
        }
      } catch {
        // Fall back
      }
    }

    const items = await this.readFileItems();
    const found = items.find((it) => it.id === id);
    return found || null;
  }

  /**
   * Recall memory items relevant to a query or context filters.
   * Offline-first token-overlap scoring over active T1/T2 items + recent T0.
   */
  async recall(
    query: string,
    filters?: MemoryRecallFilters
  ): Promise<MemoryHit[]> {
    let items: MemoryItem[] = [];

    const supabase = this.getSupabase();
    if (supabase) {
      try {
        let queryBuilder = supabase
          .from('ai_memory_items')
          .select('*')
          .eq('active', true);

        if (filters?.case_id) {
          queryBuilder = queryBuilder.or(`scope.eq.global,scope.eq.case:${filters.case_id}`);
        } else if (filters?.lawyer_id) {
          queryBuilder = queryBuilder.or(`scope.eq.global,scope.eq.lawyer:${filters.lawyer_id}`);
        }

        const { data, error } = await queryBuilder;
        if (!error && data && data.length > 0) {
          items = data as MemoryItem[];
        }
      } catch {
        // Fall back to file
      }
    }

    if (items.length === 0) {
      items = await this.readFileItems();
    }

    return rankAndFilterMemories(items, query, filters);
  }

  /**
   * Deprecate a memory item by ID with an explicit reason.
   */
  async deprecate(memory_id: string, reason: string): Promise<MemoryItem | null> {
    const now = new Date().toISOString();
    const supabase = this.getSupabase();

    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('ai_memory_items')
          .update({
            active: false,
            deprecated_at: now,
            deprecate_reason: reason,
            updated_at: now,
          })
          .eq('id', memory_id)
          .select()
          .single();

        if (!error && data) {
          return data as MemoryItem;
        }
      } catch {
        // Fall back to file
      }
    }

    const items = await this.readFileItems();
    const itemIndex = items.findIndex((it) => it.id === memory_id);
    if (itemIndex === -1) {
      return null;
    }

    items[itemIndex] = {
      ...items[itemIndex],
      active: false,
      deprecated_at: now,
      deprecate_reason: reason,
      updated_at: now,
    };

    await this.rewriteFile(items);
    return items[itemIndex];
  }

  /**
   * List memory items with optional filters and cursor-based pagination.
   */
  async list(
    filters?: MemoryListFilters,
    cursor?: string | null
  ): Promise<MemoryListResult> {
    const limit = filters?.limit && filters.limit > 0 ? filters.limit : 50;
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;

    const supabase = this.getSupabase();
    if (supabase) {
      try {
        let queryBuilder = supabase.from('ai_memory_items').select('*');

        if (filters?.tier) {
          queryBuilder = queryBuilder.eq('tier', filters.tier);
        }
        if (filters?.scope) {
          queryBuilder = queryBuilder.eq('scope', filters.scope);
        }
        if (filters?.lawyer_id) {
          queryBuilder = queryBuilder.eq('lawyer_id', filters.lawyer_id);
        }
        if (filters?.user_id) {
          queryBuilder = queryBuilder.eq('owner_user_id', filters.user_id);
        }
        if (filters?.active !== undefined) {
          queryBuilder = queryBuilder.eq('active', filters.active);
        }

        queryBuilder = queryBuilder
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        const { data, error } = await queryBuilder;
        if (!error && data) {
          const items = data as MemoryItem[];
          const next_cursor = items.length === limit ? String(offset + limit) : null;
          return { items, next_cursor };
        }
      } catch {
        // Fall back to file
      }
    }

    const allItems = await this.readFileItems();
    const filtered = allItems.filter((item) => {
      if (filters?.tier && item.tier !== filters.tier) return false;
      if (filters?.scope && item.scope !== filters.scope) return false;
      if (filters?.lawyer_id && item.lawyer_id !== filters.lawyer_id) return false;
      if (filters?.user_id && item.owner_user_id !== filters.user_id) return false;
      if (filters?.case_id && !item.scope.includes(filters.case_id)) return false;
      if (filters?.active !== undefined && item.active !== filters.active) return false;
      return true;
    });

    filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const pageItems = filtered.slice(offset, offset + limit);
    const next_cursor = offset + limit < filtered.length ? String(offset + limit) : null;

    return { items: pageItems, next_cursor };
  }

  /**
   * Clear file store (for testing).
   */
  async clear(): Promise<void> {
    if (fs.existsSync(this.memoryFilePath)) {
      await fs.promises.unlink(this.memoryFilePath).catch(() => {});
    }
  }
}

export const langMemStore = new LangMemStore();
