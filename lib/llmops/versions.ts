import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LlmOpsVersions {
  app_git_sha: string;
  prompt_version: string;
  model_id: string;
  embed_model_id: string;
  rerank_model_id: string;
  rag_index_version: string;
  guard_version: string;
  graph_version: string;
  eval_suite_version: string;
}

let cachedGitSha: string | null = null;

function resolveGitSha(): string {
  if (cachedGitSha) {
    return cachedGitSha;
  }

  const envSha =
    process.env.APP_GIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_SHA;

  if (envSha) {
    cachedGitSha = envSha.slice(0, 7);
    return cachedGitSha;
  }

  try {
    const stdout = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    cachedGitSha = stdout.trim() || 'ea46529';
    return cachedGitSha;
  } catch {
    cachedGitSha = 'ea46529';
    return cachedGitSha;
  }
}

function deriveCorpusVersion(): string {
  try {
    const corpusPath = path.resolve(process.cwd(), 'lib/ai/knowledge/egyptian-labor-law.json');
    if (fs.existsSync(corpusPath)) {
      const stats = fs.statSync(corpusPath);
      const hash = createHash('sha256').update(String(stats.mtimeMs)).digest('hex').slice(0, 6);
      return `statutes-eg-labor-2026.03.1-${hash}`;
    }
  } catch {
    // fallback to static spec version
  }
  return 'statutes-eg-labor-2026.03.1';
}

/**
 * Resolve current version manifest across all versioned AI artifacts.
 * Reads environment variables when present with spec-compliant dev fallbacks.
 */
export function resolveVersions(overrides?: Partial<LlmOpsVersions>): LlmOpsVersions {
  const base: LlmOpsVersions = {
    app_git_sha: process.env.APP_GIT_SHA || resolveGitSha(),
    prompt_version: process.env.LLMOPS_PROMPT_VERSION || process.env.PROMPT_VERSION || 'synth_chat@1.4.1',
    model_id: process.env.LLMOPS_MODEL_ID || process.env.LLM_MODEL_ID || 'groq/compound-mini',
    embed_model_id: process.env.LLMOPS_EMBED_MODEL_ID || process.env.EMBED_MODEL_ID || 'BAAI/bge-m3@rev',
    rerank_model_id: process.env.LLMOPS_RERANK_MODEL_ID || process.env.RERANK_MODEL_ID || 'BAAI/bge-reranker-v2-m3',
    rag_index_version: process.env.LLMOPS_RAG_INDEX_VERSION || process.env.RAG_INDEX_VERSION || deriveCorpusVersion(),
    guard_version: process.env.LLMOPS_GUARD_VERSION || process.env.GUARD_VERSION || 'legal_guard@2.1.0',
    graph_version: process.env.LLMOPS_GRAPH_VERSION || process.env.GRAPH_VERSION || 'legal_graph@1.0.3',
    eval_suite_version: process.env.LLMOPS_EVAL_SUITE_VERSION || process.env.EVAL_SUITE_VERSION || 'eval-smoke@12',
  };

  if (!overrides) {
    return base;
  }

  return {
    ...base,
    ...overrides,
  };
}
