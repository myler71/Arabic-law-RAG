import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { langMemStore, type MemoryItem, type MemoryHit } from '@/lib/llmops/feedback/langmem/store';
import {
  promoteToInstruction,
  promoteToEvalGold,
} from '@/lib/llmops/feedback/langmem/promote';
import {
  recallMemoryHints,
  buildMemoryPromptBlock,
  stripArticleNumbers,
  sanitizeMemoryContent,
  MEMORY_HINTS_HEADER,
  T0_SIMILARITY_THRESHOLD,
} from '@/lib/llmops/feedback/inject';
import { setLogSink, type LlmopsLogEnvelope } from '@/lib/llmops/logging/logger';
import { LLMOPS_EVENTS } from '@/lib/llmops/logging/events';

describe('LLMOps Memory and LangMem Feedback System (Spec L5)', () => {
  const capturedLogs: LlmopsLogEnvelope[] = [];
  const evalGoldPath = path.resolve(process.cwd(), '.llmops', 'eval_gold_promotions.jsonl');
  const testMemoryPath = path.resolve(process.cwd(), '.llmops', 'test_memory_items.jsonl');

  beforeAll(() => {
    langMemStore.setFilePath(testMemoryPath);
  });

  afterAll(async () => {
    langMemStore.setFilePath(path.resolve(process.cwd(), '.llmops', 'dev_memory_items.jsonl'));
    if (fs.existsSync(testMemoryPath)) {
      await fs.promises.unlink(testMemoryPath).catch(() => {});
    }
  });
  beforeEach(async () => {
    capturedLogs.length = 0;
    setLogSink((_, env) => {
      capturedLogs.push(env);
    });
    await langMemStore.clear();

    if (fs.existsSync(evalGoldPath)) {
      await fs.promises.unlink(evalGoldPath).catch(() => {});
    }
  });

  afterEach(async () => {
    setLogSink(null);
    await langMemStore.clear();

    if (fs.existsSync(evalGoldPath)) {
      await fs.promises.unlink(evalGoldPath).catch(() => {});
    }
  });

  describe('1. putFeedback -> recall returns T0 hit', () => {
    it('persists feedback into T0 episodic memory and recalls it with token overlap', async () => {
      const storedItem = await langMemStore.putFeedback({
        trace_id: 'trace-mem-001',
        run_id: 'run-mem-001',
        user_id: 'user-client-123',
        lawyer_id: 'lawyer-456',
        case_id: 'case-789',
        kind: 'corrected',
        rating: 3,
        correction_text: 'يجب التحقق من اختصاص المحكمة العمالية الابتدائية قبل رفع الدعوى',
        target_span: 'procedure',
        tags: ['jurisdiction', 'labor_court'],
      });

      expect(storedItem).toBeDefined();
      expect(storedItem.tier).toBe('T0');
      expect(storedItem.active).toBe(true);
      expect(storedItem.source_trace_id).toBe('trace-mem-001');

      // Recall by query containing matching tokens
      const hits = await langMemStore.recall('المحكمة العمالية الابتدائية', {
        case_id: 'case-789',
        k: 5,
      });

      expect(hits.length).toBeGreaterThanOrEqual(1);
      const firstHit = hits[0];
      expect(firstHit.tier).toBe('T0');
      expect(firstHit.score).toBeGreaterThan(0.5);
      expect(firstHit.content).toContain('المحكمة العمالية');
      expect(firstHit.source_trace_id).toBe('trace-mem-001');
    });
  });

  describe('2. promote without approver -> error', () => {
    it('throws error when approver is empty or missing', async () => {
      await expect(
        promoteToInstruction('fb-123', '', 'تصحيح صيغة صحيفة الدعوى')
      ).rejects.toThrow(/Approver required|مطلوب معتمد/i);

      await expect(
        promoteToInstruction('fb-123', null as unknown as string, 'تصحيح صيغة صحيفة الدعوى')
      ).rejects.toThrow(/Approver required|مطلوب معتمد/i);
    });

    it('throws error when approver role is client or unauthorized', async () => {
      await expect(
        promoteToInstruction('fb-123', 'client-user-999', 'ملاحظة عميل', {
          role: 'client',
        })
      ).rejects.toThrow(/lawyer or admin|غير مصرح/i);

      await expect(
        promoteToInstruction(
          'fb-123',
          { id: 'client-user-999', role: 'client' },
          'ملاحظة عميل'
        )
      ).rejects.toThrow(/lawyer or admin|غير مصرح/i);
    });

    it('throws error when promotion reason is empty', async () => {
      await expect(
        promoteToInstruction('fb-123', 'lawyer-1', '   ', { role: 'lawyer' })
      ).rejects.toThrow(/reason is required|سبب الترقية مطلوب/i);
    });
  });

  describe('3. promote with approver -> T1 item + log and promoteToEvalGold', () => {
    it('promotes feedback with lawyer approver into T1 instruction and emits ai.memory.write log', async () => {
      // 1. Seed T0 feedback memory
      const t0 = await langMemStore.putFeedback(
        {
          trace_id: 'trace-prom-01',
          run_id: 'run-prom-01',
          user_id: 'client-55',
          lawyer_id: 'lawyer-88',
          kind: 'corrected',
          correction_text: 'يجب دائماً طلب أصل عقد العمل وصحيفة الحالة الجنائية',
          target_span: 'procedure',
        },
        'feedback-prom-01'
      );

      // 2. Promote to T1 instruction by lawyer
      const t1 = await promoteToInstruction(
        'feedback-prom-01',
        'lawyer-88',
        'اعتماد كقاعدة إجرائية دائمة لمكتب المحاماة',
        { role: 'lawyer' }
      );

      expect(t1).toBeDefined();
      expect(t1.tier).toBe('T1');
      expect(t1.validated_by).toBe('lawyer-88');
      expect(t1.validated_at).toBeTruthy();
      expect(t1.scope).toBe('lawyer:lawyer-88');
      expect(t1.content).toContain('طلب أصل عقد العمل');
      expect(t1.active).toBe(true);

      // 3. Verify ai.memory.write structured log
      const writeLog = capturedLogs.find(
        (l) =>
          l.event === LLMOPS_EVENTS.MEMORY_WRITE &&
          (l.data as Record<string, unknown>)?.memory_id === t1.id
      );
      expect(writeLog).toBeDefined();
      expect(writeLog?.data?.promoted).toBe(true);
      expect(writeLog?.data?.validated_by).toBe('lawyer-88');
      expect(writeLog?.data?.tier).toBe('T1');

      // 4. Verify T1 item is retrievable via recall
      const recalled = await langMemStore.recall('عقد العمل', {
        lawyer_id: 'lawyer-88',
      });
      const t1Hit = recalled.find((h) => h.memory_id === t1.id);
      expect(t1Hit).toBeDefined();
      expect(t1Hit?.tier).toBe('T1');
    });

    it('promotes feedback to eval gold dataset (T3) and logs ai.memory.write', async () => {
      const evalCaseId = await promoteToEvalGold(
        'feedback-prom-01',
        'curator-admin-1',
        {
          query: 'ما هي المستندات المطلوبة في الدعاوى العمالية؟',
          expected_output: 'عقد العمل المبرم ومفردات المرتب',
        }
      );

      expect(evalCaseId).toBeDefined();
      expect(typeof evalCaseId).toBe('string');
      expect(evalCaseId.length).toBeGreaterThan(10);

      // Check log
      const evalLog = capturedLogs.find(
        (l) =>
          l.event === LLMOPS_EVENTS.MEMORY_WRITE &&
          (l.data as Record<string, unknown>)?.eval_case_id === evalCaseId
      );
      expect(evalLog).toBeDefined();
      expect(evalLog?.data?.promoted).toBe(true);
      expect(evalLog?.data?.validated_by).toBe('curator-admin-1');
      expect(evalLog?.data?.target).toBe('eval_gold');

      // Check offline file existence
      expect(fs.existsSync(evalGoldPath)).toBe(true);
      const content = await fs.promises.readFile(evalGoldPath, 'utf8');
      expect(content).toContain(evalCaseId);
      expect(content).toContain('curator-admin-1');
    });
  });

  describe('4. inject strips fabricated article numbers from memory content', () => {
    it('strips Arabic article numbers from raw hint content', () => {
      const text1 = 'وفقاً لنص المادة 122 من قانون العمل بدلاً من المادة 120 المستشهد بها';
      const sanitized1 = stripArticleNumbers(text1);

      expect(sanitized1).not.toMatch(/\u0627\u0644\u0645\u0627\u062f\u0629\s*\d+/);
      expect(sanitized1).toContain('[REDACTED:ARTICLE_REF]');
      expect(sanitized1).toContain('بدلاً من');

      const text2 = 'تطبق مادة 15 فقرة 2 والمادة رقم 4 مكرر';
      const sanitized2 = stripArticleNumbers(text2);
      expect(sanitized2).not.toMatch(/مادة\s*\d+/);
      expect(sanitized2).not.toMatch(/المادة\s*رقم\s*\d+/);
    });

    it('buildMemoryPromptBlock labels section and strips article numbers from all hits', () => {
      const hits: MemoryHit[] = [
        {
          memory_id: 'm1',
          tier: 'T1',
          content: 'تنبيه: يجب الرجوع إلى المادة 68 من القانون المدني',
          score: 0.95,
          confidence: 1.0,
          scope: 'lawyer:lawyer-1',
        },
        {
          memory_id: 'm2',
          tier: 'T0',
          content: 'ملاحظة المستخدم: المادة 105 لم تعد سارية',
          score: 0.8,
          confidence: 0.7,
          scope: 'case:c1',
        },
      ];

      const block = buildMemoryPromptBlock(hits);

      expect(block).toContain(MEMORY_HINTS_HEADER);
      expect(block).not.toMatch(/المادة\s*68/);
      expect(block).not.toMatch(/المادة\s*105/);
      expect(block).toContain('[T1] (lawyer:lawyer-1):');
      expect(block).toContain('[T0] (case:c1):');
      expect(block).toContain('[REDACTED:ARTICLE_REF]');
    });

    it('buildMemoryPromptBlock returns empty string for empty hits', () => {
      expect(buildMemoryPromptBlock([])).toBe('');
    });
  });

  describe('5. T0 dropped when corpus score high (contradiction / authority rule)', () => {
    it('drops T0 item when corpus retrieval score >= 0.85 and T0 confidence < corpus score', async () => {
      // Seed a T0 item with confidence 0.7
      await langMemStore.putItem({
        id: 't0-contradict-1',
        tier: 'T0',
        scope: 'global',
        content: 'ملاحظة مؤقتة عن شروط التعويض الاتفاقي',
        confidence: 0.7,
        active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      });

      // Also seed a T1 item with confidence 1.0
      await langMemStore.putItem({
        id: 't1-instruction-1',
        tier: 'T1',
        scope: 'global',
        content: 'قاعدة ثابتة: التعويض الاتفاقي يخضع لتقدير القاضي',
        confidence: 1.0,
        active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      });

      // Case A: High corpus score (0.92 >= 0.85), T0 confidence (0.7) < corpus score (0.92) -> T0 dropped
      const hitsA = await recallMemoryHints({
        query: 'التعويض الاتفاقي',
        corpus_top_score: 0.92,
        k: 10,
      });

      const t0HitA = hitsA.find((h) => h.memory_id === 't0-contradict-1');
      const t1HitA = hitsA.find((h) => h.memory_id === 't1-instruction-1');

      expect(t0HitA).toBeUndefined(); // Dropped!
      expect(t1HitA).toBeDefined(); // T1 preserved!

      // Case B: Moderate corpus score (0.65 < 0.85) -> T0 retained
      const hitsB = await recallMemoryHints({
        query: 'التعويض الاتفاقي',
        corpus_top_score: 0.65,
        k: 10,
      });

      const t0HitB = hitsB.find((h) => h.memory_id === 't0-contradict-1');
      expect(t0HitB).toBeDefined();
      expect(t0HitB?.tier).toBe('T0');

      // Verify ai.memory.inject log emitted
      const injectLog = capturedLogs.find((l) => l.event === LLMOPS_EVENTS.MEMORY_INJECT);
      expect(injectLog).toBeDefined();
      expect(injectLog?.data?.injected_count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('6. deprecate and list store operations', () => {
    it('deprecates an item and excludes it from recall', async () => {
      const item = await langMemStore.putItem({
        id: 'mem-deprecate-1',
        tier: 'T1',
        scope: 'global',
        content: 'تعليمات ملغاة عن رسوم التسجيل العقاري',
        confidence: 1.0,
        active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
      });

      const deprecated = await langMemStore.deprecate('mem-deprecate-1', 'تعديل القانون رقم 9 لسنة 2022');
      expect(deprecated).toBeDefined();
      expect(deprecated?.active).toBe(false);
      expect(deprecated?.deprecated_at).toBeTruthy();
      expect(deprecated?.deprecate_reason).toBe('تعديل القانون رقم 9 لسنة 2022');

      // Ensure deprecated item is not recalled
      const recalled = await langMemStore.recall('رسوم التسجيل العقاري');
      expect(recalled.find((h) => h.memory_id === 'mem-deprecate-1')).toBeUndefined();
    });

    it('lists items with filtering and cursor pagination', async () => {
      for (let i = 1; i <= 6; i++) {
        await langMemStore.putItem({
          id: `item-list-${i}`,
          tier: i % 2 === 0 ? 'T1' : 'T0',
          scope: 'global',
          content: `عنصر ذاكرة تجريبي رقم ${i}`,
          confidence: 1.0,
          active: true,
          created_at: new Date(Date.now() - i * 1000).toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {},
        });
      }

      // List with limit 3
      const page1 = await langMemStore.list({ limit: 3 });
      expect(page1.items.length).toBe(3);
      expect(page1.next_cursor).toBe('3');

      // List page 2 with cursor
      const page2 = await langMemStore.list({ limit: 3 }, page1.next_cursor);
      expect(page2.items.length).toBe(3);

      // List with tier filter
      const t1Only = await langMemStore.list({ tier: 'T1' });
      expect(t1Only.items.every((it) => it.tier === 'T1')).toBe(true);
    });
  });
});
