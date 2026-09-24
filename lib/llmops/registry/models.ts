/**
 * Model Routing Registry (Spec L2 & active Groq catalog)
 * Maps functional AI roles to validated model endpoints and fallback providers.
 */

export type ModelRole =
  | 'classify_guard'
  | 'synthesize_chat'
  | 'synthesize_case'
  | 'judge_eval'
  | 'voice_tts';

export interface ModelEndpointConfig {
  provider: 'groq' | 'ollama' | 'karnak' | (string & {});
  model: string;
  temp?: number;
}

export interface ModelRouteConfig {
  primary: ModelEndpointConfig;
  fallback?: ModelEndpointConfig;
}

export const MODEL_ROUTING_TABLE: Record<ModelRole, ModelRouteConfig> = {
  classify_guard: {
    primary: { provider: 'groq', model: 'qwen/qwen3.8-27b', temp: 0 },
    fallback: { provider: 'groq', model: 'groq/compound-mini' },
  },
  synthesize_chat: {
    primary: { provider: 'groq', model: 'groq/compound-mini', temp: 0.2 },
    fallback: { provider: 'groq', model: 'groq/compound' },
  },
  synthesize_case: {
    primary: { provider: 'groq', model: 'groq/compound-mini', temp: 0.1 },
    fallback: { provider: 'groq', model: 'groq/compound-mini', temp: 0.1 },
  },
  judge_eval: {
    primary: { provider: 'groq', model: 'qwen/qwen3.8-27b', temp: 0 },
    fallback: { provider: 'groq', model: 'groq/compound-mini' },
  },
  // TTS speech-synthesis model, NOT chat-completion — future Arabic voice output, excluded from judge/chat routing.
  voice_tts: {
    primary: { provider: 'groq', model: 'canopylabs/orpheus-arabic-saudi' },
  },
};

/**
 * Resolve endpoint configuration for a functional model role.
 * Respects env var overrides when defined.
 */
export function resolveRoute(role: ModelRole): ModelRouteConfig {
  const route = MODEL_ROUTING_TABLE[role];
  if (!route) {
    throw new Error(`Unknown model role: ${role}`);
  }

  if (role === 'judge_eval' && process.env.LLM_JUDGE_MODEL) {
    return {
      primary: {
        ...route.primary,
        model: process.env.LLM_JUDGE_MODEL,
      },
      fallback: route.fallback,
    };
  }

  return route;
}
