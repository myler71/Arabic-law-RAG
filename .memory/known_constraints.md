# HAKMDAR Known Constraints & Ground Truth Facts

## Core Laws & Architectural Truth
1. **Never fabricate law**: Article numbers, law titles, and court citations must be grounded in verified retrieval chunks.
2. **Local / Offline First**: All core capabilities must run locally without external cloud dependency (BGE-M3 local embeddings, FAISS, Ollama/local adapter, Egyptian legal database).
3. **Dual-Mode AI Architecture**:
   - `chat_fast`: Lightweight, single-synthesizer, token streaming via SSE (TTFT <= 800ms target). No multi-specialist fan-out.
   - `case_deep`: Multi-agent deep reasoning with Human-In-The-Loop (HITL) review for lawyers drafting formal briefs.
4. **Secure-0 Before Live AI**: All `/api/ai/*` routes must require valid authentication (`getUser()`) and rate limiting.
5. **No Dental EHR Carryover**: Only the generic LangGraph, HITL interrupt, and tracer patterns are ported from Ora AI. No dental ontologies, CNNs, or clinical schemas.
6. **SoR is PostgreSQL**: `AppContext` is strictly for client UI state (theme, language, transient toasts). It must never act as an in-memory database.
