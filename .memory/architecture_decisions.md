# Architecture Decisions (ADR Index)

- **ADR-001**: Promote `legalassist-ai` as internal local RAG service for Egyptian legal parsing, BGE-M3 embeddings, and FAISS/BM25 hybrid retrieval.
- **ADR-002**: Two-tier AI execution: `chat_fast` (single streaming synthesizer with typed SSE) vs `case_deep` (LangGraph multi-agent + lawyer HITL).
- **ADR-003**: Secure-0 enforcement: mandatory Next.js middleware and route-level session verification on all `/api/ai/*` endpoints.
- **ADR-004**: LegalDomainGuard: pre-execution Egyptian colloquial mapping + post-execution citation auditing against retrieved chunk IDs.
