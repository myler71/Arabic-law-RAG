# Arabic-law-RAG — Agent Instructions

This repository is a standalone AI/RAG engine for Egyptian law, extracted from a larger legal-practice application. It is a library plus a thin Next.js route surface; it is not a deployable Next.js application (no pages, no `next build`).

## Ground rules

- The corpus is authoritative codified law. Never fabricate article numbers; `lib/ai/safety/legalGuard.ts` is the enforcement point.
- All core paths must run offline. Do not add required cloud calls to `lib/ai` or `lib/llmops`.
- Telemetry identity is `arabic-law-rag`: `service: 'arabic-law-rag'` in log/span/metric envelopes, the `arabic-law-rag.ai.run` span root, the `arabic-law-rag.llmops` instrumentation scope, and the `x-arabic-law-rag-demo-mode` middleware header. Tests assert on these; change them together or not at all.
- Do not add test files that assert implementation details (field copies, wiring, source text). Tests must assert observable behavior.
- Run `npm test`, `npm run typecheck`, and `npm run eval` before claiming completion.

## Layout

- `lib/ai/` — RAG engine, legal guard, grounded generation, multi-agent graph, checkpoint store
- `lib/llmops/` — evaluation, judges, gates, memory, logging, metrics, tracing, stores
- `app/api/ai/` — HTTP/SSE adapters (chat, stream, feedback, analyze, review, trace, match, research, summarize)
- `evaluation/` — 57-scenario suite, 16-scenario smoke suite, baselines, reports
- `legalassist-ai/` — optional Python document-ingestion sidecar (no Streamlit UI)
- `docs/adr/` — architecture decision records
- `docs/superpowers/` — extraction design spec and implementation plan
