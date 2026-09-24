import fs from 'fs';
import path from 'path';
import { EGYPTIAN_COMPREHENSIVE_LEGAL_DATABASE } from '../data/legalData';
import type { LegalCategory } from '../types';

export interface LegalCitation {
  id: string;
  title: string;
  lawName: string;
  court?: string;
  articleNumber: string;
  year?: string;
  summary: string;
  fullText?: string;
  category?: LegalCategory | string;
  relevanceScore?: number;
  sourceUrl?: string;
}

export interface LegalChunk {
  id: string;
  article_number: string;
  law_name: string;
  law_number?: number | string;
  law_year?: number | string;
  title: string;
  text: string;
  summary: string;
  score?: number;
  confidenceScore?: number;
  book?: string;
  chapter?: string;
  category?: string;
  court?: string;
  keywords: string[];
  metadata?: Record<string, unknown>;
}

export interface RetrievalQuery {
  query: string;
  topK?: number;
  domain?: string;
  category?: string;
  minScore?: number;
}

export interface RetrievalResult {
  query: string;
  evidence: LegalChunk[];
  source: 'local' | 'remote_rag';
  totalFound: number;
  executionTimeMs?: number;
}

interface RemoteSearchResultItem {
  id?: string;
  article_number?: string;
  article?: string;
  article_num?: string | number;
  law_name?: string;
  law?: string;
  title?: string;
  text?: string;
  content?: string;
  summary?: string;
  score?: number;
  confidenceScore?: number;
  keywords?: string[];
  category?: string;
  court?: string;
}

interface RemoteSearchResponse {
  results?: RemoteSearchResultItem[];
  evidence?: RemoteSearchResultItem[];
}

/**
 * Normalizes Eastern Arabic numerals (٠-٩) to standard Western digits (0-9).
 */
export function normalizeArabicNumbers(text: string): string {
  if (!text) return '';
  const easternDigits: Record<string, string> = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  };
  return text.replace(/[٠-٩]/g, (ch) => easternDigits[ch] || ch);
}

/**
 * Normalizes Arabic text for high-recall legal retrieval:
 * - Strips diacritics / tashkeel
 * - Removes tatweel (kashida)
 * - Unifies Alef variations (إ, أ, آ, ٱ -> ا)
 * - Unifies Yeh variations (ى -> ي)
 * - Unifies Teh Marbuta (ة -> ه)
 * - Standardizes Hamza variations (ؤ -> و, ئ -> ي)
 * - Converts Eastern Arabic digits
 */
export function normalizeArabic(text: string): string {
  if (!text) return '';
  return normalizeArabicNumbers(text)
    .replace(/[\u064B-\u065F\u0670]/g, '') // Remove tashkeel
    .replace(/\u0640/g, '') // Remove tatweel
    .replace(/[إأآٱ]/g, 'ا') // Unify Alef
    .replace(/ى/g, 'ي') // Unify Yeh
    .replace(/ة/g, 'ه') // Unify Teh Marbuta
    .replace(/ؤ/g, 'و') // Unify Waw with Hamza
    .replace(/ئ/g, 'ي') // Unify Yeh with Hamza
    .replace(/[^\w\s\u0600-\u06FF]/g, ' ') // Strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const ARABIC_LEGAL_STOPWORDS: Record<string, true> = {
  'في': true, 'من': true, 'على': true, 'الي': true, 'إلي': true, 'عن': true, 'مع': true,
  'هذا': true, 'هذه': true, 'ذلك': true, 'تلك': true, 'ان': true, 'أن': true, 'هو': true,
  'هي': true, 'هم': true, 'كان': true, 'كانت': true, 'يكون': true, 'التي': true, 'الذي': true,
  'الذين': true, 'ما': true, 'لا': true, 'لم': true, 'لن': true, 'او': true, 'أو': true,
  'ثم': true, 'حيث': true, 'كل': true, 'وقد': true, 'قد': true, 'بين': true, 'فان': true,
  'فقد': true, 'كما': true, 'اي': true, 'أي': true, 'عند': true, 'اذا': true, 'إذا': true,
  'له': true, 'لها': true, 'بها': true, 'فيه': true, 'فيها': true, 'منه': true, 'منها': true,
  'عنه': true, 'عنها': true, 'به': true, 'بهم': true, 'عليهم': true, 'غير': true
};

/**
 * Tokenizes Arabic text and extracts keywords, including both definite (الـ)
 * and indefinite root forms for superior Arabic IR recall.
 */
export function tokenizeArabic(text: string): string[] {
  const normalized = normalizeArabic(text);
  const words = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !ARABIC_LEGAL_STOPWORDS[token]);

  const uniqueTokens: Record<string, true> = {};
  for (const w of words) {
    uniqueTokens[w] = true;
    // Strip definite article 'ال' for light stemming if word length > 3
    if (w.startsWith('ال') && w.length > 3) {
      const stripped = w.slice(2);
      if (stripped.length >= 2 && !ARABIC_LEGAL_STOPWORDS[stripped]) {
        uniqueTokens[stripped] = true;
      }
    }
  }

  return Object.keys(uniqueTokens);
}

export const COLLOQUIAL_LEGAL_SYNONYMS: Record<string, string[]> = {
  // Unfair dismissal & termination
  'فصل تعسفي': ['فصل تعسفي', 'طرد', 'طرد من العمل', 'رفد', 'تسريح', 'انهاء تعسفي', 'انهاء غير مشروع', 'تعويض عمالي', 'شهرين', '122', '69'],
  'طرد': ['فصل تعسفي', 'طرد من العمل', 'انهاء غير مشروع', 'تعويض عمالي', '122', '69'],
  'رفد': ['فصل تعسفي', 'طرد من العمل', 'تعويض عمالي', '122'],
  'تسريح': ['فصل تعسفي', 'انهاء خدمة', 'تقليص العمالة', '122', '69'],
  'خطأ جسيم': ['فصل العامل', 'خطا جسيم', '69', 'انتحال', 'تزوير', 'افشاء اسرار', 'سكر', 'مخدرات', 'اعتداء'],

  // Commercial & bounced checks
  'شيك بدون رصيد': ['شيك بدون رصيد', 'شيك', 'رصيد', 'رفض بنكي', 'شيكات', 'ايصال امانة', 'امر اداء', '534', '341', 'كمبيالة', 'بروتستو'],
  'شيك': ['شيك بدون رصيد', 'اوراق تجارية', 'شيك مصرفي', '534', 'بنك', 'رصيد'],
  'ايصال امانة': ['ايصال امانة', 'خيانة امانة', 'وصل امانة', 'تبديد', '341', 'وديعة'],

  // Notice periods & contract termination
  'مهلة الإخطار': ['مهله الاخطار', 'اخطار', 'مهلة', 'انذار بالانهاء', 'بدل اخطار', '110', '111', '112', '116', 'شهران', 'ثلاثة اشهر'],
  'مهلة اخطار': ['مهله الاخطار', 'اخطار', 'انذار بالانهاء', '110', '111', '116'],
  'اخطار': ['مهله الاخطار', 'انذار بالانهاء', '110', '111', '116'],
  'انهاء العقد': ['انهاء العقد', 'عقد غير محدد المدة', 'فسخ العقد', '110', '111', '122'],

  // End of service & retirement
  'مكافأة نهاية الخدمة': ['مكافاه نهايه الخدمه', 'نهاية الخدمة', 'مكافأة', 'سن التقاعد', 'سن الستين', 'معاش', '126', '127', 'نصف شهر'],
  'سن التقاعد': ['سن الستين', 'المعاش', 'مكافأة نهاية الخدمة', '126', '127'],

  // Probation
  'فترة الاختبار': ['فترة الاختبار', 'فترة تجربة', 'بروبيشن', 'probation', 'ثلاثة أشهر', '31'],
  'فترة التجربة': ['فترة الاختبار', 'فترة تجربة', '31'],

  // Leaves
  'إجازات': ['اجازة سنوية', 'اجازات', 'عارضة', 'مرضية', 'رسمية', 'حج', 'رصيد اجازات', '47', '48', '51', '52', '53', '54'],
  'إجازة سنوية': ['اجازة سنوية', '21 يوم', '30 يوم', 'رصيد اجازات', '47', '48'],
  'إجازة مرضية': ['اجازة مرضية', 'تأمين صحي', '54'],

  // Wages & minimum wage
  'الحد الأدنى للأجور': ['الحد الادنى للاجور', 'المجلس القومي للاجور', 'علاوة دورية', 'اجر', '34', '35'],
  'تأخير الراتب': ['تاخير المرتب', 'اجور', 'قبض', 'موعد اداء الاجر', '38'],

  // Investigation & disciplinary
  'تحقيق عمالي': ['تحقيق', 'تأديب', 'جزاءات', 'خصم', 'وقف عن العمل', '68', '70', '71', '72', '73'],
  'جزاءات': ['لائحة الجزاءات', 'خصم من الراتب', 'انذار', 'وقف', '68', '73'],
};

interface LaborLawJsonItem {
  id: string;
  law_number?: number;
  law_year?: number;
  law_title?: string;
  book?: string;
  chapter?: string;
  article_number: number | string;
  title: string;
  text: string;
  keywords?: string[];
}

let cachedKnowledgeBase: LegalChunk[] | null = null;

/**
 * Loads Egyptian Labor Law knowledge base JSON and Egyptian Comprehensive Legal Database
 */
export function loadLegalKnowledgeBase(): LegalChunk[] {
  if (cachedKnowledgeBase) {
    return cachedKnowledgeBase;
  }

  const chunks: LegalChunk[] = [];
  const seenIds = new Set<string>();

  // 1. Load lib/ai/knowledge/egyptian-labor-law.json
  const possibleJsonPaths = [
    path.join(process.cwd(), 'lib/ai/knowledge/egyptian-labor-law.json'),
    path.join(__dirname, 'knowledge/egyptian-labor-law.json'),
    path.join(__dirname, '../../lib/ai/knowledge/egyptian-labor-law.json'),
    'C:/Users/Myler/Downloads/1 PROJECTS/hakimdar/HAKMDAR/lib/ai/knowledge/egyptian-labor-law.json',
    'C:/Users/Myler/Downloads/1 PROJECTS/HAKMDAR/lib/ai/knowledge/egyptian-labor-law.json',
  ];

  for (const jsonPath of possibleJsonPaths) {
    try {
      if (fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const articles = JSON.parse(raw) as unknown;
        if (Array.isArray(articles) && articles.length > 0) {
          for (const rawItem of articles) {
            const item = rawItem as LaborLawJsonItem;
            if (item && item.id && !seenIds.has(item.id)) {
              seenIds.add(item.id);
              const artNumStr = String(item.article_number ?? '');
              chunks.push({
                id: item.id,
                article_number: artNumStr.startsWith('المادة') ? artNumStr : `المادة ${artNumStr}`,
                law_name: `${item.law_title || 'قانون العمل الموحد'} رقم ${item.law_number || 12} لسنة ${item.law_year || 2003}`,
                law_number: item.law_number || 12,
                law_year: item.law_year || 2003,
                title: item.title,
                text: item.text,
                summary: `${item.title}: ${item.text.slice(0, 160)}...`,
                book: item.book,
                chapter: item.chapter,
                category: 'labor',
                court: 'محكمة النقض العمالية / المحكمة العمالية',
                keywords: Array.isArray(item.keywords) ? item.keywords : [],
              });
            }
          }
          break; // Successfully loaded JSON
        }
      }
    } catch {
      // Continue to next candidate path
    }
  }

  // 2. Load EGYPTIAN_COMPREHENSIVE_LEGAL_DATABASE
  if (Array.isArray(EGYPTIAN_COMPREHENSIVE_LEGAL_DATABASE)) {
    for (const entry of EGYPTIAN_COMPREHENSIVE_LEGAL_DATABASE) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        const citation = entry.citations?.[0];
        chunks.push({
          id: entry.id,
          article_number: citation?.articleNumber || entry.articles || entry.title,
          law_name: citation?.lawName || entry.codeName,
          title: entry.title,
          text: `${entry.officialText}\n\n${entry.legalAnalysis}`,
          summary: citation?.summary || entry.title,
          category: entry.category,
          court: entry.court || citation?.court || 'محكمة النقض',
          keywords: Array.from(new Set([...(entry.keywords || []), entry.title, entry.subCategory || ''])),
        });
      }
    }
  }

  cachedKnowledgeBase = chunks;
  return chunks;
}

/**
 * Resets cached knowledge base (useful for testing or hot reloading).
 */
export function resetKnowledgeBaseCache(): void {
  cachedKnowledgeBase = null;
}

/**
 * Local hybrid retrieval scoring chunks using:
 * - BM25 term overlap
 * - Colloquial synonym expansion
 * - Exact keyword and phrase boosts
 * - Exact article number match boosts
 */
export function searchLocalKnowledge(
  query: string,
  chunks: LegalChunk[],
  options?: { topK?: number; domain?: string }
): LegalChunk[] {
  const topK = options?.topK ?? 5;
  const domain = options?.domain;
  const normQuery = normalizeArabic(query);
  const queryTokens = tokenizeArabic(query);

  // Extract explicit article numbers mentioned in query (e.g. 122, 69, 534)
  const queryArticleNumbers = new Set(
    (normalizeArabicNumbers(query).match(/\b\d+\b/g) || [])
  );

  // Identify colloquial synonym triggers
  const expandedSynonyms: string[] = [];
  for (const [trigger, synonyms] of Object.entries(COLLOQUIAL_LEGAL_SYNONYMS)) {
    const normTrigger = normalizeArabic(trigger);
    if (normQuery.includes(normTrigger) || normTrigger.includes(normQuery)) {
      expandedSynonyms.push(...synonyms);
    }
  }

  // Precompute document statistics for BM25
  const docTokensMap = new Map<string, string[]>();
  const docNormTextMap = new Map<string, string>();
  let totalDocLength = 0;

  for (const chunk of chunks) {
    const combinedText = `${chunk.title} ${chunk.text} ${chunk.summary} ${chunk.article_number} ${(chunk.keywords || []).join(' ')}`;
    const normDoc = normalizeArabic(combinedText);
    const tokens = tokenizeArabic(combinedText);
    docTokensMap.set(chunk.id, tokens);
    docNormTextMap.set(chunk.id, normDoc);
    totalDocLength += tokens.length;
  }

  const N = chunks.length;
  const avgDL = totalDocLength / (N || 1);
  const k1 = 1.5;
  const b = 0.75;

  // Calculate Document Frequency (DF) for each query token
  const dfMap = new Map<string, number>();
  for (const token of queryTokens) {
    let df = 0;
    for (const chunk of chunks) {
      const tokens = docTokensMap.get(chunk.id) || [];
      if (tokens.includes(token)) {
        df++;
      }
    }
    dfMap.set(token, df);
  }

  // Score each chunk
  const scoredChunks: Array<{ chunk: LegalChunk; score: number }> = [];

  for (const chunk of chunks) {
    // Domain filtering if requested
    if (domain && chunk.category && chunk.category !== domain) {
      continue;
    }

    const docTokens = docTokensMap.get(chunk.id) || [];
    const docNormText = docNormTextMap.get(chunk.id) || '';
    const docLen = docTokens.length;

    // 1. BM25 term overlap
    let bm25Score = 0;
    const termCounts = new Map<string, number>();
    for (const t of docTokens) {
      termCounts.set(t, (termCounts.get(t) || 0) + 1);
    }

    for (const token of queryTokens) {
      const tf = termCounts.get(token) || 0;
      if (tf > 0) {
        const df = dfMap.get(token) || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgDL));
        bm25Score += Math.max(0, idf) * (numerator / denominator);
      }
    }

    let boost = 0;

    // 2. Exact phrase match boost
    if (normQuery.length > 3 && docNormText.includes(normQuery)) {
      boost += 8.0;
    }

    // 3. Exact Article number match boost (+15.0)
    for (const num of queryArticleNumbers) {
      const normArt = normalizeArabic(chunk.article_number);
      const normTitle = normalizeArabic(chunk.title);
      if (
        normArt.includes(num) ||
        normTitle.includes(`ماده ${num}`) ||
        normTitle.includes(`الماده ${num}`) ||
        normTitle.includes(` ${num} `) ||
        chunk.id.includes(`-${num}`)
      ) {
        boost += 15.0;
      }
    }

    // 4. Keyword exact overlap boost
    for (const kw of chunk.keywords || []) {
      const normKw = normalizeArabic(kw);
      if (normQuery.includes(normKw) || normKw.includes(normQuery)) {
        boost += 5.0;
      }
    }

    // 5. Colloquial synonyms match boost
    for (const syn of expandedSynonyms) {
      const normSyn = normalizeArabic(syn);
      if (docNormText.includes(normSyn) || (chunk.keywords || []).some(k => normalizeArabic(k).includes(normSyn))) {
        boost += 3.0;
      }
    }

    const rawScore = bm25Score + boost;
    if (rawScore > 0) {
      // Normalize confidence score to [0.0, 0.99]
      const confidenceScore = Math.min(0.99, Number((rawScore / (rawScore + 5.0)).toFixed(3)));
      scoredChunks.push({
        chunk: {
          ...chunk,
          score: Number(rawScore.toFixed(3)),
          confidenceScore,
        },
        score: rawScore,
      });
    }
  }

  // Sort descending by score
  scoredChunks.sort((a, b) => b.score - a.score);

  return scoredChunks.slice(0, topK).map((s) => s.chunk);
}

/**
 * Retrieves legal evidence for a given query:
 * - If process.env.LEGAL_RAG_BASE_URL is set and reachable, queries the internal Python RAG service (/api/search).
 * - If not configured or offline, falls back 100% to local hybrid search.
 */
export async function retrieveLegalEvidence(
  query: string,
  options?: { topK?: number; domain?: string }
): Promise<RetrievalResult> {
  const startTime = Date.now();
  const topK = options?.topK ?? 5;

  // 1. Try remote Python RAG service if configured
  if (process.env.LEGAL_RAG_BASE_URL) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500); // 1.5s timeout
      const baseUrl = process.env.LEGAL_RAG_BASE_URL.replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          top_k: topK,
          domain: options?.domain,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const rawData = (await response.json()) as unknown;
        const searchResponse = rawData as RemoteSearchResponse;
        const results = Array.isArray(rawData)
          ? (rawData as RemoteSearchResultItem[])
          : searchResponse.results || searchResponse.evidence || [];

        if (Array.isArray(results) && results.length > 0) {
          const evidence: LegalChunk[] = results.map((item, idx) => ({
            id: item.id || `remote-chunk-${idx}`,
            article_number: item.article_number || item.article || `المادة ${item.article_num ?? ''}`,
            law_name: item.law_name || item.law || 'قانون مصري',
            title: item.title || item.article_number || 'نص قانوني',
            text: item.text || item.content || '',
            summary: item.summary || (item.text ? `${item.text.slice(0, 150)}...` : ''),
            score: typeof item.score === 'number' ? item.score : 1.0,
            confidenceScore: typeof item.confidenceScore === 'number' ? item.confidenceScore : 0.95,
            keywords: Array.isArray(item.keywords) ? item.keywords : [],
            category: item.category || options?.domain,
            court: item.court,
          }));

          return {
            query,
            evidence,
            source: 'remote_rag',
            totalFound: evidence.length,
            executionTimeMs: Date.now() - startTime,
          };
        }
      }
    } catch {
      // Remote service failed or offline: fall back to local search
    }
  }

  // 2. Offline-first local hybrid search
  const knowledgeBase = loadLegalKnowledgeBase();
  const evidence = searchLocalKnowledge(query, knowledgeBase, options);

  return {
    query,
    evidence,
    source: 'local',
    totalFound: evidence.length,
    executionTimeMs: Date.now() - startTime,
  };
}

/**
 * Verifies citations in generated AI legal response against retrieved evidence chunks:
 * - Detects article citations (e.g. المادة 122, م 69, المادتين 69 و 122)
 * - Verifies against retrieved chunks
 * - Computes evidenceScore = verified / totalCitations
 */
export function verifyCitations(
  generatedText: string,
  retrievedChunks: LegalChunk[]
): {
  verified: LegalCitation[];
  unverified: string[];
  evidenceScore: number;
} {
  if (!generatedText || typeof generatedText !== 'string') {
    return { verified: [], unverified: [], evidenceScore: 0 };
  }

  const normGenerated = normalizeArabicNumbers(generatedText);

  // Regex patterns to capture article citations in Arabic legal text
  const articleRegex = /(?:المادتين|المادتان|المواد|المادة|مادة|م\/|(?<=\s|^)م\s*)\s*(\d+)/gu;

  const citedNumbers = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = articleRegex.exec(normGenerated)) !== null) {
    if (match[1]) {
      citedNumbers.add(match[1]);
    }
  }

  // Also check dual mentions like "المادتان 69 و 122"
  const dualRegex = /(?:المادتين|المادتان)\s*(\d+)\s*و\s*(\d+)/gu;
  while ((match = dualRegex.exec(normGenerated)) !== null) {
    if (match[1]) citedNumbers.add(match[1]);
    if (match[2]) citedNumbers.add(match[2]);
  }

  const verified: LegalCitation[] = [];
  const unverified: string[] = [];
  const verifiedChunkIds = new Set<string>();

  for (const num of citedNumbers) {
    // Find matching chunk in retrievedChunks
    const matchingChunk = retrievedChunks.find((chunk) => {
      const chunkArtNorm = normalizeArabicNumbers(chunk.article_number || '');
      const chunkTitleNorm = normalizeArabicNumbers(chunk.title || '');
      const chunkId = chunk.id || '';

      // Match in article_number digits
      const artNumbersInChunk: string[] = chunkArtNorm.match(/\b\d+\b/g) || [];
      if (artNumbersInChunk.includes(num)) return true;

      // Match in title
      if (
        chunkTitleNorm.includes(`المادة ${num}`) ||
        chunkTitleNorm.includes(`مادة ${num}`) ||
        chunkTitleNorm.includes(` ${num} `)
      ) {
        return true;
      }

      // Match in id
      if (chunkId.endsWith(`-${num}`) || chunkId.includes(`-art-${num}`)) {
        return true;
      }

      return false;
    });

    if (matchingChunk) {
      if (!verifiedChunkIds.has(matchingChunk.id)) {
        verifiedChunkIds.add(matchingChunk.id);
        verified.push({
          id: `cit-${matchingChunk.id}`,
          title: matchingChunk.title,
          lawName: matchingChunk.law_name,
          court: matchingChunk.court || 'المحاكم العمالية / محكمة النقض',
          articleNumber: matchingChunk.article_number,
          summary: matchingChunk.summary || matchingChunk.title,
          fullText: matchingChunk.text,
          category: matchingChunk.category || 'labor',
          relevanceScore: matchingChunk.confidenceScore || matchingChunk.score || 1.0,
        });
      }
    } else {
      unverified.push(`المادة ${num}`);
    }
  }

  const totalCitations = verified.length + unverified.length;
  const evidenceScore = totalCitations > 0
    ? Number((verified.length / totalCitations).toFixed(2))
    : 0;

  return {
    verified,
    unverified,
    evidenceScore,
  };
}
