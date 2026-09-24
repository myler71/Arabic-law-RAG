#!/bin/sh
set -eu

# ==============================================================================
# Arabic Law RAG LLMOps: Retention Cleanup Script (Spec L3.7, L8.6)
# ==============================================================================
#
# Prunes debug-level telemetry lines (.llmops/*.jsonl) and transient debug report
# artifacts older than the configured threshold (default: 14 days).
#
# Invariant: Never deletes baseline evaluation gold or user-linked feedback.
#
# Scheduling Hints:
# -----------------
# 1. Linux Crontab (daily at 03:00 UTC):
#    0 3 * * * cd /path/to/Arabic Law RAG && ./scripts/retention_cleanup.sh --days 14 >> /var/log/arabic-law-rag_retention.log 2>&1
#
# 2. Systemd Timer (alternative to cron):
#    [Timer]
#    OnCalendar=*-*-* 03:00:00
#    Persistent=true
#
# 3. Dry-Run Inspection:
#    ./scripts/retention_cleanup.sh --days 7 --dry-run
# ==============================================================================

echo "=========================================================="
echo "  Arabic Law RAG LLMOps: File Store Retention Cleanup"
echo "=========================================================="

npx tsx lib/llmops/retention.ts "$@"

echo "✅ Retention cleanup completed."
