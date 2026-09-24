import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FEATURE_FLAG_NAMES,
  FeatureFlagName,
  isFlagEnabled,
  isTruthy,
  llmopsFlags,
  LLMOpsFlags,
  snapshotFlags,
} from '../../lib/llmops/flags';
import * as llmops from '../../lib/llmops';

describe('LLMOps Feature Flags (flags.ts)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all FF_AI_* environment variables for clean test isolation
    for (const name of FEATURE_FLAG_NAMES) {
      delete process.env[name];
    }
    llmopsFlags.reset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    llmopsFlags.reset();
  });

  describe('Flag Defaults', () => {
    it('defaults all 6 flags to OFF (false) when env vars are unset', () => {
      for (const flag of FEATURE_FLAG_NAMES) {
        expect(isFlagEnabled(flag)).toBe(false);
      }

      expect(llmopsFlags.streaming).toBe(false);
      expect(llmopsFlags.ragPrimary).toBe(false);
      expect(llmopsFlags.langmemInject).toBe(false);
      expect(llmopsFlags.caseDeep).toBe(false);
      expect(llmopsFlags.onlineJudgeSample).toBe(false);
      expect(llmopsFlags.demoKeywordFallback).toBe(false);
    });

    it('contains exactly the 6 spec-mandated flags', () => {
      expect(FEATURE_FLAG_NAMES).toEqual([
        'FF_AI_STREAMING',
        'FF_AI_RAG_PRIMARY',
        'FF_AI_LANGMEM_INJECT',
        'FF_AI_CASE_DEEP',
        'FF_AI_ONLINE_JUDGE_SAMPLE',
        'FF_AI_DEMO_KEYWORD_FALLBACK',
      ]);
    });
  });

  describe('Truthy Env Parsing', () => {
    it("parses '1' as true", () => {
      expect(isTruthy('1')).toBe(true);
      expect(isTruthy(1)).toBe(true);
    });

    it("parses 'true' (case-insensitive and trimmed) as true", () => {
      expect(isTruthy('true')).toBe(true);
      expect(isTruthy('True')).toBe(true);
      expect(isTruthy('TRUE')).toBe(true);
      expect(isTruthy('  true  ')).toBe(true);
      expect(isTruthy('  1  ')).toBe(true);
      expect(isTruthy(true)).toBe(true);
    });

    it("treats all non-'1' and non-'true' values as false", () => {
      expect(isTruthy('0')).toBe(false);
      expect(isTruthy('false')).toBe(false);
      expect(isTruthy('FALSE')).toBe(false);
      expect(isTruthy('')).toBe(false);
      expect(isTruthy('   ')).toBe(false);
      expect(isTruthy('yes')).toBe(false);
      expect(isTruthy('no')).toBe(false);
      expect(isTruthy('on')).toBe(false);
      expect(isTruthy('off')).toBe(false);
      expect(isTruthy(undefined)).toBe(false);
      expect(isTruthy(null)).toBe(false);
      expect(isTruthy(0)).toBe(false);
      expect(isTruthy(2)).toBe(false);
    });

    it('activates flags dynamically when env is set', () => {
      process.env.FF_AI_STREAMING = '1';
      process.env.FF_AI_CASE_DEEP = 'true';
      process.env.FF_AI_RAG_PRIMARY = '0';

      expect(isFlagEnabled('FF_AI_STREAMING')).toBe(true);
      expect(isFlagEnabled('FF_AI_CASE_DEEP')).toBe(true);
      expect(isFlagEnabled('FF_AI_RAG_PRIMARY')).toBe(false);

      expect(llmopsFlags.streaming).toBe(true);
      expect(llmopsFlags.caseDeep).toBe(true);
      expect(llmopsFlags.ragPrimary).toBe(false);
    });
  });

  describe('Snapshot Stability', () => {
    it('produces a complete snapshot with all flag keys', () => {
      const snapshot = snapshotFlags();

      expect(Object.keys(snapshot).sort()).toEqual([...FEATURE_FLAG_NAMES].sort());
      for (const flag of FEATURE_FLAG_NAMES) {
        expect(snapshot[flag]).toBe(false);
      }
    });

    it('captures active flag states in snapshot', () => {
      const customEnv: Record<string, string | undefined> = {
        FF_AI_STREAMING: 'true',
        FF_AI_RAG_PRIMARY: '1',
        FF_AI_LANGMEM_INJECT: '0',
        FF_AI_CASE_DEEP: 'TRUE',
        FF_AI_ONLINE_JUDGE_SAMPLE: 'false',
        FF_AI_DEMO_KEYWORD_FALLBACK: '1',
      };

      const snapshot = snapshotFlags(customEnv);
      expect(snapshot).toEqual({
        FF_AI_STREAMING: true,
        FF_AI_RAG_PRIMARY: true,
        FF_AI_LANGMEM_INJECT: false,
        FF_AI_CASE_DEEP: true,
        FF_AI_ONLINE_JUDGE_SAMPLE: false,
        FF_AI_DEMO_KEYWORD_FALLBACK: true,
      });
    });

    it('returns a new snapshot object every time (immutable copy)', () => {
      const snap1 = snapshotFlags();
      const snap2 = snapshotFlags();

      expect(snap1).toEqual(snap2);
      expect(snap1).not.toBe(snap2);

      // Mutating snap1 does not pollute subsequent calls
      (snap1 as Record<string, boolean>).FF_AI_STREAMING = true;
      expect(snapshotFlags().FF_AI_STREAMING).toBe(false);
    });

    it('is mirrored identically on the llmopsFlags singleton', () => {
      process.env.FF_AI_STREAMING = '1';
      process.env.FF_AI_ONLINE_JUDGE_SAMPLE = 'true';

      const snapFromFunc = snapshotFlags();
      const snapFromObj = llmopsFlags.snapshot();

      expect(snapFromObj).toEqual(snapFromFunc);
      expect(snapFromObj.FF_AI_STREAMING).toBe(true);
      expect(snapFromObj.FF_AI_ONLINE_JUDGE_SAMPLE).toBe(true);
      expect(snapFromObj.FF_AI_CASE_DEEP).toBe(false);
    });
  });

  describe('Scoped LLMOpsFlags Instances', () => {
    it('supports custom environment maps without polluting global process.env', () => {
      const scopedFlags = new LLMOpsFlags({
        FF_AI_STREAMING: '1',
        FF_AI_LANGMEM_INJECT: 'true',
      });

      expect(scopedFlags.streaming).toBe(true);
      expect(scopedFlags.langmemInject).toBe(true);
      expect(scopedFlags.ragPrimary).toBe(false);

      // Global process.env remains unchanged
      expect(llmopsFlags.streaming).toBe(false);
      expect(llmopsFlags.langmemInject).toBe(false);
    });

    it('can reassign custom env with setEnv', () => {
      const custom = new LLMOpsFlags();
      expect(custom.streaming).toBe(false);

      custom.setEnv({ FF_AI_STREAMING: 'true' });
      expect(custom.streaming).toBe(true);

      custom.reset();
      expect(custom.streaming).toBe(false);
    });
  });

  describe('Exports via lib/llmops/index.ts', () => {
    it('re-exports flags and retention utilities from main entrypoint', () => {
      expect(llmops.llmopsFlags).toBeDefined();
      expect(llmops.snapshotFlags).toBeDefined();
      expect(llmops.isFlagEnabled).toBeDefined();
      expect(llmops.FEATURE_FLAG_NAMES).toBeDefined();
      expect(llmops.purgeDebugPayloads).toBeDefined();
      expect(llmops.AI_RUNS_RETENTION_SQL).toBeDefined();
    });
  });
});
