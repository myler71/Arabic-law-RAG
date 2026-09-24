/**
 * Groq LLM-as-Judge Adapter (Spec L6.3, L6.5, L11)
 *
 * Implements strict, context-constrained automated evaluation of AI responses.
 * Mandatory constraints:
 * - Judge ONLY from retrieved context (forbid own external legal memory).
 * - Strict JSON {score: 0-1, rationale, flags[]}.
 * - Timeout 15s via AbortController; network fail / no key -> skipped (never throws).
 * - Online judge must never block user request path.
 * - Read key and model from env at call time; never hardcode or log API keys.
 */

export interface JudgeInputChunk {
  id?: string;
  article_number?: string;
  title?: string;
  text: string;
}

export interface JudgeRunInput {
  prompt: string;
  answer: string;
  retrievedChunks: JudgeInputChunk[];
  rubric: 'faithfulness' | 'completeness';
}

export interface JudgeRunResult {
  score: number;
  rationale: string;
  flags: string[];
  skipped?: boolean;
}

/**
 * Parses raw LLM judge response string into structured JudgeRunResult.
 * Handles markdown code fences (```json ... ```) and applies brace-rescue
 * for resilient JSON extraction. Returns null on unrecoverable syntax errors.
 */
export function parseJudgeJson(raw: string): { score: number; rationale: string; flags: string[] } | null {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();

  // Strip code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  } else if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  const validate = (parsed: unknown) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    let score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
    if (isNaN(score)) return null;
    score = Math.max(0, Math.min(1, score));
    const rationale = typeof obj.rationale === 'string' ? obj.rationale : String(obj.rationale ?? '');
    const flags = Array.isArray(obj.flags) ? obj.flags.map((f) => String(f)) : [];
    return { score, rationale, flags };
  };

  try {
    const parsed = JSON.parse(text);
    const validated = validate(parsed);
    if (validated) return validated;
  } catch {
    // Proceed to brace rescue
  }

  // Brace-rescue: find the outermost { ... }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const sliced = text.slice(start, end + 1);
      const parsed = JSON.parse(sliced);
      const validated = validate(parsed);
      if (validated) return validated;
    } catch {
      return null;
    }
  }

  return null;
}

function buildSystemPrompt(rubric: 'faithfulness' | 'completeness'): string {
  const rubricInstruction =
    rubric === 'faithfulness'
      ? `Rubric: FAITHFULNESS
Assess whether all factual and legal claims, cited article numbers, and legal consequences in the Answer are supported by the Retrieved Context.
- score = 1.0: All assertions and citations in the Answer are strictly grounded in and verifiable from the Retrieved Context.
- score < 1.0: Deduct points for any ungrounded assertions, fabricated article numbers, or claims not found in the context.
- score = 0.0: The Answer contradicts the context or makes substantial legal claims with no basis in the context.
Possible flags: "unsupported_citation", "extrapolated_fact", "hallucination", "contradiction".`
      : `Rubric: COMPLETENESS
Assess whether the Answer sufficiently and completely addresses the user's legal Prompt using the available information in the Retrieved Context.
- score = 1.0: The Answer fully and accurately resolves the core legal question using all relevant information from the Retrieved Context.
- score < 1.0: Deduct points if key parts of the user question were ignored despite relevant information being available in the context.
- score = 0.0: The Answer completely fails to address the user question.
Possible flags: "missing_key_element", "superficial_response", "partial_coverage".`;

  return `You are an objective legal evaluation judge for Egyptian legal AI responses.
CRITICAL CONSTRAINTS:
1. Judge ONLY and STRICTLY based on the provided Retrieved Context chunks.
2. You are FORBIDDEN from using your own external legal knowledge, pre-training legal memory, or outside assumptions. If a statute, article, or rule is not explicitly present in the provided context, it must be considered unsupported by the context.
3. You must output STRICT, VALID JSON ONLY. No preamble, no markdown formatting outside of JSON, no explanatory notes.

Expected Output Schema:
{
  "score": <number between 0.0 and 1.0>,
  "rationale": "<concise factual explanation in English or Arabic>",
  "flags": ["<string flag>", ...]
}

${rubricInstruction}`;
}

function buildUserPrompt(
  prompt: string,
  answer: string,
  retrievedChunks: JudgeInputChunk[]
): string {
  const contextText =
    retrievedChunks.length > 0
      ? retrievedChunks
          .map((c, i) => {
            const art = c.article_number ? ` - Article ${c.article_number}` : '';
            const tit = c.title ? ` - ${c.title}` : '';
            return `[Chunk ${i + 1}${art}${tit}]\n${c.text}`;
          })
          .join('\n\n')
      : 'No context provided.';

  return `[PROMPT]
${prompt}

[RETRIEVED CONTEXT]
${contextText}

[ANSWER]
${answer}

Evaluate the Answer against the Retrieved Context according to the rubric. Output strict JSON.`;
}

/**
 * Evaluates a generated answer against retrieved context using Groq LLM-as-judge.
 * If GROQ_API_KEY is not configured, or if any network/parse failure occurs, returns
 * { skipped: true, score: 0, ... } and NEVER throws.
 */
export async function judgeRun(input: JudgeRunInput): Promise<JudgeRunResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return {
      score: 0,
      rationale: 'GROQ_API_KEY unset',
      flags: [],
      skipped: true,
    };
  }

  const model = process.env.LLM_JUDGE_MODEL || 'qwen/qwen3.8-27b';
  const baseUrl = (process.env.GROQ_API_BASE || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');

  const systemPrompt = buildSystemPrompt(input.rubric);
  const userPrompt = buildUserPrompt(input.prompt, input.answer, input.retrievedChunks || []);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 15000);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        score: 0,
        rationale: `judge_http_${res.status}`,
        flags: [],
        skipped: true,
      };
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const rawContent = json?.choices?.[0]?.message?.content;
    if (!rawContent || typeof rawContent !== 'string') {
      return {
        score: 0,
        rationale: 'judge_parse_error',
        flags: [],
        skipped: true,
      };
    }

    const parsed = parseJudgeJson(rawContent);
    if (!parsed) {
      return {
        score: 0,
        rationale: 'judge_parse_error',
        flags: [],
        skipped: true,
      };
    }

    return {
      score: parsed.score,
      rationale: parsed.rationale,
      flags: parsed.flags,
      skipped: false,
    };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
    return {
      score: 0,
      rationale: isAbort ? 'judge_timeout' : (err instanceof Error ? err.message : 'judge_network_error'),
      flags: [],
      skipped: true,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
