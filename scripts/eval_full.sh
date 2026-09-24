#!/bin/sh
set -eu

echo "=========================================================="
echo "  HAKMDAR LLMOps: Full Evaluation Suite (Nightly / Release)"
echo "=========================================================="

echo ""
echo ">>> Phase 1: Running Grand Suite (evaluation/runner.ts) <<<"
npx tsx evaluation/runner.ts

echo ""
echo ">>> Phase 2: Running Smoke Suite with Full Gate Profile <<<"
npx tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json --gate full "$@"

echo ""
echo "✅ Full evaluation pipeline completed successfully."
