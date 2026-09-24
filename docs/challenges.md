# Arabic Law RAG Review Board: Active & Resolved Challenges

## 🔥 CHALLENGE 01 — Unauthenticated AI Routes & Mock Keyword Simulation
**Severity:** Blocker  
**Phase:** Phase 0 / Phase 1  
**Category:** Security & Architecture  

**What I found:**
- Evidence: `app/api/ai/chat/route.ts` lacks any `getUser()` or session verification. If an LLM endpoint is attached, it functions as an open proxy. It defaults to a hardcoded 10-item mock dictionary (`EGYPTIAN_COMPREHENSIVE_LEGAL_DATABASE`).
- Current plan says: Production Egyptian Legal AI platform.
- Reality / better option: Require authentication on all `/api/ai/*` routes and wire into the real hybrid local RAG service.

**Recommendation:** Implement Secure-0 auth gate and rate limiting immediately before wiring real LLM pipelines.  
**Decision:** Accepted.

---

## 🔥 CHALLENGE 02 — AppContext Misuse as In-Memory Source of Record
**Severity:** High  
**Phase:** Phase 0 / Phase 5  
**Category:** Architecture & Data Integrity  

**What I found:**
- Evidence: `lib/context/AppContext.tsx` (~513 LOC) initializes mock guest users (`DEFAULT_CLIENT_USER` / `DEFAULT_LAWYER_USER`) and manages cases in client memory. API write failures leave fabricated cases in local state.
- Reality: Database integrity and cross-user case synchronization fail if AppContext is treated as SoR.

**Recommendation:** Restrict `AppContext` to UI presentation state (theme, lang, toasts). All case mutations and fetches must run through server actions or authenticated API endpoints.  
**Decision:** Accepted.

---

## 🔥 CHALLENGE 03 — Fake TTFT vs True Real-Time Streaming
**Severity:** High  
**Phase:** Phase 0 / Phase 3  
**Category:** Performance & DX  

**What I found:**
- Evidence: Ticket HKM-AI-01 specifies $\le 800\text{ms}$ TTFT streaming, but `app/api/ai/chat/route.ts` and `app/client/ai-chat/page.tsx` use blocking JSON requests.
- Reality: Complete JSON responses in Arabic can take 5–15 seconds, creating severe user drop-off.

**Recommendation:** Implement Server-Sent Events (SSE) with typed events (`metadata`, `token`, `citation`, `structured_summary`, `done`) and optimize early metadata emission.  
**Decision:** Accepted.

---

## 🔥 CHALLENGE 04 — Fully Offline Mandate & Model Selection
**Severity:** High  
**Phase:** Phase 0 / Phase 2  
**Category:** Architecture & Reliability  

**What I found:**
- Evidence: User explicitly instructed: "put all offline". The codebase contains references to external cloud endpoints (`KARNAK_API_URL`, `AI_INFERENCE_URL`, Gemini).
- Reality: True offline readiness requires zero cloud API egress.

**Recommendation:** Standardize local inference on Ollama (`qwen2.5:7b` / `qwen2.5:14b`) + local `BAAI/bge-m3` embeddings + rank-bm25 + FAISS. Zero outbound network dependency for core operations.  
**Decision:** Accepted.
