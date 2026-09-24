# Arabic-law-RAG Technical Debt Register

Owners are named agents/roles with target dates. Entries only — no prose.

Source: extracted from the Arabic Law RAG register. Items TD-01 through TD-11 (practice-management schema, UI, and web E2E) were dropped with the web application; TD-12 through TD-16 are retained.

| ID | Item | Source | Owner | Target date |
|----|------|--------|-------|-------------|
| TD-12 | pgvector / managed-vector ADR to remove single-node FAISS dependency at scale | Phase 6 | @myler71 | 2026-11-15 |
| TD-13 | Postgres/Redis production checkpoint store for case_deep HITL (current: in-memory) | ADR-004 follow-up | @myler71 | 2026-11-01 |
| TD-14 | `legalassist-ai/` git tracking decision (included in this extraction; `/api/search` contract gap open) | Phase 0 leftover | @myler71 | 2026-10-15 |
| TD-15 | LLM upgrade path for preGuard classifier (keyword-dictionary now, fast LLM JSON later) | Master prompt 5.1 | @myler71 | 2026-11-15 |
| TD-16 | Remaining `no-explicit-any` ESLint warnings in API routes | Build log | @myler71 | 2026-10-31 |
