# ADR 010: LLMOps Architecture & Observability Stack

## Status
Accepted

## Date
2026-09-15

## Context
The Arabic Law RAG platform provides bilingual (Arabic/English) legal AI assistance in Egypt, serving both lay clients (`chat_fast`) and licensed attorneys (`case_deep`). Production-grade reliability, compliance with Egyptian legal data sovereignty, strict PII redaction (national ID, phone numbers), citation verification, and latency guarantees require a cohesive observability and telemetry architecture.

Specifically, the system requires:
1. **Tracing**: Span hierarchies representing multi-step agent graphs, RAG retrievals, guard evaluations, and streaming token generation.
2. **Metrics**: Real-time operational proxies (TTFT, latency, citations rejected, evidence score, request totals, error rates).
3. **Feedback Memory**: A durable learning loop where corrections and ratings refine instruction and preference memory without corrupting statutory truth.
4. **Model Routing**: Deterministic, cost-effective provider routing with primary and fallback endpoints validated on active infrastructure.
5. **Zero External SaaS Requirement in Development**: Unit and integration test suites must run completely offline without external network dependencies, while allowing seamless production export to OpenTelemetry collectors or LangSmith.

## Decision

### 1. Distributed Tracing Architecture
We implement an **Adapter Pattern** with composite dispatch (`lib/llmops/tracing/`):
- **`NoopTracer` (Default)**: Always available. Captures timing, attributes, and events in memory with zero network I/O. Ideal for local development, unit tests, and air-gapped environments.
- **`OtlpTracer` (OpenTelemetry)**: Activated when `OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) is set. Serializes spans into standard OTLP/JSON HTTP payloads (`/v1/traces`), batched asynchronously with background timers, non-blocking, fire-and-forget, failure-safe (never throws or crashes the application).
- **`LangSmithTracer`**: Activated when `LANGSMITH_API_KEY` (or `LANGCHAIN_API_KEY`) is set. Emits execution runs directly to the LangSmith REST API (`POST /runs`), fire-and-forget.
- **`CompositeTracer` (`getTracer()`)**: Automatically detects configured environment variables and fans out span lifecycle calls to all active providers.

#### Span Tree Conventions
- **`chat_fast`**:
  ```text
  arabic-law-rag.ai.run
  ├── ai.auth
  ├── ai.guard_pre
  ├── ai.retrieve (dense, bm25, rrf, rerank)
  ├── ai.memory.recall
  ├── ai.llm.synthesize
  ├── ai.guard_post
  └── ai.stream
  ```
- **`case_deep`**:
  ```text
  arabic-law-rag.ai.run
  ├── ai.guard_pre
  ├── ai.retrieve
  ├── ai.graph.statutory | cassation | procedural | contract
  ├── ai.graph.synthesize
  ├── ai.hitl (checkpoint / resume)
  ├── ai.guard_post
  └── ai.memory.write
  ```

### 2. Operational Metrics
We implement a zero-dependency in-process metric registry (`lib/llmops/metrics/`):
- Monotonically increasing counters (`emitCounter`) and multi-bucket latency/score histograms (`emitHistogram`).
- Dimensional labeling matching Prometheus / OpenTelemetry conventions (`mode`, `route`, `outcome`, `persona`).
- Export mechanism:
  - In-memory snapshot (`readMetricsSnapshot()`) for testing and local scraping endpoints.
  - Asynchronous background OTLP push (`/v1/metrics`) when `OTLP_ENDPOINT` is configured.
- Zero external libraries required: no heavyweight native binaries or runtime dependencies.

### 3. Feedback Memory Layer (LangMem Alignment)
We implement a native Supabase-backed, LangMem-compatible store (`ai_memory_items` and `ai_feedback`):
- **Tier Structure**:
  - **T0 (Episodic)**: Automatic capture of thumbs up/down, user corrections, and trace linkage.
  - **T1 (Instruction)**: Durable behavioral guidelines (e.g., "always ask court jurisdiction") requiring explicit attorney/admin approval before activation.
  - **T2 (Preferences)**: Stylistic and citation density preferences scoped to specific attorney IDs.
  - **T3 (Eval Gold Promotion)**: Verified QA pairs promoted into offline evaluation datasets.
  - **T4 (Statute Semantic)**: Authoritative statutory corpus facts. **Critical Invariant**: T4 is strictly populated via official corpus ingestion and never from model outputs or unverified feedback.
- *Detailed store schema, RLS policies, and promotion API contracts are specified in [ADR 011: Native Supabase LangMem Store](./011-langmem-memory-store.md).*

### 4. Validated Model Routing (Groq Production Catalog)
Model endpoints are registered in `lib/llmops/registry/models.ts` with strict functional separation:
- **`classify_guard`**:
  - Primary: `groq:qwen/qwen3.8-27b` (temp: 0.0)
  - Fallback: `groq:groq/compound-mini`
- **`synthesize_chat`**:
  - Primary: `groq:groq/compound-mini` (temp: 0.2)
  - Fallback: `groq:groq/compound`
- **`synthesize_case`**:
  - Primary: `groq:groq/compound-mini` (temp: 0.1)
  - Fallback: `groq:groq/compound-mini`
- **`judge_eval`**:
  - Primary: `groq:qwen/qwen3.8-27b` (temp: 0.0, overridable via `LLM_JUDGE_MODEL`)
  - Fallback: `groq:groq/compound-mini`
- **`voice_tts`**:
  - Primary: `groq:canopylabs/orpheus-arabic-saudi`
  - *Explicitly excluded from chat/judge roles*: Specialized Arabic speech-synthesis model for future audio responses.
- *Llama 3.3 70b is retired/excluded due to deprecation.*

## Consequences

### Positive
- **Deterministic Offline Testing**: Vitest and CI runs complete without requiring external SaaS credentials or network calls.
- **Standards Compliance**: Native compatibility with OpenTelemetry (Grafana, Jaeger, SigNoz, Datadog) and LangSmith.
- **Privacy by Design**: Sensitive PII (Egyptian national IDs, phone numbers, email addresses, Bearer tokens) is redacted prior to span emission or log output.
- **Zero Cost for Observability Baseline**: Development environments operate with zero infrastructure overhead.

### Negative / Trade-offs
- In-memory metrics reset across serverless cold starts or pod restarts unless an external OTLP collector drains metrics continuously.
- HTTP-based OTLP serialization introduces slight serialization overhead during batch flushes, mitigated by non-blocking timers and `unref()` handlers.
