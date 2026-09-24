# Arabic-law-RAG Operations Runbook

This runbook was extracted from HAKMDAR. Sections that depend on the excluded web application (portals, practice-management writes) are marked accordingly; the AI engine procedures apply unchanged.

## 1. Install and verify (local / offline)
```bash
git clone https://github.com/myler71/Arabic-law-RAG.git
cd Arabic-law-RAG
npm install                # first time only
npm run typecheck
npm test
```
- This repository is a library plus a thin Next.js route surface; it has no `dev` or `build` script and no pages. Host the routes from a Next.js application to serve them over HTTP.
- No Supabase credentials required for local verification: tests run the routes in demo mode, where middleware sets `x-hakmdar-demo-mode: 1` and `/api/ai/*` fall back to the local deterministic legal engine.
- With Supabase configured (copy `.env.example` → `.env.local`), the routes require a real session and role.

## 2. Offline AI stack (defaults)
- **Retrieval**: `lib/ai/legalRag.ts` — Arabic-normalized hybrid TF-IDF/BM25 over `lib/ai/knowledge/egyptian-labor-law.json` (46 articles, Law 12/2003) + `lib/data/legalData.ts` encyclopedia. 100% in-process, zero network.
- **Guards**: `lib/ai/safety/legalGuard.ts` — `preGuard` (domain classify + colloquial map) and `postGuard` (citation verify vs retrieved chunk metadata; evidence < 0.65 → disclaimer).
- **Streaming**: `app/api/ai/chat/stream/route.ts` — typed SSE (`metadata|token|citation|structured_summary|error|done`), timings in `done` payload.
- **case_deep**: `lib/ai/agents/graph.ts` — sequential specialists → synthesize → HITL checkpoint (`lib/ai/agents/checkpoint.ts`, in-memory; swap for Postgres per ADR-004 note) → finalize.
- Optional external LLM adapters (`KARNAK_API_URL`, `OLLAMA_BASE_URL`, `GROQ_API_KEY`) remain OFF by default; absence never blocks operation.

## 3. Verification commands
```bash
npm test                    # 196 tests across 16 files
npm run typecheck           # tsc --noEmit, 0 errors
npm run eval                # 57 scenarios; writes evaluation/reports/latest.{json,md}
npm run eval:smoke          # 16-scenario smoke gate
npm run eval:compare        # regression comparison against the committed baseline
```
Evaluation thresholds: guard_precision ≥ 0.90 (actual 1.00), ood_block_rate = 1.00, retrieval_recall@5 ≥ 0.80 (actual 0.985), citation_verify_rate = 1.00.

## 4. Key rotation / config change
1. Update `.env.local` (Supabase URL/anon key, or `LEGAL_RAG_BASE_URL` + `LEGAL_RAG_SERVICE_KEY` for the optional Python sidecar).
2. Restart the host application. Demo-mode headers disappear automatically once Supabase is configured.
3. Never commit real keys; `.env*` stays gitignored.

## 5. Incident quick-reference
| Symptom | Check | Fix |
|---|---|---|
| 429 on AI routes | `lib/ai/rateLimiter.ts` window (30/min default) | Wait for window or raise limit env |
| Chat answers without citations | `postGuard` evidence score | Expected disclaimer path when < 0.65; else verify corpus file loaded |
| 403 cross-tenant write | Ownership pre-checks (web application, not in this repository) | Confirm `client_id`/`case_id` belongs to the authenticated lawyer in the host app |
| Middleware redirects unexpected | `middleware.ts` config matcher | Public routes list includes `/login`, `/register`, `/auth/*` (host-application routes) |
| Fabricated article number suspected | `GET /api/ai/runs/{id}/trace` | Every citation must carry chunk_id from retrieval; else file challenge |

## 6. Stop-the-line invariants (never disable "temporarily")
1. Auth on all `/api/ai/*`; rate limiting stays on.
2. Citation verify + `<0.65` disclaimer path stays on.
3. HITL required before formal case brief delivery (lawyer approve/modify/reject).
4. Typecheck and unit-test gates remain enabled in CI (`.github/workflows/llmops-ci.yml`).

## 7. LLMOps Operational Procedures

### 7.1 Reading a Trace & Forensics (L3.2, L4.1)
Every request traversing `/api/ai/*` receives an `X-Trace-Id` (UUIDv4) echoed on HTTP response headers.

1. **Identify the Trace ID**: Retrieve `X-Trace-Id` from client response headers or inspect browser network logs.
2. **Locate in Local Run Store**:
   ```bash
   # Find the trace entry in the local JSONL append store
   grep "TRACE_ID_HERE" .llmops/dev_runs.jsonl | jq .
   ```
3. **Query the Trace Endpoint**:
   ```bash
   curl -s -H "Authorization: Bearer $LAWYER_JWT" \
     "http://localhost:3000/api/ai/runs/$RUN_ID/trace" | jq .
   ```
4. **Audit Evidence & Citations**:
   - Inspect `data.top_chunk_ids` to verify which statutory articles were retrieved.
   - Verify that all output citations match retrieved `chunk_id` values.
   - If `evidence_score < 0.65`, verify that the system correctly routed to the disclaimer path.

### 7.2 Running Evaluations (Smoke, Full, Compare) (L6.4, L6.5)
The evaluation harness validates deterministic guards, retrieval accuracy, citation binding, and judge quality.

```bash
# 1. Smoke Evaluation (10-20 curated PR cases; fast release gate)
./scripts/eval_smoke.sh
# Alternatively:
npx tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json --gate smoke

# 2. Full Evaluation (Comprehensive 57+ scenario legal & OOD suite)
./scripts/eval_full.sh
# Alternatively:
npx tsx lib/llmops/eval/runner.ts evaluation/scenarios.json --gate full

# 3. Baseline Comparison (Detect quality regressions against approved baseline)
npx tsx scripts/eval_compare_baseline.ts \
  --current evaluation/reports/latest.json \
  --baseline evaluation/reports/baseline-smoke.json
```

**Regression Gate Invariants (L6.5):**
- `citation_precision` must not drop > 2 percentage points vs baseline.
- Hallucinated citations count must equal 0 (zero tolerance).
- `guard_ood_recall` must not drop > 1 percentage point.

### 7.3 Replaying a Failed Evaluation Case (L6.7)
When an eval case fails, inspect the report artifact in `evaluation/reports/latest.json`:
```bash
# Extract the failed case ID and inputs
jq '.results[] | select(.pass == false)' evaluation/reports/latest.json

# Replay single scenario in isolation with debug tracing enabled
DEBUG_CAPTURE=true npx tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json \
  --case lab-001 --gate smoke
```
Redacted replay packs stored under `evaluation/replays/` can be re-executed offline without external network dependencies.

### 7.4 Feedback Collection & Memory Promotion (L5.3, L5.5)
Client and lawyer ratings flow through the feedback memory pipeline:
1. **Episodic Ingestion (T0)**:
   Feedback is automatically submitted to `POST /api/ai/feedback` (`accepted`, `corrected`, `rejected`), generating a T0 episodic memory record tied to the `trace_id`.
2. **Promoting Feedback (T1 Instruction or T3 Eval Gold)**:
   Licensed attorneys or administrators can promote high-signal corrections:
   ```bash
   # Promote to T1 (Instruction Memory) — adjusts prompt guidance for lawyers
   curl -X POST "http://localhost:3000/api/ai/feedback/$FEEDBACK_ID/promote" \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"target_tier": "T1", "reason": "Mandate jurisdiction check for labor disputes"}'

   # Promote to T3 (Eval Gold) — adds new regression test scenario
   curl -X POST "http://localhost:3000/api/ai/feedback/$FEEDBACK_ID/promote" \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"target_tier": "T3", "reason": "Curated regression case for Article 122 notice period"}'
   ```
   *Critical Invariant (L5.2)*: Feedback **never** enters T4 (statutory truth). Ingesting statutes requires official legal gazette updates.

### 7.5 API Key & Provider Rotation
Rotate external inference credentials without downtime:
1. Generate new API key in provider dashboard (Groq, LangSmith, Supabase).
2. Update `.env.local` (or production secret vault):
   - `GROQ_API_KEY`: Model inference & judge evaluation.
   - `LLM_JUDGE_MODEL`: Default `qwen/qwen3.8-27b`, fallback `groq/compound-mini`.
   - `LANGSMITH_API_KEY`: LangSmith trace export.
   - `OTLP_ENDPOINT`: OpenTelemetry collector endpoint.
3. Gracefully reload application processes (`npm run dev` locally, or zero-downtime rolling restart in staging/prod).
4. Absence of keys triggers safe fallbacks: local deterministic hybrid RAG and in-memory trace stores remain 100% operational.

### 7.6 Data Retention Job (L3.7, L8.6)
Prune transient debug payloads while permanently preserving evaluation gold and user feedback:
```bash
# Dry-run audit (view candidate lines and files without modifying)
./scripts/retention_cleanup.sh --days 14 --dry-run

# Execute pruning of .llmops/*.jsonl and debug report artifacts
./scripts/retention_cleanup.sh --days 14
```
For Supabase PostgreSQL instances, schedule the service-role SQL query defined in `AI_RUNS_RETENTION_SQL` (`lib/llmops/retention.ts`) via `pg_cron` daily at 03:00 UTC.

### 7.7 Rollback & Emergency Feature Flag Revert (L7.2, L7.3)
If an incident, model degradation, or upstream latency spike occurs, toggle operational feature flags in `.env.local` or process environment:

| Flag Name | Default | Emergency Revert Setting | Operational Effect |
|---|---|---|---|
| `FF_AI_STREAMING` | `0` (OFF) | `0` | Reverts SSE token streaming to buffered JSON responses |
| `FF_AI_RAG_PRIMARY` | `0` (OFF) | `0` | Reverts external RAG sidecar to embedded in-process `legalRag.ts` |
| `FF_AI_LANGMEM_INJECT` | `0` (OFF) | `0` | Immediately stops injecting recalled memories into system prompts |
| `FF_AI_CASE_DEEP` | `0` (OFF) | `0` | Reverts multi-agent graph to synchronous single-pass synthesis |
| `FF_AI_ONLINE_JUDGE_SAMPLE` | `0` (OFF) | `0` | Disables background LLM-as-judge evaluation sampling |
| `FF_AI_DEMO_KEYWORD_FALLBACK` | `0` (OFF) | `0` | Ensures strict citation enforcement without keyword guessing |

To revert a prompt version or model ID without redeploying code:
```bash
export LLMOPS_PROMPT_VERSION="synth_chat@1.4.0"
export LLMOPS_MODEL_ID="groq/compound-mini"
```

### 7.8 Observability Dashboards & Alerts Pointer
Detailed Prometheus metrics catalog (`ai_requests_total`, `ai_ttft_ms`, `ai_evidence_score`, `ai_guard_refuse_total`), OpenTelemetry span schemas, and PagerDuty alert thresholds are documented in [docs/llmops.md](./llmops.md).
