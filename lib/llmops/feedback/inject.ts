import { langMemStore, LangMemStore, type MemoryHit } from './langmem/store';
import { llmopsLogger } from '../logging/logger';
import { LLMOPS_EVENTS } from '../logging/events';

export const T0_SIMILARITY_THRESHOLD = 0.5;
export const MEMORY_HINTS_HEADER =
  '### MEMORY HINTS (non-authoritative; do not invent articles from these)';

export interface RecallMemoryHintsParams {
  query: string;
  user_id?: string;
  lawyer_id?: string;
  case_id?: string;
  domain?: string;
  k?: number;
  corpus_top_score?: number;
  store?: LangMemStore;
}

/**
 * Redact-style sanitizer that strips fabricated or cited article numbers
 * (e.g. المادة 122, مادة 15, المادة رقم 4, etc.) from hint text.
 * Spec L5.6: Memory hints must NEVER authorize or invent new article numbers.
 */
export function stripArticleNumbers(text: string): string {
  if (!text) return '';
  // Match المادة or مادة followed optionally by رقم/فقرة and digits (Arabic or Western)
  return text.replace(
    /(?:\u0627\u0644\u0645\u0627\u062f\u0629|\u0645\u0627\u062f\u0629)(?:\s+(?:رقم|فقرة))?\s*[\d\u0660-\u0669]+(?:\s*(?:مكرر|فقرة\s*[\d\u0660-\u0669]+))?/gu,
    '[REDACTED:ARTICLE_REF]'
  );
}

/**
 * Sanitize memory content for injection into LLM prompts.
 */
export function sanitizeMemoryContent(content: string): string {
  return stripArticleNumbers(content);
}

/**
 * Recall memory hints applying Spec L5.6 policy:
 * 1. T1 (Instruction memory): always injected if active and scope matches.
 * 2. T2 (Semantic preferences): injected per lawyer scope.
 * 3. T0 (Episodic feedback): only if similarity high (>= 0.5), recent (30d),
 *    and NOT contradicted (drop if corpus retrieval score >= 0.85 and T0 confidence < corpus score).
 *
 * Emits ai.memory.inject structured log.
 */
export async function recallMemoryHints(
  params: RecallMemoryHintsParams
): Promise<MemoryHit[]> {
  const {
    query,
    user_id,
    lawyer_id,
    case_id,
    domain,
    k = 5,
    corpus_top_score,
    store = langMemStore,
  } = params;

  // Retrieve candidates from LangMem store
  const candidates = await store.recall(query, {
    user_id,
    lawyer_id,
    case_id,
    domain,
    k: k * 3,
    minT0Score: T0_SIMILARITY_THRESHOLD,
  });

  const finalHits: MemoryHit[] = [];

  for (const hit of candidates) {
    if (hit.tier === 'T1') {
      // T1 always allowed if active and scope matches
      finalHits.push(hit);
    } else if (hit.tier === 'T2') {
      // T2 allowed per lawyer scope or global
      if (!lawyer_id || hit.scope === 'global' || hit.scope === `lawyer:${lawyer_id}`) {
        finalHits.push(hit);
      }
    } else if (hit.tier === 'T0') {
      // T0 policy: similarity >= 0.5
      if (hit.score < T0_SIMILARITY_THRESHOLD) {
        continue;
      }

      // Contradiction heuristic: if corpus retrieval top score >= 0.85 and
      // T0 memory confidence < corpus score, drop T0 memory
      if (
        corpus_top_score !== undefined &&
        corpus_top_score >= 0.85 &&
        hit.confidence < corpus_top_score
      ) {
        continue;
      }

      finalHits.push(hit);
    }
  }

  const selectedHits = finalHits.slice(0, k);

  // Emit structured log for memory injection
  llmopsLogger.info(LLMOPS_EVENTS.MEMORY_INJECT, {
    injected_count: selectedHits.length,
    memory_ids: selectedHits.map((h) => h.memory_id),
    tiers: selectedHits.map((h) => h.tier),
    query_preview: query ? query.slice(0, 80) : '',
    corpus_top_score: corpus_top_score ?? null,
  });

  return selectedHits;
}

/**
 * Format recalled memory hits into a prompt context block.
 * Strips all article numbers from content before rendering.
 * Spec L5.6: Labeled section '### MEMORY HINTS (non-authoritative; do not invent articles from these)'
 */
export function buildMemoryPromptBlock(hits: MemoryHit[]): string {
  if (!hits || hits.length === 0) {
    return '';
  }

  const lines = hits.map((hit) => {
    const sanitized = sanitizeMemoryContent(hit.content);
    return `- [${hit.tier}] (${hit.scope}): ${sanitized}`;
  });

  return `${MEMORY_HINTS_HEADER}\n${lines.join('\n')}`;
}
