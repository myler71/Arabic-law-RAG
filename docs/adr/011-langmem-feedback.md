# ADR 011: Native Supabase LangMem-Compatible Feedback Memory Store

## Status
Accepted

## Date
2026-09-15

## Context
The HAKMDAR legal AI platform serves both lay clients (`chat_fast`) and licensed Egyptian attorneys (`case_deep`). In legal workflows, attorney corrections and client ratings provide valuable signals for iterative system improvement. However, in the legal domain, incorporating user and attorney feedback into model memory carries profound risks:
1. **Corpus Poisoning Risk**: If unverified user corrections or model outputs are allowed to modify statutory legal knowledge, the system risks hallucinating non-existent articles, altered penalty terms, or overturned precedents.
2. **Operational Complexity**: External memory SaaS services introduce privacy concerns regarding attorney-client privilege, external cloud dependencies, and failure modes when operating offline.
3. **Developer Velocity**: In local development and automated CI pipelines, the memory layer must function deterministically without requiring external API keys or complex Python-only runtimes.

We require a structured memory architecture compatible with LangMem concepts (episodic, instruction, and semantic preference memory) while strictly preserving statutory integrity and data sovereignty under Egyptian legal norms.

---

## Decision

### 1. Architecture: Native Supabase Store Behind an Adapter Interface
We implement a **native Supabase PostgreSQL LangMem-compatible store** (`lib/llmops/feedback/langmem/store.ts`) conforming to the `LangMemStore` interface:
- **Interface Segregation**: The application code interacts exclusively with the TypeScript `LangMemStore` interface (`putFeedback`, `recall`, `promoteToInstruction`, `promoteToEvalGold`, `deprecate`).
- **Adapter Pattern**: An external LangMem library or microservice can be plugged in behind this interface in the future without modifying application routes or agents.
- **Dual-Mode Persistence**:
  - In production / staging with Supabase configured: Persists to PostgreSQL tables (`ai_feedback`, `ai_memory_items`) with Row Level Security (RLS) enforcement.
  - In local development / offline tests: Falls back to an in-memory append store, ensuring 100% test isolation and zero network dependencies.

### 2. Memory Tiers (T0 – T4)
We establish five distinct tiers of memory with strict access and promotion policies:

| Tier | Name | Contents | Write Policy | Read / Retrieval Policy |
|---|---|---|---|---|
| **T0** | **Episodic Feedback** | Thumbs up/down, user corrections, flagged bad citations, trace linkage | Automatic upon feedback submission (`POST /api/ai/feedback`) | Recalled by query similarity for recent sessions; non-authoritative |
| **T1** | **Instruction Memory** | Durable behavioral rules (e.g., "always ask court jurisdiction for labor claims") | **Requires explicit attorney/admin approval** (`POST /api/ai/feedback/:id/promote`) | Injected into system prompt when matching attorney or global scope |
| **T2** | **Semantic Preferences** | Attorney style preferences (concise vs elaborate, citation density) | Derived from consistent feedback or approved attorney settings | Scoped strictly to the specific `lawyer_id` |
| **T3** | **Eval Gold Promotion** | High-value corrected QA pairs promoted into regression datasets | Human or eval-curator confirmation | Exported to `evaluation/` datasets; evaluated in CI |
| **T4** | **Statute Semantic** | Authoritative statutory corpus facts (Labor Law 12/2003, Civil Code) | **Strictly via official legal gazette corpus ingestion** | Primary hybrid RAG index (`legalRag.ts` / vector DB) |

### 3. The No-Poison Invariant (Hard Law)
**Invariant L5.2 / L11.4**: *Tier T4 is completely disconnected from the feedback write path.*
- Feedback submissions, user comments, and attorney corrections **NEVER** write directly to the statutory knowledge base (T4).
- Feedback items can only progress to T1 (prompt instructions) or T3 (eval gold scenarios) through explicit, authenticated curation.
- Memory items cannot invent, alter, or authorize new statutory article numbers.

### 4. Memory Injection Policy in System Prompts (L5.6)
When assembling prompts for generation:
1. Primary legal context is retrieved strictly from the authoritative statutory RAG corpus (T4).
2. Recalled memory items (T1 instructions and T2 preferences) are injected into a dedicated, segregated prompt section:
   ```text
   ### AUTHORITATIVE LEGAL CONTEXT (Corpus)
   [Verified statutory articles from Labor Law 12/2003]

   ### USER / CASE FACTS
   [Client statement and dispute timeline]

   ### MEMORY HINTS (Non-Authoritative)
   [Attorney preference: Provide concise procedural breakdown]
   [Do not invent or cite statutory articles from memory hints]
   ```
3. Post-execution guardrails (`legalGuard.ts`) verify generated citations against **retrieved corpus chunks only**. Citations originating solely from memory hints are rejected and stripped.

---

## Consequences

### Positive
- **Zero Hallucinated Laws from Feedback**: Strict architectural isolation guarantees that user errors or adversarial prompt injection cannot corrupt the legal corpus.
- **Enterprise Multi-Tenancy**: Attorney preferences (T2) and case notes remain scoped to individual attorneys or law firms via PostgreSQL RLS.
- **Offline Determinism**: The entire memory and feedback loop is fully testable in Vitest without network access or paid API services.
- **Continuous Learning**: High-value corrections are systematically promoted to T3 eval datasets, preventing regressions in future releases.

### Negative / Trade-offs
- Vector similarity search for episodic memories requires PostgreSQL `pgvector` in production; local in-memory fallback uses lexical and tag-based filtering.
- Requires human review (licensed attorney or legal curator) to promote T0 episodic feedback to T1 or T3, preventing autonomous self-poisoning at the expense of automated ingestion.
