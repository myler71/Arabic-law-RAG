/**
 * Arabic Law RAG LLMOps Feature Flags (Spec L7.2)
 *
 * Operational toggles for controlling AI features across environments.
 * All flags default to OFF (false).
 *
 * Truthy evaluation:
 * Only '1' and 'true' (case-insensitive, trimmed) evaluate to true.
 * All other values (undefined, empty string, '0', 'false', etc.) evaluate to false.
 */

export type FeatureFlagName =
  | 'FF_AI_STREAMING'
  | 'FF_AI_RAG_PRIMARY'
  | 'FF_AI_LANGMEM_INJECT'
  | 'FF_AI_CASE_DEEP'
  | 'FF_AI_ONLINE_JUDGE_SAMPLE'
  | 'FF_AI_DEMO_KEYWORD_FALLBACK';

export const FEATURE_FLAG_NAMES: readonly FeatureFlagName[] = [
  'FF_AI_STREAMING',
  'FF_AI_RAG_PRIMARY',
  'FF_AI_LANGMEM_INJECT',
  'FF_AI_CASE_DEEP',
  'FF_AI_ONLINE_JUDGE_SAMPLE',
  'FF_AI_DEMO_KEYWORD_FALLBACK',
] as const;

export type FeatureFlagsSnapshot = Record<FeatureFlagName, boolean>;

/**
 * Returns true if the given value is considered truthy ('1' or 'true', case-insensitive).
 */
export function isTruthy(val: unknown): boolean {
  if (typeof val === 'boolean') {
    return val;
  }
  if (typeof val === 'number') {
    return val === 1;
  }
  if (typeof val !== 'string') {
    return false;
  }
  const normalized = val.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * Check if a specific feature flag is enabled in the target environment.
 * If no env object is provided, process.env is inspected.
 */
export function isFlagEnabled(
  flag: FeatureFlagName,
  env: Record<string, string | undefined> = process.env
): boolean {
  const val = env[flag];
  return isTruthy(val);
}

/**
 * Create an immutable snapshot of all feature flags for logging or telemetry.
 * Logged on every AI run per spec L7.2.
 */
export function snapshotFlags(
  env: Record<string, string | undefined> = process.env
): FeatureFlagsSnapshot {
  const result: Partial<FeatureFlagsSnapshot> = {};
  for (const name of FEATURE_FLAG_NAMES) {
    result[name] = isFlagEnabled(name, env);
  }
  return result as FeatureFlagsSnapshot;
}

/**
 * Feature flags accessor class providing convenient typed getters and snapshotting.
 */
export class LLMOpsFlags {
  private customEnv: Record<string, string | undefined> | null = null;

  constructor(customEnv?: Record<string, string | undefined>) {
    if (customEnv) {
      this.customEnv = customEnv;
    }
  }

  private getEnv(): Record<string, string | undefined> {
    return this.customEnv ?? process.env;
  }

  /**
   * Set custom environment map for testing or scoped execution.
   * Pass null to restore process.env.
   */
  setEnv(env: Record<string, string | undefined> | null): void {
    this.customEnv = env;
  }

  /**
   * Reset any custom environment override.
   */
  reset(): void {
    this.customEnv = null;
  }

  /**
   * Check if a specific flag is enabled.
   */
  isEnabled(flag: FeatureFlagName): boolean {
    return isFlagEnabled(flag, this.getEnv());
  }

  /**
   * FF_AI_STREAMING: Enable SSE token streaming for AI consultation routes.
   */
  get streaming(): boolean {
    return this.isEnabled('FF_AI_STREAMING');
  }

  /**
   * FF_AI_RAG_PRIMARY: Route retrieval primarily to legalassist-ai sidecar / vector index
   * vs local embedded fallback.
   */
  get ragPrimary(): boolean {
    return this.isEnabled('FF_AI_RAG_PRIMARY');
  }

  /**
   * FF_AI_LANGMEM_INJECT: Inject recalled lawyer instruction (T1) and preference (T2)
   * memories into system prompts.
   */
  get langmemInject(): boolean {
    return this.isEnabled('FF_AI_LANGMEM_INJECT');
  }

  /**
   * FF_AI_CASE_DEEP: Enable multi-agent sequential specialist graph for case analysis.
   */
  get caseDeep(): boolean {
    return this.isEnabled('FF_AI_CASE_DEEP');
  }

  /**
   * FF_AI_ONLINE_JUDGE_SAMPLE: Enable asynchronous online evaluation sampling on production runs.
   */
  get onlineJudgeSample(): boolean {
    return this.isEnabled('FF_AI_ONLINE_JUDGE_SAMPLE');
  }

  /**
   * FF_AI_DEMO_KEYWORD_FALLBACK: Allow keyword-based demo legal fallback when RAG retrieval is empty.
   * Default OFF in production per spec L7.2.
   */
  get demoKeywordFallback(): boolean {
    return this.isEnabled('FF_AI_DEMO_KEYWORD_FALLBACK');
  }

  /**
   * Produce a snapshot of all flags for logging.
   */
  snapshot(): FeatureFlagsSnapshot {
    return snapshotFlags(this.getEnv());
  }
}

/**
 * Singleton LLMOps feature flag manager.
 */
export const llmopsFlags = new LLMOpsFlags();
