# Arabic Law RAG LLMOps Operator Guide

This guide provides operational instructions for monitoring, debugging, evaluating, and maintaining the Arabic Law RAG legal AI system across environments.

---

## 1. Structured Logging & Base Log Envelope

Every AI lifecycle event is emitted as a single structured JSON line to `stdout` with automatic context binding via AsyncLocalStorage (`lib/llmops/context.ts`).

### 1.1 Base Envelope Specification (L3.2)

```json
{
  "ts": "2026-09-15T12:00:00.123Z",
  "level": "info",
  "service": "arabic-law-rag",
  "env": "prod",
  "event": "ai.retrieve.done",
  "trace_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "span_id": "3a8f12c9e4b07d1a",
  "parent_span_id": "8f12c9e4b07d1a3a",
  "run_id": "4a2c1e8f-7b3d-4bad-9bdd-2b0d7b3dcb6e",
  "session_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "user_id_hash": "c4ca4238a0b9",
  "case_id": null,
  "persona": "client",
  "route": "/api/ai/chat/stream",
  "mode": "chat_fast",
  "git_sha": "ea46529",
  "prompt_version": "synth_chat@1.4.1",
  "model_id": "groq/compound-mini",
  "rag_index_version": "statutes-eg-2026.03.1",
  "duration_ms": 142,
  "outcome": "success",
  "msg": "Hybrid legal retrieval completed",
  "data": {
    "n_dense": 15,
    "n_sparse": 12,
    "n_rrf": 8,
    "n_rerank": 4,
    "top_chunk_ids": ["statute:labor:122", "statute:labor:129"],
    "evidence_score": 0.94
  },
  "error": {
    "type": "",
    "message_safe": "",
    "code": ""
  }
}
```

---

## 2. Event Catalog Table (L3.3)

| Event Name | Trigger Stage | Key Payload Fields (`data`) |
|---|---|---|
| `ai.request.start` | Route entry | `mode`, `locale`, `message_len`, `history_turns` |
| `ai.auth.ok` | Authentication verified | `user_id_hash`, `persona` |
| `ai.auth.fail` | Auth failure / invalid token | `reason`, `status_code` |
| `ai.ratelimit.hit` | Rate limit threshold exceeded | `limit`, `window_ms`, `user_id_hash` |
| `ai.guard_pre.start` | Guard inspection started | `input_len` |
| `ai.guard_pre.done` | Pre-guard classification complete | `is_legal`, `domain`, `confidence`, `mapped_concepts_count`, `latency_ms` |
| `ai.guard_pre.refuse` | Out-of-domain / jailbreak refusal | `reject_reason`, `domain` |
| `ai.retrieve.start` | Hybrid retrieval initiated | `query_len`, `top_k` |
| `ai.retrieve.done` | Dense + BM25 + RRF + Rerank finish | `n_dense`, `n_sparse`, `n_rrf`, `n_rerank`, `top_chunk_ids`, `evidence_score` |
| `ai.retrieve.error` | Retrieval RPC failure | `code`, `safe_message` |
| `ai.llm.start` | Model generation started | `provider`, `model_id`, `tokens_in` |
| `ai.llm.done` | Model generation completed | `provider`, `model_id`, `tokens_in`, `tokens_out`, `ttft_ms`, `latency_ms`, `cost_usd_est` |
| `ai.llm.error` | Provider API failure | `provider`, `error_code`, `fallback_used` |
| `ai.guard_post.start` | Post-guard citation check started | `citation_count` |
| `ai.guard_post.done` | Citation hallucination check finished | `citations_checked`, `verified`, `rejected`, `evidence_score`, `action` |
| `ai.stream.metadata_emitted`| Initial SSE metadata flushed | `citation_count`, `evidence_score` |
| `ai.stream.first_token` | Time-to-first-token recorded | `ttft_ms` |
| `ai.stream.done` | Stream transmission ended | `tokens_streamed`, `t_total_ms`, `client_disconnect` |
| `ai.graph.node.start` | Deep research graph node started | `node_name` (statutory, cassation, procedural, contract) |
| `ai.graph.node.done` | Deep research graph node finished | `node_name`, `latency_ms` |
| `ai.hitl.interrupt` | Human-in-the-loop checkpoint created | `checkpoint_id`, `case_id`, `lawyer_id` |
| `ai.hitl.resume` | Attorney submits approval/edit | `checkpoint_id`, `action` (`approve` \| `modify` \| `reject`) |
| `ai.request.done` | Request successfully terminated | `outcome`, `t_total_ms`, `cost_usd_est` |
| `ai.feedback.received` | User or attorney rating submitted | `feedback_id`, `kind`, `rating`, `target_span` |
| `ai.memory.write` | Episodic or instruction memory saved | `memory_type`, `promoted`, `validated_by` |
| `ai.memory.inject` | Memory items injected into prompt | `memory_ids_count`, `tiers` |
| `ai.eval.run.start` | Eval suite execution initiated | `suite`, `case_count` |
| `ai.eval.run.done` | Eval suite execution finished | `suite`, `pass_fail`, `scores` |
| `ai.ingest.job.start` | Corpus indexing initiated | `docs_count`, `target_index_version` |
| `ai.ingest.job.done` | Corpus indexing completed | `chunks_indexed`, `index_version` |
| `ai.alert.quality_drop` | Metric drift or gate failure | `metric`, `baseline`, `current`, `delta` |

---

## 3. Log Sink Configuration per Environment

| Environment | Primary Sink | Format | Notes |
|---|---|---|---|
| **Development** | Standard Output (`stdout`) | Human-readable JSON | Pretty-printed via terminal or piped to `pino-pretty` |
| **Staging** | Standard Output (`stdout`) | Single-line compact JSON | Ingested by cloud logging daemon (e.g. Vector, FluentBit) |
| **Production** | Log drain + OpenTelemetry | Compact JSON + OTLP | Platform log drain (Datadog/Loki/CloudWatch) + OTLP Collector |
| **Optional Dual-Write** | Supabase `ai_runs` & `ai_feedback` | Relational records | Permanent audit store for attorney analytics and feedback |

### Environment Variables
```bash
# Tracing exports (Optional)
OTLP_ENDPOINT="http://otel-collector.internal:4318"
LANGSMITH_API_KEY="lsv2_pt_..."
LANGSMITH_PROJECT="arabic-law-rag-prod"

# Model routing overrides
LLM_JUDGE_MODEL="qwen/qwen3.8-27b"
GROQ_API_KEY="gsk_..."

# Version metadata
APP_GIT_SHA="ea46529"
PROMPT_VERSION="synth_chat@1.4.1"
RAG_INDEX_VERSION="statutes-eg-2026.03.1"
```

---

## 4. How to Read a Trace: Step-by-Step

When investigating a customer issue or anomalous response:

```text
User Question / Chat
   │ (generates trace_id in HTTP response header 'X-Trace-Id')
   ▼
1. Query Supabase `ai_runs` table:
   SELECT * FROM ai_runs WHERE trace_id = '9b1deb4d-...';
   (Inspect outcome, ttft_ms, evidence_score, error_code, model_id)
   │
   ▼
2. Query Log Aggregator (Loki/CloudWatch/Datadog) by trace_id:
   {service="arabic-law-rag"} |= "9b1deb4d-..."
   (Check chronological events: ai.guard_pre.done -> ai.retrieve.done -> ai.llm.done)
   │
   ▼
3. Open Distributed Tracing UI (OpenTelemetry Jaeger/SigNoz or LangSmith):
   Trace: arabic-law-rag.ai.run
   ├── ai.auth (latency: 12ms)
   ├── ai.guard_pre (is_legal=true, domain=labor)
   ├── ai.retrieve (retrieved 4 chunks; chunk_ids=["statute:labor:122"])
   ├── ai.memory.recall (0 hits)
   ├── ai.llm.synthesize (ttft_ms=310, tokens_out=180)
   ├── ai.guard_post (verified=2, rejected=0, evidence_score=0.94)
   └── ai.stream (streamed 180 tokens)
```

### Triaging Scenarios
- **Low Evidence Score / Hallucination**:
  1. Locate `ai.guard_post.done` event in trace.
  2. Inspect `citations_checked` vs `rejected`.
  3. Inspect `top_chunk_ids` in `ai.retrieve.done`. If the cited statute was not in retrieved chunks, post-guard intervened.
- **High TTFT (> 1500ms)**:
  1. Compare `duration_ms` on `ai.retrieve.done` vs `ai.llm.start`.
  2. If retrieval is slow: examine dense/sparse RPC times.
  3. If LLM start to first token is slow: examine Groq endpoint queue or payload length.

---

## 5. Evaluation Gates Summary (Offline & Online)

| Gate Level | Suite | Frequency | Target Threshold | Action on Failure |
|---|---|---|---|---|
| **Unit Scorers** | Deterministic rule scorers | Every pull request (`git push`) | 100% pass | Block merge |
| **Smoke Eval** | 10–20 curated representative cases | Every PR & pre-deploy | Pass rate = 100%, TTFT p95 < 1200ms | Block deploy |
| **Full Legal Eval**| ≥50 legal + ≥15 OOD cases | Nightly / Pre-release | Citation Precision ≥ 95%, Hallucination = 0% | Block release |
| **Judge Eval** | LLM-as-judge (`qwen/qwen3.8-27b`) | Nightly on sample | Legal accuracy score ≥ 4.2 / 5.0 | Flag for legal review |
| **Regression Gate**| Benchmark vs baseline run | CI execution | Zero score regression vs main baseline | Release waiver ADR required |

---

## 6. Dashboards & Pager-Worthy Alert Definitions

### 6.1 Dashboard Panes
1. **Traffic & Flow**: Request rate per minute by `mode` (`chat_fast` vs `case_deep`) and `persona`.
2. **Latency (TTFT & Total)**: p50, p90, p95 of `ai_ttft_ms` and `ai_request_duration_ms`.
3. **Citation Quality**: `ai_citations_emitted_total` vs `ai_citations_rejected_total`, `ai_evidence_score` distribution.
4. **Refusal & Safety**: `ai_guard_refuse_total` by reason (OOD, prompt injection, medical/unethical).
5. **Human-in-the-Loop Latency**: Checkpoint open duration until attorney review submitted.
6. **Cost Tracking**: Hourly and daily cost calculation based on `ai_tokens_in_total` and `ai_tokens_out_total`.

### 6.2 Alert Rules (Prometheus / Alertmanager YAML)

```yaml
groups:
  - name: arabic_law_rag_llmops_alerts
    rules:
      - alert: HighAIErrorRate
        expr: sum(rate(ai_errors_total[5m])) / sum(rate(ai_requests_total[5m])) > 0.05
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "AI Error Rate > 5% for 10 minutes"

      - alert: SlowTTFTP95
        expr: histogram_quantile(0.95, sum(rate(ai_ttft_ms_bucket[15m])) by (le)) > 3000
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Time-to-first-token p95 exceeds 3 seconds"

      - alert: CitationHallucinationSpike
        expr: sum(rate(ai_citations_rejected_total[10m])) / sum(rate(ai_citations_emitted_total[10m])) > 0.15
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Post-guard rejected citations exceed 15% of all emitted citations"

      - alert: HighUserFeedbackRejections
        expr: sum(rate(ai_feedback_total{kind="rejected"}[1h])) / sum(rate(ai_feedback_total[1h])) > 0.20
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "User feedback rejection rate exceeded 20% over 1 hour"
```

---

## 7. Data Retention Policy

| Data Category | Storage Location | Retention Period | Purge / Roll-up Mechanism |
|---|---|---|---|
| **Debug Logs (stdout payloads)** | Log Aggregator / S3 | 7 – 14 Days | Automatic TTL expiration |
| **Span Traces (OTLP / LangSmith)** | Tracing Backend | 30 Days | Sliding window retention |
| **Aggregated Metrics** | Prometheus / Victoriametrics | 365 Days | Downsampled to 1h resolution after 30d |
| **Run Metadata (`ai_runs`)** | Supabase Postgres | 180 Days | Old runs archived to cold storage |
| **User & Lawyer Feedback** | Supabase `ai_feedback` | Permanent (Indefinite) | Core learning dataset for model improvement |
| **Curated Eval Gold (T3)** | `evaluation/` Git repo | Permanent | Version controlled golden benchmarks |

---

## 8. PII & Sensitive Secret Redaction Policy (L3.1 & L10)

Arabic Law RAG enforces strict client privacy under Egyptian law and legal ethics regulations:

1. **Egyptian National IDs**:
   - Matches standard 14-digit national identifier sequences.
   - Automatically redacted to `[REDACTED:NATIONAL_ID]`.
2. **Egyptian Phone Numbers**:
   - Matches local numbers starting with `010`, `011`, `012`, `015` with optional `+20` prefix.
   - Automatically redacted to `[REDACTED:PHONE]`.
3. **Authentication & API Secrets**:
   - Matches Bearer tokens, JWT tokens (`eyJ...`), Groq/OpenAI API keys (`gsk-...`, `sk-...`).
   - Automatically redacted to `[REDACTED:TOKEN]`.
4. **Email Addresses**:
   - Automatically redacted to `[REDACTED:EMAIL]`.
5. **Raw Contract Text Invariant**:
   - Raw user documents and contracts must **never** be logged at `info` level.
   - Only hashed representations (`ai_output_hash`) or truncated redacted snippets in `debug` level when `debug_capture: true` is explicitly enabled by an authorized administrator.
