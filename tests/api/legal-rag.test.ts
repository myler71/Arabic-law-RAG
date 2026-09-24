import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  retrieveLegalEvidence,
  verifyCitations,
  normalizeArabic,
  normalizeArabicNumbers,
  tokenizeArabic,
  loadLegalKnowledgeBase,
  resetKnowledgeBaseCache,
  type LegalChunk,
} from '@/lib/ai/legalRag';

describe('Phase 2: Legal RAG Integration', () => {
  beforeEach(() => {
    resetKnowledgeBaseCache();
    delete process.env.LEGAL_RAG_BASE_URL;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.LEGAL_RAG_BASE_URL;
    vi.restoreAllMocks();
  });

  describe('Arabic Normalization & Tokenization', () => {
    it('normalizes Eastern Arabic numerals to standard digits', () => {
      expect(normalizeArabicNumbers('المادة ١٢٢ و المادة ٦٩ و ٥٣٤')).toBe(
        'المادة 122 و المادة 69 و 534'
      );
    });

    it('strips diacritics and unifies Alef, Yeh, and Teh Marbuta', () => {
      const input = 'فَصْلٌ تَعَسُّفِيٌّ وَإِنْهَاءُ خِدْمَةٍ';
      const normalized = normalizeArabic(input);
      expect(normalized).toBe('فصل تعسفي وانهاء خدمه');
    });

    it('removes tatweel (kashida)', () => {
      const input = 'قـــــانـــون الــعـمــل';
      expect(normalizeArabic(input)).toBe('قانون العمل');
    });

    it('tokenizes Arabic query while filtering stop words', () => {
      const tokens = tokenizeArabic('عقوبة الشيك بدون رصيد في القانون التجاري');
      expect(tokens).toContain('عقوبه');
      expect(tokens).toContain('شيك');
      expect(tokens).toContain('رصيد');
      expect(tokens).toContain('قانون');
      expect(tokens).toContain('تجاري');
      expect(tokens).not.toContain('في');
    });
  });

  describe('Knowledge Base Ingestion', () => {
    it('loads both labor law JSON and comprehensive legal database without errors', () => {
      const chunks = loadLegalKnowledgeBase();
      expect(chunks.length).toBeGreaterThanOrEqual(15);

      const hasLaborLaw = chunks.some(
        (c) => c.law_name.includes('قانون العمل') || c.category === 'labor'
      );
      expect(hasLaborLaw).toBe(true);

      const hasCommercialOrPenal = chunks.some(
        (c) => c.id.includes('check') || c.article_number.includes('534') || c.category === 'commercial'
      );
      expect(hasCommercialOrPenal).toBe(true);
    });

    it('ensures each chunk has required statutory metadata', () => {
      const chunks = loadLegalKnowledgeBase();
      for (const chunk of chunks) {
        expect(chunk.id).toBeTruthy();
        expect(chunk.article_number).toBeTruthy();
        expect(chunk.law_name).toBeTruthy();
        expect(chunk.title).toBeTruthy();
        expect(chunk.text).toBeTruthy();
        expect(chunk.summary).toBeTruthy();
        expect(Array.isArray(chunk.keywords)).toBe(true);
      }
    });
  });

  describe('100% Offline Hybrid Retrieval on Common Queries', () => {
    it('retrieves Article 122 and 69 for "فصل تعسفي" query', async () => {
      const result = await retrieveLegalEvidence('فصل تعسفي');
      expect(result.source).toBe('local');
      expect(result.evidence.length).toBeGreaterThan(0);

      // Verify top result covers Article 122 or Article 69
      const topMatches = result.evidence.slice(0, 3);
      const matchedArticles = topMatches.map((e) => e.article_number);
      const hasArticle122or69 = topMatches.some(
        (e) =>
          e.article_number.includes('122') ||
          e.article_number.includes('69') ||
          e.title.includes('122') ||
          e.title.includes('69')
      );
      expect(hasArticle122or69).toBe(true);

      const first = result.evidence[0];
      expect(first.article_number).toBeDefined();
      expect(first.law_name).toBeDefined();
      expect(first.summary).toBeDefined();
      expect(first.confidenceScore).toBeGreaterThan(0);
    });

    it('retrieves Article 534 for "شيك بدون رصيد" commercial query', async () => {
      const result = await retrieveLegalEvidence('شيك بدون رصيد');
      expect(result.source).toBe('local');
      expect(result.evidence.length).toBeGreaterThan(0);

      const topMatches = result.evidence.slice(0, 3);
      const hasArticle534 = topMatches.some(
        (e) =>
          e.article_number.includes('534') ||
          e.title.includes('534') ||
          e.keywords.some((kw) => kw.includes('شيك بدون رصيد'))
      );
      expect(hasArticle534).toBe(true);

      const matchingItem = topMatches.find(
        (e) => e.article_number.includes('534') || e.title.includes('534')
      );
      expect(matchingItem).toBeDefined();
      expect(matchingItem?.law_name).toContain('تجارة');
    });

    it('retrieves notice period articles (110, 111, 116) for "مهلة الإخطار"', async () => {
      const result = await retrieveLegalEvidence('مهلة الإخطار');
      expect(result.source).toBe('local');
      expect(result.evidence.length).toBeGreaterThan(0);

      const topMatches = result.evidence.slice(0, 3);
      const hasNoticeArticle = topMatches.some(
        (e) =>
          e.article_number.includes('110') ||
          e.article_number.includes('111') ||
          e.article_number.includes('116') ||
          e.title.includes('إخطار') ||
          e.title.includes('اخطار')
      );
      expect(hasNoticeArticle).toBe(true);
    });

    it('retrieves end of service gratuity for "مكافأة نهاية الخدمة"', async () => {
      const result = await retrieveLegalEvidence('مكافأة نهاية الخدمة سن الستين');
      expect(result.evidence.length).toBeGreaterThan(0);
      const topMatches = result.evidence.slice(0, 3);
      const hasGratuityArticle = topMatches.some(
        (e) =>
          e.article_number.includes('126') ||
          e.article_number.includes('127') ||
          e.title.includes('نهاية الخدمة') ||
          e.keywords.includes('مكافأة نهاية الخدمة')
      );
      expect(hasGratuityArticle).toBe(true);
    });

    it('retrieves annual leave provision for "إجازة سنوية"', async () => {
      const result = await retrieveLegalEvidence('حقوق العامل في الإجازة السنوية');
      expect(result.evidence.length).toBeGreaterThan(0);
      const hasLeaveArticle = result.evidence.some(
        (e) =>
          e.article_number.includes('47') ||
          e.article_number.includes('48') ||
          e.title.includes('الإجازة السنوية')
      );
      expect(hasLeaveArticle).toBe(true);
    });

    it('respects the topK option', async () => {
      const result = await retrieveLegalEvidence('فصل تعسفي', { topK: 2 });
      expect(result.evidence.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Remote Python RAG Service & Graceful Offline Fallback', () => {
    it('uses remote RAG when LEGAL_RAG_BASE_URL is reachable', async () => {
      process.env.LEGAL_RAG_BASE_URL = 'http://localhost:8000';

      const mockRemoteEvidence = [
        {
          id: 'remote-1',
          article_number: 'المادة 122',
          law_name: 'قانون العمل الموحد',
          title: 'التعويض عن الفصل التعسفي',
          text: 'نص المادة 122...',
          summary: 'تعويض شهرين عن كل سنة',
          score: 0.98,
          confidenceScore: 0.98,
          keywords: ['فصل تعسفي'],
          category: 'labor',
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: mockRemoteEvidence }),
      } as Response);

      const result = await retrieveLegalEvidence('فصل تعسفي');
      expect(fetchSpy).toHaveBeenCalled();
      expect(result.source).toBe('remote_rag');
      expect(result.evidence[0].article_number).toBe('المادة 122');
    });

    it('gracefully falls back to local search when remote RAG service is offline or errors', async () => {
      process.env.LEGAL_RAG_BASE_URL = 'http://localhost:9999';

      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('ECONNREFUSED: Connection refused')
      );

      const result = await retrieveLegalEvidence('فصل تعسفي');
      expect(result.source).toBe('local');
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence[0].article_number).toBeDefined();
    });
  });

  describe('Citation Verification (verifyCitations)', () => {
    const mockChunks: LegalChunk[] = [
      {
        id: 'chunk-art-122',
        article_number: 'المادة 122',
        law_name: 'قانون العمل الموحد رقم 12 لسنة 2003',
        title: 'التعويض عن الفصل التعسفي',
        text: 'يستحق العامل تعويضاً لا يقل عن أجر شهرين عن كل سنة خدمة...',
        summary: 'التعويض عن الفصل التعسفي شهرين عن كل سنة خدمة كحد أدنى',
        keywords: ['فصل تعسفي', 'تعويض'],
        category: 'labor',
        court: 'محكمة النقض العمالية',
      },
      {
        id: 'chunk-art-69',
        article_number: 'المادة 69',
        law_name: 'قانون العمل الموحد رقم 12 لسنة 2003',
        title: 'حالات فصل العامل لخطأ جسيم',
        text: 'لا يجوز فصل العامل إلا إذا ارتكب خطأ جسيماً...',
        summary: 'حالات الفصل لخطأ جسيم على سبيل الحصر',
        keywords: ['خطأ جسيم', 'فصل'],
        category: 'labor',
        court: 'محكمة النقض العمالية',
      },
      {
        id: 'chunk-art-534',
        article_number: 'المادة 534',
        law_name: 'قانون التجارة 17 لسنة 1999',
        title: 'عقوبة إصدار شيك بدون رصيد',
        text: 'يعاقب بالحبس وبغرامة كل من أصدر شيكاً ليس له مقابل وفاء...',
        summary: 'عقوبة الشيك بدون رصيد',
        keywords: ['شيك بدون رصيد'],
        category: 'commercial',
      },
    ];

    it('verifies valid citations and returns evidenceScore 1.0', () => {
      const aiResponse = `
        بناءً على نص المادة 122 من قانون العمل، يحق لك المطالبة بتعويض لا يقل عن أجر شهرين عن كل سنة خدمة.
        كما تنص المادة 69 على أنه لا يجوز الفصل إلا إذا ارتكب العامل خطأ جسيماً.
      `;

      const result = verifyCitations(aiResponse, mockChunks);
      expect(result.verified.length).toBe(2);
      expect(result.unverified.length).toBe(0);
      expect(result.evidenceScore).toBe(1.0);

      const verifiedArtNumbers = result.verified.map((c) => c.articleNumber);
      expect(verifiedArtNumbers).toContain('المادة 122');
      expect(verifiedArtNumbers).toContain('المادة 69');
    });

    it('flags hallucinated articles as unverified and computes proportional evidenceScore', () => {
      const aiResponse = `
        وفقاً للمادة 122 من قانون العمل، يحق للعامل التعويض.
        ومع ذلك، استناداً إلى المادة 999 من القانون، تسقط الدعوى بعد عام.
      `;

      const result = verifyCitations(aiResponse, mockChunks);
      expect(result.verified.length).toBe(1);
      expect(result.unverified).toContain('المادة 999');
      expect(result.evidenceScore).toBe(0.5);
    });

    it('returns evidenceScore 0.0 when all citations are hallucinated', () => {
      const aiResponse = `
        بموجب المادة 888 والمادة 999 من قانون العمل، يلزم تسليم شهادة الخبرة فوراً.
      `;

      const result = verifyCitations(aiResponse, mockChunks);
      expect(result.verified.length).toBe(0);
      expect(result.unverified.length).toBe(2);
      expect(result.evidenceScore).toBe(0.0);
    });

    it('returns empty lists and score 0.0 when response contains no statutory citations', () => {
      const aiResponse = `
        عقد العمل يلزم الطرفين بالالتزامات الواردة فيه، ويجب التوجه لمكتب العمل المختص لتقديم شكوى ودية.
      `;

      const result = verifyCitations(aiResponse, mockChunks);
      expect(result.verified.length).toBe(0);
      expect(result.unverified.length).toBe(0);
      expect(result.evidenceScore).toBe(0.0);
    });

    it('verifies citations written in Eastern Arabic numerals (١٢٢)', () => {
      const aiResponse = `
        تنص المادة ١٢٢ من قانون العمل على إلزام صاحب العمل بالتعويض.
      `;

      const result = verifyCitations(aiResponse, mockChunks);
      expect(result.verified.length).toBe(1);
      expect(result.verified[0].articleNumber).toBe('المادة 122');
      expect(result.evidenceScore).toBe(1.0);
    });

    it('deduplicates citations mentioned multiple times in the response', () => {
      const aiResponse = `
        أكدت المادة 122 على التعويض. وتنص المادة 122 أيضاً على الحد الأدنى لشهرين.
      `;

      const result = verifyCitations(aiResponse, mockChunks);
      expect(result.verified.length).toBe(1);
      expect(result.evidenceScore).toBe(1.0);
    });

    it('verifies commercial check citations (المادة 534)', () => {
      const aiResponse = `
        تخضع الواقعة لنص المادة 534 من قانون التجارة الخاصة بالشيك بدون رصيد.
      `;

      const result = verifyCitations(aiResponse, mockChunks);
      expect(result.verified.length).toBe(1);
      expect(result.verified[0].articleNumber).toBe('المادة 534');
      expect(result.evidenceScore).toBe(1.0);
    });
  });
});
