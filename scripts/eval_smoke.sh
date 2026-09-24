#!/bin/sh
set -eu

echo "=========================================================="
echo "  HAKMDAR LLMOps: Smoke Evaluation (PR / Pre-deploy Gate)"
echo "=========================================================="

npx tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json --gate smoke "$@"

echo "✅ Smoke evaluation completed successfully."
