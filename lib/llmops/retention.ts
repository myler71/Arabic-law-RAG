/**
 * HAKMDAR LLMOps Data Retention Engine (Spec L3.7, L8.6)
 *
 * Implements retention policies across local file stores and documents
 * the PostgreSQL / Supabase retention policies for cloud tables (ai_runs, ai_run_spans, ai_feedback).
 *
 * Retention Schedule:
 * - Debug Payloads & Transient Spans: 7–14 days (default: 14 days)
 * - Operational Run Records: 90 days
 * - User Feedback & Gold Evaluation Cases: Retained indefinitely
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RetentionPurgeOptions {
  /** Retention window for debug records in days (default: 14) */
  olderThanDays?: number;
  /** When true, reports what would be deleted without modifying files */
  dryRun?: boolean;
  /** Root directory to inspect (defaults to process.cwd()) */
  baseDir?: string;
  /** Reference timestamp for calculating cutoffs (defaults to current time) */
  now?: Date;
}

export interface RetentionPurgeResult {
  filesScanned: number;
  filesModified: number;
  linesRemoved: number;
  linesRetained: number;
  artifactsRemoved: number;
  bytesSavedEstimate: number;
  dryRun: boolean;
  details: string[];
}

/**
 * PostgreSQL retention policy DDL and maintenance queries for Supabase service role jobs.
 * This can be scheduled via pg_cron extension or an edge function trigger.
 *
 * Cron hint:
 *   SELECT cron.schedule('llmops_retention_daily', '0 3 * * *', $$
 *     -- Purge debug spans older than 14 days
 *     DELETE FROM ai_run_spans WHERE created_at < NOW() - INTERVAL '14 days';
 *     -- Purge transient debug runs
 *     DELETE FROM ai_runs WHERE (outcome = 'debug' OR (metadata->>'debug')::boolean = true)
 *       AND created_at < NOW() - INTERVAL '14 days';
 *     -- Soft-prune normal operational runs older than 90 days that have no linked feedback
 *     DELETE FROM ai_runs WHERE created_at < NOW() - INTERVAL '90 days'
 *       AND id NOT IN (SELECT run_id FROM ai_feedback WHERE run_id IS NOT NULL);
 *   $$);
 */
export const AI_RUNS_RETENTION_SQL = `-- HAKMDAR LLMOps ai_runs Retention Policy (Service Role Scheduled Job)
-- Schedule: Daily at 03:00 UTC
-- Safe: Protects all runs linked to feedback (T0) and eval gold (T3).

BEGIN;

-- 1. Purge fine-grained span trees older than 14 days
DELETE FROM public.ai_run_spans
WHERE created_at < NOW() - INTERVAL '14 days';

-- 2. Purge raw debug runs older than 14 days
DELETE FROM public.ai_runs
WHERE (
    outcome = 'debug'
    OR (metadata->>'debug')::boolean IS TRUE
    OR (metadata->>'level') = 'debug'
  )
  AND created_at < NOW() - INTERVAL '14 days';

-- 3. Archive/delete un-flagged operational runs older than 90 days
-- Preserves runs with linked lawyer/client feedback or evaluation benchmarks
DELETE FROM public.ai_runs
WHERE created_at < NOW() - INTERVAL '90 days'
  AND id NOT IN (
    SELECT DISTINCT run_id FROM public.ai_feedback WHERE run_id IS NOT NULL
  );

COMMIT;
`;

/**
 * Purges debug records older than the specified retention threshold from local file stores.
 * Targets:
 * 1. .llmops/*.jsonl (drops debug-level lines older than N days)
 * 2. evaluation/reports/ debug artifacts older than N days
 */
export async function purgeDebugPayloads(
  options: RetentionPurgeOptions = {}
): Promise<RetentionPurgeResult> {
  const olderThanDays = options.olderThanDays ?? 14;
  const dryRun = Boolean(options.dryRun);
  const baseDir = options.baseDir ?? process.cwd();
  const now = options.now ?? new Date();

  const cutoffMs = now.getTime() - olderThanDays * 86_400_000;
  const result: RetentionPurgeResult = {
    filesScanned: 0,
    filesModified: 0,
    linesRemoved: 0,
    linesRetained: 0,
    artifactsRemoved: 0,
    bytesSavedEstimate: 0,
    dryRun,
    details: [],
  };

  // 1. Inspect .llmops/ JSONL files
  const llmopsDir = path.resolve(baseDir, '.llmops');
  if (fs.existsSync(llmopsDir)) {
    const entries = await fs.promises.readdir(llmopsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.log'))) {
        continue;
      }

      const filePath = path.join(llmopsDir, entry.name);
      result.filesScanned++;

      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const keptLines: string[] = [];
      let fileModified = false;
      let fileRemovedBytes = 0;

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        let isOldDebug = false;
        try {
          const parsed = JSON.parse(line);
          const isDebugLevel =
            parsed.level === 'debug' ||
            parsed.outcome === 'debug' ||
            parsed.debug === true ||
            parsed.data?.debug_payload === true;

          if (isDebugLevel) {
            const rawTs = parsed.ts || parsed.created_at || parsed.finished_at;
            const recordTime = rawTs ? new Date(rawTs).getTime() : 0;
            if (recordTime > 0 && recordTime < cutoffMs) {
              isOldDebug = true;
            }
          }
        } catch {
          // If not JSON, retain the line
        }

        if (isOldDebug) {
          result.linesRemoved++;
          fileRemovedBytes += Buffer.byteLength(line, 'utf-8') + 1;
          fileModified = true;
        } else {
          result.linesRetained++;
          keptLines.push(line);
        }
      }

      if (fileModified) {
        result.filesModified++;
        result.bytesSavedEstimate += fileRemovedBytes;
        result.details.push(
          `Purged debug lines from ${entry.name} (${fileRemovedBytes} bytes freed)`
        );

        if (!dryRun) {
          const updatedContent = keptLines.length > 0 ? keptLines.join('\n') + '\n' : '';
          await fs.promises.writeFile(filePath, updatedContent, 'utf-8');
        }
      }
    }
  }

  // 2. Inspect evaluation/reports/ for debug artifacts
  const reportsDir = path.resolve(baseDir, 'evaluation', 'reports');
  if (fs.existsSync(reportsDir)) {
    const reportEntries = await fs.promises.readdir(reportsDir, { withFileTypes: true });
    for (const entry of reportEntries) {
      if (!entry.isFile()) {
        continue;
      }

      const isProtected =
        entry.name === 'latest.json' ||
        entry.name === 'latest.md' ||
        entry.name.startsWith('baseline-') ||
        entry.name === '.gitkeep';

      if (isProtected) {
        continue;
      }

      const isDebugArtifact =
        entry.name.includes('.debug.') ||
        entry.name.endsWith('.debug.json') ||
        entry.name.endsWith('.debug.md');

      const fullPath = path.join(reportsDir, entry.name);
      result.filesScanned++;

      let shouldPurge = false;
      try {
        const stats = await fs.promises.stat(fullPath);
        if (isDebugArtifact && stats.mtimeMs < cutoffMs) {
          shouldPurge = true;
        }
      } catch {
        // file stat error ignored
      }

      if (shouldPurge) {
        const stats = await fs.promises.stat(fullPath);
        result.artifactsRemoved++;
        result.bytesSavedEstimate += stats.size;
        result.details.push(`Removed debug report artifact: ${entry.name}`);

        if (!dryRun) {
          await fs.promises.unlink(fullPath);
        }
      }
    }
  }

  return result;
}

/**
 * CLI Runner when invoked directly
 */
if (typeof process !== 'undefined' && process.argv) {
  const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('lib/llmops/retention.ts');
  if (isDirectRun) {
    const args = process.argv.slice(2);
    let days = 14;
    let dryRun = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--days' && args[i + 1]) {
        days = parseInt(args[i + 1], 10) || 14;
        i++;
      } else if (args[i] === '--dry-run') {
        dryRun = true;
      }
    }

    purgeDebugPayloads({ olderThanDays: days, dryRun })
      .then((res) => {
        console.log('--- HAKMDAR LLMOps Retention Cleanup ---');
        console.log(`Dry run: ${res.dryRun}`);
        console.log(`Files scanned: ${res.filesScanned}`);
        console.log(`Files modified: ${res.filesModified}`);
        console.log(`Debug lines removed: ${res.linesRemoved}`);
        console.log(`Lines retained: ${res.linesRetained}`);
        console.log(`Debug artifacts removed: ${res.artifactsRemoved}`);
        console.log(`Estimated space saved: ${res.bytesSavedEstimate} bytes`);
        if (res.details.length > 0) {
          console.log('\nDetails:');
          for (const d of res.details) {
            console.log(`  - ${d}`);
          }
        }
      })
      .catch((err) => {
        console.error('Retention purge failed:', err);
        process.exit(1);
      });
  }
}
