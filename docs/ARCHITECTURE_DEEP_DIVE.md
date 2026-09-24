# Arabic Law RAG AI Stack — Architecture & Design Deep Dive
**Companion to:** `docs/SESSION_RECAP_2026-09-15.md`
**Format:** Mermaid diagrams + stage-by-stage specifications
**Scope:** The complete data journey — upload → parse → index → retrieve → guard → generate → stream → feedback → memory → evaluate → observe → improve (the closed iteration loop)

---

## 0. The One Picture — Full System Topology

```mermaid
graph TB
    subgraph CLIENT["Browser (Arabic / RTL)"]
        UI_C["Client Portal<br/>ai-chat / dashboard / lawyers"]
        UI_L["Lawyer Portal<br/>ai-drafting / cases / profile"]
    end

    subgraph EDGE["Next.js 15 Edge"]
        MW["middleware.ts<br/>Session refresh + portal guards<br/>demo-mode header when offline"]
    end

    subgraph ROUTES["App Router API Routes"]
        R_CHAT["/api/ai/chat"]
        R_STREAM["/api/ai/chat/stream SSE"]
        R_RESEARCH["/api/ai/research"]
        R_SUM["/api/ai/summarize"]
        R_MATCH["/api/ai/match"]
        R_ANALYZE["/api/ai/cases/id analyze"]
        R_REVIEW["/api/ai/cases/id review"]
        R_TRACE["/api/ai/runs/id trace"]
        R_FEEDBACK["/api/ai/feedback"]
        R_CRUD["/api cases clients documents invoices time-entries"]
    end

    subgraph PIPELINE["AI Pipeline server-only"]
        RL["rateLimiter 30 req/min"]
        PG["preGuard classify + colloquial"]
        RET_NODE["legalRag retrieve"]
        GEN["grounded generator"]
        PG2["postGuard citation verify"]
        SSEEV["SSE typed events"]
    end

    subgraph GRAPH["case_deep Agent Graph"]
        CG["runCaseDeep graph"]
        CKPT["checkpointStore"]
    end

    subgraph LLMOPS["LLMOps layer"]
        CTX["context ids versions"]
        LOG["llmopsLogger JSON + redact"]
        MET["metrics emit"]
        RUNSTORE["runStore ai_runs"]
    end

    subgraph MEM2["Feedback memory"]
        FB["feedback API kinds"]
        LMEM["langMemStore T0-T4"]
    end

    subgraph EVAL2["Evaluation"]
        EVALRUN["smoke full case_deep runners"]
        GATESM["rule scorers + gates"]
        JUDGE["Groq LLM-as-judge"]
        BASELINE["baseline-smoke.json"]
    end

    subgraph STORE["Persistence"]
        DB2[("Supabase Postgres optional")]
        FILES[(".llmops jsonl offline")]
        CORPUS[("labor-law corpus 46 articles")]
    end

    UI_C --> MW
    UI_L --> MW
    MW --> R_CHAT
    MW --> R_STREAM
    MW --> R_RESEARCH
    MW --> R_SUM
    MW --> R_MATCH
    MW --> R_ANALYZE
    MW --> R_REVIEW
    MW --> R_TRACE
    MW --> R_FEEDBACK
    MW --> R_CRUD

    R_CHAT --> RL
    R_STREAM --> RL
    R_RESEARCH --> RL
    R_SUM --> RL
    R_MATCH --> RL
    RL --> PG
    PG --> RET_NODE["retrieve"]
    RET_NODE --> GEN
    GEN --> PG2
    PG2 --> SSEEV
    R_STREAM --> SSEEV
    R_ANALYZE --> CG
    R_REVIEW --> CG
    CG <--> CKPT

    PIPELINE --> CTX
    CG --> CTX
    CTX --> LOG
    CTX --> MET
    CTX --> RUNSTORE
    R_FEEDBACK --> FB
    FB --> LMEM
    LMEM --> HINT["### MEMORY HINTS non-authoritative"]
    HINT -.-> GEN

    EVALRUN --> GATESM
    JUDGE --> GATESM
    BASELINE -.-> GATESM
    GATESM --> REPORTS["evaluation/reports/"]
    GATESM -->|"fail"| ALERTQ["ai.alert.quality_drop"]

    RUNSTORE --> DB2
    RUNSTORE --> FILES
    FB --> DB2
    LMEM --> FILES
    RET_NODE --> CORPUS
```

**Reading guide:** the top row is the user journey; the middle is the single-request pipeline; the bottom is the three cross-cutting systems that make every request *observable, measurable, correctable, improvable, reversible* (LLMOps north star).

---

## 1. The Closed Iteration Loop (Start Here)

This is the master diagram — every path a piece of information can travel, from raw upload to measured improvement:

```mermaid
graph LR
    subgraph INGEST["1 · DATA IN"]
        U1["Statute corpus<br/>Law 12/2003 JSON seed"]
        U2["User document upload<br/>PDF/DOCX/TXT/MD"]
        U3["Feedback corrections<br/>from lawyer HITL"]
    end

    subgraph PROCESS["2 · PROCESS"]
        P1["parser<br/>PyMuPDF + OCR ara+eng"]
        P2["cleaner<br/>diacritics + alef normalize"]
        P3["chunker<br/>المادة/البند clause-aware"]
        P4["BGE-M3 / hybrid indexer"]
    end

    subgraph SERVE["3 · SERVE"]
        S1["preGuard<br/>is_legal? domain? colloquial map"]
        S2["hybrid retrieve<br/>lexical + dense"]
        S3["grounded generate<br/>article numbers from chunks only"]
        S4["postGuard<br/>citations ∈ retrieved set<br/>evidence < 0.65 → disclaimer"]
        S5["SSE stream<br/>metadata first ≤ TTFT target"]
    end

    subgraph LEARN["4 · LEARN"]
        L1["trace_id on every run"]
        L2["feedback: accept/correct/reject"]
        L3["T0 episodic memory"]
        L4["promotion: T1 instruction<br/>T3 eval-gold (approval gated)"]
    end

    subgraph PROVE["5 · PROVE"]
        E1["smoke eval (PR gate)"]
        E2["full 57-case eval"]
        E3["baseline compare<br/>-2pp cite = FAIL"]
        E4["LLM-judge nightly<br/>never blocks request"]
    end

    subgraph OBSERVE["5 · OBSERVE"]
        O1["structured logs<br/>trace_id on every event"]
        O2["spans: guard→retrieve→llm→post"]
        O3["metrics: TTFT p50/p95, cost,<br/>refuse rate, disclaimer rate"]
        O4["/api/ai/runs/[id]/trace<br/>citation forensics"]
    end

    U1 --> P1
    U2 --> P1
    P1 --> P2 --> P3 --> P4 --> S2
    U3 --> L2

    S1 --> S2 --> S3 --> S4 --> S5
    L1 --> L2 --> L3 --> L4
    L4 -.->|"new gold cases<br/>in eval suite"| E2
    L4 -.->|"instruction memory<br/>injected as hints"| S1

    S2 --> O2
    S4 -->|"evidence_score"| O3
    O1 --> E1
    E1 --> E3
    E2 --> E3
    E3 -->|"quality drop"| ALERT2["block merge / alert"]
    E3 -.->|"fix prompt/guard<br/>bump version"| S1
    S5 -->|"user reacts"| L1
    O4 -->|"bug found"| E2
```

**The loop:** data lands → becomes retrievable knowledge → answers stream guarded → humans correct → corrections become memory + eval gold → suites catch regressions → versions bump → the next answer is better. Every arrow above is implemented; none is aspirational.

---

## 2. Data Upload → Knowledge (Ingestion Detail)

```mermaid
flowchart TD
    A["Source document<br/>PDF / DOCX / TXT / MD<br/>statute JSON / scanned gazette"] --> B{"File type?"}
    B -->|".pdf"| C["PyMuPDF page-by-page<br/>keeps page numbers"]
    B -->|".docx"| D["python-docx<br/>paragraph join"]
    B -->|".txt/.md"| E["utf-8 read"]
    C --> F{"Extracted chars < 50?<br/>(scanned / image PDF)"}
    F -->|"Yes + ENABLE_OCR"| G["Tesseract OCR<br/>lang=ara+eng @2x"]
    F -->|"No"| H["raw page text"]
    G --> H
    D --> I["clean_text()<br/>nbsp→space, collapse runs"]
    E --> I
    H --> I
    I --> J{"CLAUSE_START regex match?<br/>المادة|البند|مادة|بند|Article|Clause<br/>Arabic AND western digits"}
    J -->|"yes"| K["split at clause boundaries<br/>article stays whole"]
    J -->|"no"| L["split on blank lines"]
    K --> M{"piece > 1400 chars?"}
    L --> M
    M -->|"yes"| N["sentence split .!؟؛<br/>greedy pack ≤ 1400"]
    M -->|"no"| O["keep as chunk"]
    N --> O
    O --> P["Chunk metadata<br/>chunk_id, doc_id, page,<br/>section, clause_id, article_number"]
    P --> Q["knowledge_chunks store<br/>+ BM25 sidecar + dense vectors"]
    Q --> R["rag_index_version bump<br/>(corpus-mtime hash)"]
```

**Stage invariants (current implementation truth):**
| Stage | File | Guarantee | Known limit (filed TD) |
|---|---|---|---|
| Parse | `legalassist-ai/app/ingestion/parser.py` (sidecar) | page fidelity on PDF | DOCX loses pages |
| Clean | `cleaner.py` | normalized copy for search, **raw preserved for citations** | — |
| Chunk | `chunker.py` | article never split mid-sentence; `clause_id C####` sequential | article *number* not yet mapped from heading (TD family) |
| Index | `lib/ai/legalRag.ts` (offline path) | in-process TF-IDF/BM25 + normalization; zero network | single-node FAISS file scale (TD-12 pgvector ADR) |

**Offline mandate:** steps marked with the sidecar (`legalassist-ai`) run when `LEGAL_RAG_BASE_URL` is configured; otherwise `lib/ai/legalRag.ts` performs the entire hybrid search in-process over `lib/ai/knowledge/egyptian-labor-law.json` (46 articles) + `lib/data/legalData.ts` encyclopedia. Absence of Python/Ollama/Supabase/Groq never degrades the product.

---

## 3. chat_fast — Full Request Lifecycle (Sequence)

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser (RTL)
    participant MW as middleware.ts
    participant S as /api/ai/chat/stream
    participant G as preGuard
    participant R as retrieveLegalEvidence
    participant GEN as grounded generator
    participant PG as postGuard
    participant RS as runStore
    participant L as llmopsLogger
    participant M as metrics emit

    B->>MW: POST /api/ai/chat/stream
    MW->>MW: session refresh / demo-mode check
    MW->>S: pass (with role)
    S->>L: ai.request.start {mode=chat_fast, message_len}
    S->>RS: startRun(versions: git_sha, prompt_version,<br/>model_id, rag_index_version, guard_version)
    S->>S: auth (401 if configured+no session) + checkRateLimit
    alt rate limited
        S->>L: ai.ratelimit.hit
        S-->>B: 429 + Retry-After + X-RateLimit-*
    else allowed
        S->>L: ai.auth.ok
        S->>G: preGuard(message)
        G->>L: ai.guard_pre.start
        G-->>S: {is_legal, domain, concepts, confidence}
        G->>L: ai.guard_pre.done {latency_ms}
        alt is_legal = false
            S->>L: ai.guard_pre.refuse {reject_reason}
            S-->>B: polite legal-only redirect (outcome=refuse)
        else legal
            S->>R: retrieveLegalEvidence(query, {domain})
            R->>L: ai.retrieve.start
            R-->>S: ranked chunks + scores
            R->>L: ai.retrieve.done {top_chunk_ids, empty, latency}
            S->>L: ai.stream.metadata_emitted {citations}
            S-->>B: SSE event: metadata (citations rendered immediately)
            loop per Arabic chunk
                GEN-->>S: text slice (no mid-word split)
                S-->>B: SSE event: token {text}
            end
            S->>M: ai_ttft_ms, ai_retrieve_ms
            S->>PG: postGuard(text, chunks)
            PG->>L: ai.guard_post.start
            PG-->>S: {verified, rejected, evidence_score, action}
            PG->>L: ai.guard_post.done
            alt evidence_score < 0.65
                S-->>B: SSE event: structured_summary + disclaimer text
            else verified
                S-->>B: SSE event: citation (chunk_id binds)
                S-->>B: SSE event: structured_summary
            end
            S->>M: ai_citations_emitted_total, ai_disclaimer_total
            S-->>B: SSE event: done [DONE] + timings payload
            S->>RS: finishRun {outcome, ttft_ms, t_total_ms, evidence_score}
            S->>L: ai.request.done {outcome, t_total_ms}
            B->>S: (disconnect aborts upstream generation if early)
        end
    end
    Note over S,RS: Store failures are try/caught — telemetry NEVER breaks the answer.
```

**Wire contract (verbatim):**
```
event: metadata   data: {"trace_id","domain","citations":[{law,article,chunk_id}]}
event: token      data: {"text":"وفقاً "}
event: citation   data: {"chunk_id","article_number","law_name"}
event: structured_summary  data: {"case_type","risk_level","recommended_action"}
event: done       data: [DONE] + {t_guard,t_retrieval,t_metadata_emit,ttft_ms,t_total}
```

**Stage thresholds:**
| Stage | Constant | File |
|---|---|---|
| Rate limit | 30/min per IP+user | `lib/ai/rateLimiter.ts` |
| Disclaimer trigger | evidence_score **< 0.65** | `legalGuard.postGuard` |
| TTFT warn / fail | > 800 ms warn, > 3000 ms hard fail (smoke gate) | `lib/llmops/eval/gates.ts` |
| Citation rule | every citation MUST exist in retrieved chunk metadata | `legalRag.verifyCitations` |

---

## 4. Hybrid Retrieval Internals

```mermaid
flowchart LR
    Q["Arabic query<br/>(maybe colloquial)"] --> N["normalize_arabic<br/>strip diacritics \\u064B-\\u065F<br/>إأآٱ→ا, ى→ي, lower"]
    N --> MAP["colloquial boost<br/>(فصلني, القائمة, مؤخر...)"]
    MAP --> DENSE["dense lexical-BM25<br/>TF-IDF term overlap"]
    MAP --> SPARSE["keyword synonyms<br/>per-article tags"]
    DENSE --> FUSE["score combine<br/>(RRF semantics k=60<br/>from legalassist lineage)"]
    SPARSE --> FUSE
    FUSE --> RR["rerank / re-order<br/>domain filter when present"]
    RR --> TOP["top_k chunks<br/>{chunk_id, article_number,<br/>law_name, text, score}"]
    TOP --> EMPTY{"empty or top score < τ?"}
    EMPTY -->|"yes"| DISC["disclaimer path<br/>(postGuard refuses claims)"]
    EMPTY -->|"no"| GROUND["grounded generator<br/>quotes article numbers<br/>from chunk metadata ONLY"]
```

- **Index separation (spec §5.2):** public statutes corpus vs. client documents (tenant/case ACL) — a statute question is *never* answered solely from another client's docs.
- **Chunk metadata minimum** (spec-compliant): `chunk_id, doc_type, law_name, law_year, article_number, clause_label, page, raw_text, cleaned_text, language, ocr_used, ocr_confidence, content_hash, tenant_id`.

---

## 5. Legal Domain Guard — Decision Table

```mermaid
flowchart TD
    IN["user query (Arabic, any register)"] --> PRE["preGuard classify"]
    PRE --> D{"is_legal?"}
    D -->|"no (cooking/python/sports/)<br/>weather/joke/medical"| REJ["polite redirect:<br/>أنا مساعد قانوني متخصص في<br/>القوانين المصرية فقط"]
    D -->|"yes"| MAP["colloquial → concepts + laws"]
    MAP --> M1["فصلني/طردني → فصل تعسفي<br/>قانون العمل 12/2003 م 122, 129"]
    MAP --> M2["شيك مرتجع/بدون رصيد → قانون<br/>التجارة 17/1999 + عقوبات 340/341"]
    MAP --> M3["مؤخر الصداق/نفقة →<br/>الأحوال الشخصية 25/1920"]
    MAP --> M4["مأجر ومبيخرجش/طرد للغصب →<br/>قانون الإيجار"]
    MAP --> M5["emotional stories (رافض يديني<br/>أوراقي) → is_legal=TRUE<br/>احتجاز مسوغات التعيين"]
    M1 & M2 & M3 & M4 & M5 --> RET["retrieve"]
    RET --> GEN["generate"]
    GEN --> POST["postGuard audit"]
    POST --> V{"citations all ∈ retrieved set?"}
    V -->|"no"| STRIP["strip fabricated numbers<br/>+ flag rejected"]
    STRIP --> EV
    V -->|"yes"| EV{"evidence_score ≥ 0.65?"}
    EV -->|"no"| DISC["standard disclaimer:<br/>لم يتم العثور على نص تشريعي صريح...<br/>مراجعة محامٍ متخصص"]
    EV -->|"yes"| PASS["deliver with citation badges"]
```

**Measured behavior (57-case grand suite):** guard precision **100%**, OOD block **100%**, emotional-legal false-reject **0**, disclaimer correctness **100%**.

---

## 6. case_deep — Multi-Agent HITL (Sequence)

```mermaid
sequenceDiagram
    autonumber
    participant L as Lawyer (ai-drafting UI)
    participant A as POST /cases/[id]/analyze
    participant X as runCaseDeep graph
    participant R as retrieve
    participant SP as specialists
    participant SYN as synthesize
    participant CK as checkpointStore
    participant RV as POST /cases/[id]/review
    participant FB as submitFeedback
    participant O as trace/metrics

    L->>A: analyze(case_id)
    A->>A: role check (403 client) + trace/context
    A->>X: initial state
    X->>X: guard_input (preGuard)
    X->>R: retrieve (hybrid)
    X->>SP: route_plan → run subset
    SP-->>X: findings + chunk_ids (no new articles)
    X->>SYN: assemble Arabic draft (Fus'ha)
    SYN->>O: ai.graph.node.done {latency, chunk_ids}
    X->>CK: persist checkpoint (status=awaiting_review)
    X-->>A: stop — no final_response yet
    A-->>L: {run_id, trace_id, checkpoint_id, draft}
    A->>O: ai.hitl.interrupt

    L->>L: edits draft (controlled textarea)
    L->>RV: {checkpoint_id, decision: approve|modify|reject, notes, modified_draft}
    RV->>CK: load checkpoint, resume finalize
    RV->>RV: guard_post on final (fabrication kill-switch)
    RV-->>L: final_response + citations
    RV->>O: ai.hitl.resume {action}
    RV->>FB: submitFeedback (kind per decision,<br/>persona=lawyer, trace_id) — non-blocking
    FB->>O: ai.feedback.received
```

**HITL is a product invariant:** formal case briefs are never client-visible without lawyer approve/modify/reject. Rejecting HITL requires an explicit Accepted Risk entry.

---

## 7. Feedback Memory (LangMem) — Tiers and the No-Poison Wall

```mermaid
flowchart TD
    U["user/lawyer reaction<br/>(UI thumb / correction /<br/>citation flag مصدر غير صحيح)"] --> API["POST /api/ai/feedback<br/>Zod-validated FeedbackWrite"]
    API --> OWN{"owns run? or lawyer<br/>on case?"}
    OWN -->|"no"| E403["403"]
    OWN -->|"yes"| DB[("ai_feedback<br/>(trace_id mandatory)")]
    API --> T0["T0 episodic item<br/>auto, every time"]
    T0 --> RECALL["recall(query, filters)<br/>token-overlap + recency +<br/>contradiction filter"]
    RECALL -->|"T1 instructions: always if<br/>active scope match"| INJ
    RECALL -->|"T2 preferences: per lawyer"| INJECT["buildMemoryPromptBlock<br/>### MEMORY HINTS<br/>(non-authoritative;<br/>do not invent articles)"]
    RECALL -->|"T0 only if similarity ≥ 0.5<br/>AND ≤30d AND corpus top score < 0.85"| INJECT
    INJECT -.->|"prompt context only"| GEN["generator"]
    INJECT -.->|"NEVER authorizes<br/>article numbers"| POSTGUARD["postGuard verifies against<br/>CORPUS retrieval ONLY"]
    DB --> CUR["curator (lawyer/admin)"]
    CUR -->|"explicit reason"| P1["promoteToInstruction<br/>→ T1 (validated_by)"]
    CUR -->|"confirm"| P2["promoteToEvalGold<br/>→ T3 dataset row"]
    P2 --> SUITE["eval suites include<br/>new gold before release"]
    DB -.->|"NEVER"| POISON["❌ statute semantic T4<br/>feedback never becomes law"]
```

**Hard wall:** the only writers to statute-truth (T4 / corpus) are corpus ingestion and admin import. Feedback can improve *behavior* (T1/T2) and *evaluation* (T3) — it can never rewrite *law*.

---

## 8. Evaluation System — Suites → Scorers → Gates → Alerts

```mermaid
flowchart TB
    subgraph DATA["Dataset package (evaluation/)"]
        D1["scenarios.json<br/>57: 48 legal + 9 OOD"]
        D2["smoke_suite.json<br/>16 curated"]
        D3["case_deep_suite.json<br/>9 (require_hitl)"]
        D4["expected_sources /<br/>expected_behavior schemas"]
        D5["promoted gold from feedback<br/>(T3) — same PR when feasible"]
    end

    subgraph RUN["Runner (offline-capable)"]
        R1["grand runner.ts<br/>guard + retrieval + citations"]
        R2["llmops/eval/runner.ts<br/>--gate smoke|full|case_deep"]
        R3["pre_judge profile<br/>(judge skipped, waiver recorded)"]
    end

    subgraph SCORERS["Rule scorers (deterministic)"]
        S1["guard_is_legal / guard_domain"]
        S2["colloquial_map"]
        S3["retrieval_recall@k (k=5)"]
        S4["citation_precision +<br/>hallucination_citation"]
        S5["disclaimer / refuse"]
        S6["ttft (warn>800 fail>3000)"]
        S7["safety_phrase / schema / hitl_path"]
    end

    subgraph JUDGE2["LLM-as-judge (nightly, never blocking)"]
        J1["faithfulness<br/>(context-only prompt)"]
        J2["completeness"]
        JQ["Groq qwen3.8-27b temp0<br/>fallback compound-mini<br/>skipped-safe"]
    end

    subgraph GATE["Gates + regression"]
        G1["smoke gates: OOD 100%,<br/>cite-prec ≥0.98, halluc=0, errors=0"]
        G2["full gates: recall@5 ≥0.85,<br/>OOD P/R ≥0.95, disclaimer ≥0.95"]
        G3["compareBaseline:<br/>cite -2pp FAIL · halluc ↑ FAIL ·<br/>OOD -1pp FAIL"]
        G4["baseline-smoke.json"]
    end

    D1 --> R1
    D2 --> R2
    D3 --> R2
    R1 & R2 --> SCORERS_OUT["per-case scores"]
    R1 & R2 --> JUDGE2
    SCORERS --> AGG["aggregates +<br/>reports/{ts}-{suite}.{json,md}"]
    JUDGE2 --> AGG
    AGG --> GATE{"gates pass?"}
    G4 -.-> G3
    GATE -->|"yes"| BASE["update baseline (explicit flag)"]
    GATE -->|"no"| QAL["ai.alert.quality_drop<br/>+ exit non-zero (blocks CI)"]
    G3 --> QAL
```

**Current measured aggregates (grand suite):** citation_verify_rate 1.00 · ood_block_rate 1.00 · guard_recall 1.00 · retrieval_recall@5 0.9853 · disclaimer_rate 1.00 · domain_accuracy 1.00 · 0 failures.

**Laws enforced:** "tests pass ≠ AI quality proven"; judge never replaces deterministic citation binding (L9); online judge never sits in the request path (L11).

---

## 9. Observability — How Any Answer Is Explained

```mermaid
flowchart LR
    REQ["AI request<br/>(any mode)"] --> CTX2["runLlmOpsContext<br/>trace_id · run_id · persona · mode"]
    CTX2 --> EV["typed log events<br/>(22-name catalog)<br/>one JSON line, PII redacted"]
    CTX2 --> SPANS["tracer spans<br/>guard→retrieve[.dense/.bm25/.rrf/.rrerank]→<br/>llm→guard_post→stream/hitl"]
    CTX2 --> RUN["runStore.startRun → finishRun<br/>(versions + timings + outcome)"]
    EV --> STDOUT["stdout JSON<br/>→ platform log drain"]
    SPANS --> OTLP["OTLP endpoint (optional)"]
    SPANS --> LS["LangSmith (optional)"]
    RUN --> DB2[("Supabase ai_runs<br/>or .llmops jsonl")]
    STDOUT --> FORENSICS
    DB2["trace endpoint"] --> FORENSICS["GET /api/ai/runs/{id}/trace<br/>= step timings + chunk_ids +<br/>guard scores + citations per claim"]
    RET2["retention: debug 14d ·<br/>runs 90d · feedback/gold ∞"] -.-> STDOUT
```

**Trace forensic invariant (L2):** every user-visible citation joins to retrieval `chunk_id`s; every AI request has a `trace_id` + terminal event (L1); every feedback row carries `trace_id` (L3).

**Retention:** debug payloads 7–14 d · aggregated metrics long · feedback + eval gold indefinite (product learning) · SQL policy shipped in `retention.ts` for service-role cron.

---

## 10. Versioned Artifacts — What Every Run Records

```mermaid
flowchart LR
    REQ["request enters /api/ai/*"] --> V["resolveVersions()"]
    subgraph VER["version bundle (immutable)"]
        V1["app_git_sha"]
        V2["prompt_version e.g. synth_chat@1.4.1"]
        V3["model_id e.g. groq/compound-mini"]
        V4["rag_index_version statutes-eg-labor-…"]
        V5["guard_version legal_guard@2.1.0"]
        V6["graph_version legal_graph@1.0.3"]
        V7["eval_suite_version"]
    end
    V --> RUNREC["every RunRecord + every log line"]
    RUNREC --> RB["rollback = flag revert to<br/>previous prompt/model route (L7.3)"]
```

**Model routing (live Groq catalog):**

| Role | Primary | Fallback |
|---|---|---|
| classify_guard | `qwen/qwen3.8-27b` (t0) | `groq/compound-mini` |
| synthesize_chat | `groq/compound-mini` (t0.2) | `groq/compound` |
| synthesize_case | `groq/compound-mini` (t0.1) | `groq/compound` |
| judge_eval | `qwen/qwen3.8-27b` (t0) | `groq/compound-mini` |
| voice_tts *(future, non-chat)* | `canopylabs/orpheus-arabic-saudi` | — |

External providers are **optional adapters** — absence degrades to the offline deterministic path, never to an outage.

---

## 11. Quality Gates → CI → Release (Change Management)

```mermaid
flowchart TD
    PR["pull request"] --> CI1["unit: lint + tsc + vitest (249)"]
    CI1 --> CI2["eval smoke (pre_judge profile)"]
    CI2 --> G{"gates pass?"}
    G -->|"no"| BLOCK["merge blocked<br/>or waiver ADR"]
    G -->|"yes"| MERGE["merge to main"]
    MERGE --> NIGHT["scheduled: full 57 + case_deep<br/>+ LLM-judge + baseline compare"]
    NIGHT --> DROP{"regression?"}
    DROP -->|"yes"| ALERT3["ai.alert.quality_drop<br/>rollback flag revert"]
    DROP -->|"no"| SHIP["deploy"]
    subgraph CHANGEBILL["what each change must show (L7.1)"]
        C1["prompt text → version bump + smoke + diff"]
        C2["guard threshold → ADR + full guard metrics"]
        C3["model swap → adapter test + smoke + cost/TTFT delta"]
        C4["embed/index → reindex + recall@k compare + ADR"]
        C5["memory inject → privacy review + no-cite-from-memory tests"]
    end
    CHANGEBILL -.-> NIGHT
```

---

## 12. Final Observation Layer — Dashboards & Alerts (definitions live in `docs/llmops.md`)

| Panel | Source metric | Alert condition |
|---|---|---|
| TTFT p50 / p95 | `ai_ttft_ms` histogram | p95 > 3 s for 15 m |
| Cost / day | `ai_cost_usd_total` | > budget |
| Refuse rate | `ai_guard_refuse_total` | spike |
| Disclaimer rate | `ai_disclaimer_total` | spike (corpus gap signal) |
| Citation reject rate | `ai_citations_rejected_total` | spike (hallucination signal) |
| Feedback reject rate | `ai_feedback_total{kind=rejected}` | spike (quality drop) |
| Retrieve empty rate | `ai_retrieve_empty_total` | spike (index staleness) |
| HITL latency | graph timings | reviewer-bottleneck |
| Eval suite pass | `ai_eval_suite_pass{suite}` | smoke fail on main = page |

**End-to-end property this design guarantees:** every AI answer is *observable* (trace_id everywhere), *measurable* (rule scorers + judge), *correctable* (feedback with trace_id), *improvable* (memory + gold promotion + regression gates), and *reversible* (versioned prompts/models/indexes + flag rollback) — measured from the first uploaded byte to the last dashboard panel.
