import type { MemoryItem, MemoryHit } from './store';

export interface MemoryRecallFilters {
  user_id?: string;
  lawyer_id?: string;
  case_id?: string;
  domain?: string;
  k?: number;
  includeT0?: boolean;
  minT0Score?: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Normalize Arabic and English text for robust lexical token matching.
 * Strips tashkeel (diacritics), unifies alefs, taa marbuta, and alef maksura,
 * and converts to lower case.
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    // Remove Arabic diacritics
    .replace(/[\u064B-\u0652\u0670]/g, '')
    // Remove Tatweel (kashida)
    .replace(/\u0640/g, '')
    // Normalize Alefs (إ, أ, آ, ٱ -> ا)
    .replace(/[إأآٱ]/g, 'ا')
    // Normalize Taa Marbuta (ة -> ه)
    .replace(/ة/g, 'ه')
    // Normalize Alef Maksura (ى -> ي)
    .replace(/ى/g, 'ي')
    // Replace non-word/non-alphanumeric chars with spaces
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Tokenize normalized text into unique words (length >= 2).
 */
export function tokenizeText(text: string): Set<string> {
  const normalized = normalizeText(text);
  if (!normalized) return new Set();
  const words = normalized.split(/\s+/).filter((w) => w.length >= 2);
  return new Set(words);
}

/**
 * Compute token overlap score between a query and a text string.
 * Returns a float between 0.0 and 1.0.
 */
export function computeTokenOverlap(query: string, content: string): number {
  if (!query || !content) return 0.0;

  const normalizedQuery = normalizeText(query);
  const normalizedContent = normalizeText(content);

  if (!normalizedQuery || !normalizedContent) return 0.0;

  // Exact full or phrase inclusion gets highest lexical score
  if (normalizedContent.includes(normalizedQuery)) {
    return 1.0;
  }

  const queryTokens = tokenizeText(query);
  const contentTokens = tokenizeText(content);

  if (queryTokens.size === 0 || contentTokens.size === 0) {
    return 0.0;
  }

  let intersectionCount = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      intersectionCount++;
    } else {
      // Substring check for Arabic prefix/suffix roots (e.g. للمحكمة -> محكمة)
      for (const cToken of contentTokens) {
        if (cToken.includes(token) || token.includes(cToken)) {
          intersectionCount += 0.8;
          break;
        }
      }
    }
  }

  const score = intersectionCount / queryTokens.size;
  return Math.min(1.0, Math.max(0.0, Number(score.toFixed(3))));
}

/**
 * Check if a memory item scope matches caller context filters.
 */
export function matchesScope(itemScope: string, filters?: MemoryRecallFilters): boolean {
  if (!itemScope || itemScope === 'global') {
    return true;
  }

  if (itemScope.startsWith('lawyer:')) {
    const targetLawyer = itemScope.slice('lawyer:'.length);
    return Boolean(filters?.lawyer_id && filters.lawyer_id === targetLawyer);
  }

  if (itemScope.startsWith('case:')) {
    const targetCase = itemScope.slice('case:'.length);
    return Boolean(filters?.case_id && filters.case_id === targetCase);
  }

  if (itemScope.startsWith('user:')) {
    const targetUser = itemScope.slice('user:'.length);
    return Boolean(filters?.user_id && filters.user_id === targetUser);
  }

  if (itemScope.startsWith('domain:')) {
    const targetDomain = itemScope.slice('domain:'.length);
    return Boolean(filters?.domain && filters.domain === targetDomain);
  }

  return true;
}

/**
 * Check if a memory item was created recently (default 30 days per spec L5.6).
 */
export function isRecent(item: MemoryItem, maxAgeMs = THIRTY_DAYS_MS): boolean {
  if (!item.created_at) return true;
  const createdTime = new Date(item.created_at).getTime();
  if (isNaN(createdTime)) return true;
  return Date.now() - createdTime <= maxAgeMs;
}

/**
 * Offline-first retrieval: Filter and rank memory items against query and context filters.
 */
export function rankAndFilterMemories(
  items: MemoryItem[],
  query: string,
  filters?: MemoryRecallFilters
): MemoryHit[] {
  const k = filters?.k || 5;
  const minT0Score = filters?.minT0Score ?? 0.0;
  const includeT0 = filters?.includeT0 ?? true;

  const hits: MemoryHit[] = [];

  for (const item of items) {
    if (!item.active) continue;

    // Check scope match
    if (!matchesScope(item.scope, filters)) {
      continue;
    }

    const overlapScore = query ? computeTokenOverlap(query, item.content) : 0.5;

    if (item.tier === 'T1') {
      // T1 (Instruction memory): Always eligible if scope matches; boosted score
      const score = query ? Math.max(0.7, overlapScore) : 0.9;
      hits.push({
        memory_id: item.id,
        tier: 'T1',
        content: item.content,
        score,
        source_trace_id: item.source_trace_id || null,
        confidence: item.confidence ?? 1.0,
        scope: item.scope,
      });
    } else if (item.tier === 'T2') {
      // T2 (Semantic preferences): eligible per lawyer scope
      const score = query ? Math.max(0.6, overlapScore) : 0.8;
      hits.push({
        memory_id: item.id,
        tier: 'T2',
        content: item.content,
        score,
        source_trace_id: item.source_trace_id || null,
        confidence: item.confidence ?? 1.0,
        scope: item.scope,
      });
    } else if (item.tier === 'T0' && includeT0) {
      // T0 (Episodic feedback): requires recency and lexical/similarity relevance
      if (!isRecent(item)) {
        continue;
      }

      // If query is provided, verify overlap meets threshold
      if (query && overlapScore < minT0Score) {
        continue;
      }

      hits.push({
        memory_id: item.id,
        tier: 'T0',
        content: item.content,
        score: overlapScore > 0 ? overlapScore : 0.5,
        source_trace_id: item.source_trace_id || null,
        confidence: item.confidence ?? 1.0,
        scope: item.scope,
      });
    }
  }

  // Sort descending by score, tiebreaker tier (T1 > T2 > T0)
  hits.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.001) {
      return b.score - a.score;
    }
    const tierOrder: Record<string, number> = { T1: 3, T2: 2, T0: 1 };
    return (tierOrder[b.tier] || 0) - (tierOrder[a.tier] || 0);
  });

  return hits.slice(0, k);
}
