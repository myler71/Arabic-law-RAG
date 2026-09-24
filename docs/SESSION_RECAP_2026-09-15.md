# Arabic Law RAG — Full Session Recap
**Dates worked:** 2026-09-14 → 2026-09-15
**Scope:** Master Mission Prompt (`MASTER_MISSION_PROMPT.md` v4.0-ONE-FAT) + LLMOps Add-on (`LLMOPS_EVAL_LOGS_FEEDBACK_MEMORY_ADDON.md` v1.0-LLMOPS-ADDON)
**Repo:** `<source repository>` (git `the source repository`, baseline `master @ ea46529`) — **nothing committed; all work local**
**Execution model:** Main-thread architect + 17 delegated subagents (`task` workers), each verified independently by the main thread.

---

## 0. Final Verified State (last gates, run by main thread)

| Gate | Result |
|---|---|
| `npx vitest run` | **249 passed / 0 failed** across **24 files** (two consecutive clean runs for stability) |
| `npx tsc --noEmit` | **0 errors** |
| `npx next build` | **✓ Compiled successfully**, **0 ESLint errors** (warnings only), **31/31 static pages** |
| `npx tsx evaluation/runner.ts` (full, 57 scenarios) | guard precision **100%**, OOD block **100%**, retrieval recall@5 **98.5%**, citation verify **100%**, disclaimer **100%**, 0 failures |
| `npx tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json --gate smoke` | **exit 0** — 16 cases, 0 hallucinated citations, OOD refuse 100%, TTFT p50 ≈ 48 ms |
| `npx tsx scripts/eval_compare_baseline.ts` | **exit 0** — citation_precision / hallucination / OOD recall all within regression tolerances |
| **Live Groq judge call** | **faithfulness score 1.0**, grounded rationale, `skipped: false` |
| Test-baseline before session | 122 tests / 14 files |

**Delta: +127 tests, 0 TS errors, build gates re-enabled and passing.**

---

## 1. Phase 0 — Hygiene & Truth

| Item | Action | Files |
|---|---|---|
| README merge conflict (`<<<<<<< HEAD` at L1) | Resolved keeping project side (`@ours`); README de-Gemini-fied later (§ real stack) | `README.md` |
| `next.config.ts` build-lying flags | Removed `eslint.ignoreDuringBuilds` + `typescript.ignoreBuildErrors`; fixed `outputFileTracingRoot` to repo root (was `../../`) | `next.config.ts` |
| Env contract | Created documenting Supabase vars, `LEGAL_RAG_BASE_URL`/`LEGAL_RAG_SERVICE_KEY`, `OLLAMA_*`, `KARNAK_*`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `AI_MODE`, `ENABLE_AI_STREAMING` | `.env.example` |
| Memory scaffold | `.memory/known_constraints.md` (offline-first law, dual-mode, Secure-0-before-AI, SoR=Postgres), `.memory/architecture_decisions.md` (ADR-001..004) | `.memory/` |
| Docs scaffold | 4 grill challenges filed (unauthenticated AI routes, AppContext-as-DB, fake TTFT, offline mandate) | `docs/challenges.md`, `docs/migration-map.md` |

---

## 2. Phase 1 — Secure-0 (agents: `SecureZeroAgent`, `TenancyAuditAgent`)

| Item | Implementation |
|---|---|
| Route protection | `middleware.ts` (new): Supabase SSR cookie refresh; `/lawyer/*` → `/login?role=lawyer`, `/client/*` → `/login?role=client`; exemptions (`/`, `/login*`, `/register*`, `/auth*`, static, `/_next`); **offline/demo fallback** sets `x-arabic-law-rag-demo-mode: 1` when Supabase not configured |
| Rate limiting | `lib/ai/rateLimiter.ts` (new): in-memory sliding window, default **30 req/min**, `checkRateLimit(id)` → `{allowed, remaining, resetMs}`; wired into `/api/ai/chat` (429 + `Retry-After` + `X-RateLimit-*` headers) |
| AI auth | `/api/ai/chat`: `createServerClient(req)` session check → 401 when configured and no user; demo-mode guest allowed with audit |
| Tenancy (R-2) | `POST /api/cases`: verifies `client_id` belongs to lawyer → else **403** `العميل المحدد لا يتبع حساب المحامي الحالي`. `POST /api/time-entries`: verifies `case_id` ownership → **403**. Both also 401-offline-safe |
| Tests | `tests/api/security-zero.test.ts` (11) — 401s, rate-limit window, cross-tenant 403s, middleware smoke. Legacy `cases`/`time-entries` mocks updated for the new ownership pre-checks |

**R-1, R-2, R-3 materially closed on AI + critical write paths.**

---

## 3. Phase 2 — Legal RAG (agents: `LaborLawKnowledgeAgent`, `LegalRAGClientAgent`)

| Item | Implementation |
|---|---|
| Corpus | `lib/ai/knowledge/egyptian-labor-law.json` — **46 structured articles** of Labor Law 12/2003 (arts. 31–129): employment contracts, wages, leaves, discipline, dismissal grounds (م 69), notice (م 110–120), arbitrary-dismissal compensation (م 122), EOS gratuity (م 126–129). Each: id/law/book/chapter/article_number/title/text/Arabic keywords+colloquial synonyms |
| Retrieval | `lib/ai/legalRag.ts` — offline hybrid: Arabic normalization (diacritics strip, alef/yeh unify) + TF-IDF/BM25 term overlap + colloquial-synonym boost; optional remote RAG service if `LEGAL_RAG_BASE_URL` reachable; `verifyCitations()` distinguishes verified vs unverified citations with evidence score |
| Tests | `tests/api/legal-rag.test.ts` — 21 tests: retrieval on فصل تعسفي / شيك بدون رصيد / مهلة الإخطار + citation verification |

**100% in-process, zero network. Feeds guard + generation + eval.**

---

## 4. Phase 3 — Streaming (HKM-AI-01) + Domain Guard (HKM-AI-02) (agents: `SSEStreamAgent`, `DomainGuardAgent`, `ChatUIRefactorAgent`)

| Item | Implementation |
|---|---|
| SSE route | `app/api/ai/chat/stream/route.ts` (new): typed events **`metadata` → `token` → `citation` → `structured_summary` → `error` → `done`**; metadata emitted immediately post-retrieval (TTFT-critical); timings measured `t_guard / t_retrieval / t_metadata_emit / ttft_ms / t_total` in `done` payload; `req.signal` disconnect abort; grounded template generation from retrieved evidence — **no fabricated article numbers**; <0.65 evidence → disclaimer |
| Guard | `lib/ai/safety/legalGuard.ts` — `preGuard` (8 legal domains: labor/civil/commercial/criminal/personal_status/rent/administrative/constitutional; colloquial map: فصلني→م 122/129، القائمة→عقوبات 341، وصل أمانة→عقوبات 340، مؤخر الصداق→25/1920، مأجر ومبيخرجش→إيجار; emotional legal stories accepted) + `postGuard` (citation audit vs retrieved chunk metadata, evidence score, disclaimer fallback text). Wired into `/api/ai/chat` replacing regex-only check |
| UI | `app/client/ai-chat/page.tsx`: 3 duplicated fetch blocks → single `sendMessageToAI` with SSE-first + JSON fallback; RTL-safe token append via state; early citation badges; retry chip; localStorage sessions preserved |
| Tests | 8 stream tests + 18 guard tests (incl. "طردني ومش راضي يديني أوراقي" → is_legal=true; "اكتب لي كود بيثون" → refuse) |

---

## 5. Phase 4 — case_deep Multi-Agent + Lawyer HITL (agents: `CaseDeepGraphAgent`, `LawyerHITLUIAgent`)

| Item | Implementation |
|---|---|
| State machine | `lib/ai/agents/{types,graph,checkpoint}.ts` — `LegalGraphState` (trace/run ids, guard_pre, route_plan, retrieved_chunks, specialist_outputs w/ chunk_ids, draft, structured_summary, citations, guard_post, hitl{status,checkpoint_id}, timings); sequential nodes guard→route→retrieve→specialists (statutory/cassation/procedural/contract)→synthesize→**HITL interrupt**→finalize; in-memory checkpoint store (ADR-noted Postgres/Redis swap path) |
| Routes | `POST /api/ai/cases/[id]/analyze` (lawyer-only, 403 for client role) → `{run_id, trace_id, checkpoint_id, status:'awaiting_review', draft}`; `POST .../review` (approve/modify/reject + notes + modified_draft) → final_response; `GET /api/ai/runs/[id]/trace` (timings + chunk_ids forensics) |
| Lawyer UI | `app/lawyer/ai-drafting/page.tsx`: setTimeout-draft theater removed as primary path (Demo-labeled only); HITL review panel with editable textarea, approve/modify/reject → review endpoint; citation article badges; honest Arabic error states |
| Tests | `tests/api/case-deep.test.ts` — 10 tests incl. fabrication-strip via guard_post |

---

## 6. Phase 5 — Evaluation & Verification (agent: `EvalSuiteAgent`)

- `evaluation/scenarios.json` — **57 scenarios** (48 legal: labor 15+, commercial/cheque 6, rent 6, personal status 5, contracts 5, procedural 5; **9 OOD** controls incl. injection-like)
- `evaluation/runner.ts` — offline runner: preGuard → retrieve → citation-verify per scenario; writes `evaluation/reports/latest.{json,md}`
- Metrics achieved: guard_precision **1.00** (target ≥0.9), ood_block_rate **1.00**, retrieval_recall@5 **0.985** (target ≥0.8), citation_verify **1.00**, domain accuracy **1.00**
- `tests/api/evaluation-suite.test.ts` locks the suite

---

## 7. LLMOps Add-on — LLMOPS-A (agents: `LlmopsScaffoldAgent`, `FeedbackApiAgent`, `InstrumentAgent`, `TracingDocsAgent`)

| Item | Implementation |
|---|---|
| Scaffold | `lib/llmops/ids.ts` (trace/run/span ids + hashId), `context.ts` (AsyncLocalStorage request context), `versions.ts` (`resolveVersions()` → git_sha/prompt_version/model_id/rag_index_version/guard_version…), `registry/models.ts` (**user's Groq catalog**: judge `qwen/qwen3.8-27b`, synth `groq/compound-mini`/`groq/compound`, `canopylabs/orpheus-arabic-saudi` marked **voice_tts — TTS only, excluded from chat/judge**; `llama-3.3-70b-versatile` recorded retired/404) |
| Logging | `logging/logger.ts` (single facade, one JSON line per event, stdout, no console.log), `logging/redact.ts` (14-digit national IDs, Egyptian phones `01[0125]********`, emails, bearer tokens → `[REDACTED:type]`; deep-redact), `logging/events.ts` (full L3.3 catalog incl. graph/hitl/memory/eval/ingest/alert) |
| Instrumentation | All 7 AI routes: `runLlmOpsContext` wrap, `ai.request.start/done` (outcome ∈ success\|disclaimer\|refuse\|error\|interrupted), `ai.auth.ok/fail`, `ai.ratelimit.hit`, guard/retrieve/llm/guard_post boundaries, `ai.stream.metadata_emitted/first_token/done` (ttft_ms), `ai.hitl.interrupt/resume`; `runStore.startRun/finishRun` in finally (never breaks response); `X-Trace-Id` header everywhere |
| Stores + API | `lib/llmops/runs/store.ts` (Supabase `ai_runs` when configured, else `.llmops/dev_runs.jsonl`), `lib/llmops/feedback/{schema,api}.ts` (Zod FeedbackWrite, ownership verify, T0 memory write, `ai.feedback.received` log), `app/api/ai/feedback/route.ts` (POST 201 + GET by trace_id), migration `20260915000000_llmops_runs_feedback.sql` (RLS: own insert/read, lawyer case-scope read, service-role writes) |
| Docs | `docs/adr/010-llmops-stack.md` (OTel-optional + LangSmith-optional via env, native LangMem choice), `docs/llmops.md` operator guide (envelope, catalog, sinks, retention, PII) |

## 8. LLMOps-B — Wire Telemetry (agents: `TracingDocsAgent`, `MemoryInjectAgent`, `SmokeEvalAgent`, + main-thread race fixes)

| Item | Implementation |
|---|---|
| Tracing | `tracing/provider.ts` — `TracingProvider` with NoopTracer (default), OtlpTracer (`OTLP_ENDPOINT`, batched fire-and-forget), LangSmithTracer (`LANGSMITH_API_KEY`), composite; `tracing/spans.ts` chat_fast + case_deep span trees with spec-minimum attributes; **instrumentation calls mandatory, backend optional** |
| Metrics | `metrics/names.ts` + `emit.ts` — in-process counters/histograms (`ai_ttft_ms`, `ai_retrieve_ms`, `ai_citations_*`, `ai_feedback_total`, `ai_cost_usd_total`, …) + optional OTLP push; `readMetricsSnapshot()` |
| Memory | `ai_memory_items` migration (`20260915000001_llmops_memory.sql`), LangMem store (T0 putFeedback auto, T1 promoteToInstruction w/ approver, T3 promoteToEvalGold, deprecate/list), `feedback/inject.ts` policy (T1 always-if-scope, T2 per-lawyer, T0 only high-sim+recent+not-contradicted-by-corpus≥0.85; **strips any المادة-N patterns from memory hints**; `### MEMORY HINTS (non-authoritative)` prompt block) |
| Smoke eval | `lib/llmops/eval/{scorers,gates,runner}.ts` — 12 rule scorers (guard/domain/colloquial/recall@k/citation-precision/hallucination/disclaimer/refuse/ttft/schema/safety-phrase/hitl-path); smoke gates (OOD refuse 100%, emotional-legal false-reject 0, citation precision ≥0.98, hallucinations 0, errors 0, TTFT warn>800/fail>3000); `evaluation/smoke_suite.json` (16 cases); generator extracted to `lib/ai/generation/grounded.ts`; `baseline-smoke.json`; `scripts/eval_smoke.sh`, `scripts/eval_full.sh` |

## 9. LLMOps-C + LLMOPS-D (agents: `GraphSpansAgent`, `JudgeGatesAgent`, `FlagsRunbookAgent`)

| Item | Implementation |
|---|---|
| Graph spans | Every `runCaseDeep` node emits `ai.graph.node.start/done` + tracer spans; chunk_ids + evidence_score on retrieve/synthesize; review decision → feedback mapping (approve→accepted, modify→corrected+correction_text, reject→rejected; persona=lawyer; trace_id preserved; try/catch non-blocking) |
| Judge | `lib/llmops/eval/judge.ts` — Groq chat-completions, temp 0, `response_format=json_object`, **context-only system prompt** (forbids judge's own legal knowledge), fence-strip + brace-rescue parse, 15 s AbortController, `{skipped:true}` on missing key/parse fail/network error — **never in production request path** |
| Gates | Full profile runs faithfulness/completeness judges (sampling); `scripts/eval_compare_baseline.ts` + runner `--compare-baseline`: citation_precision drop >2pp → fail, hallucination ↑ → fail, OOD recall drop >1pp → fail; on fail logs `ai.alert.quality_drop` + exit 1; `--update-baseline` |
| Flags/Retention | `lib/llmops/flags.ts` (FF_AI_STREAMING / FF_AI_RAG_PRIMARY / FF_AI_LANGMEM_INJECT / FF_AI_CASE_DEEP / FF_AI_ONLINE_JUDGE_SAMPLE / FF_AI_DEMO_KEYWORD_FALLBACK default OFF), `lib/llmops/retention.ts` (debug payloads 14 d default, runs 90 d doc, feedback/gold indefinite; dry-run mode; `scripts/retention_cleanup.sh`) |
| CI/Docs | `.github/workflows/llmops-ci.yml` (PR: lint+tsc+vitest → eval smoke w/ pre_judge profile, artifact upload; scheduled full+compare on main), ADR-011 (LangMem-native), ADR-012 (eval gates), runbook LLMOps section (trace forensics, replay, promote, rotation, rollback) |

---

## 10. Groq Model Validation (user key)

| Model | Status | Verdict |
|---|---|---|
| `llama-3.3-70b-versatile` | **404** | Retired on this key — never registered |
| `qwen/qwen3.8-27b` | **200** | **Judge primary** (strict JSON, fast). Known risk: leaks outside-context law priors → mitigated by hard context-only judge prompt (live test correctly scored an unsupported answer 0.5) |
| `groq/compound-mini` | **200** | Judge fallback + synth primary (grounded rationale, score 0.9 on seed test) |
| `groq/compound` | registered | Synth fallback |
| `openai/gpt-oss-120b` | 200 but **empty content** | Unusable — excluded |
| `canopylabs/orpheus-arabic-saudi` | registered as `voice_tts` | **TTS only** — future Arabic voice output, excluded from chat/judge routing |

Key stored in `.env.local` (gitignored, verified via `git check-ignore`). **Security note: rotate the key — it transited chat plaintext.**

---

## 11. Bugs Diagnosed & Fixed by Main Thread (not subagents)

1. **Cross-worker store races (3×)** — parallel vitest workers shared `.llmops/dev_runs.jsonl` / `dev_feedback.jsonl` / `dev_memory_items.jsonl`; `finishRun` did read-modify-write **full-file rewrite** → clobbered other workers' appends. Fix: append-only `type:'finish'` records + `foldRunRecords()` (start+finish merge keyed `id|trace_id`), `RunRecordStore.useFile()`, `FeedbackStore.useFile()` (new), env overrides (`LLMOPS_RUNS_FILE`, `LLMOPS_FEEDBACK_FILE`), and per-worker `os.tmpdir()` isolation in `instrumentation/feedback/graph-spans` tests.
2. **Rate-limit test economics** — 31 sequential route invocations × (JSON logging + fs appends) exceeded the default 5 s test timeout post-instrumentation → per-test `timeout: 30_000`.
3. **React-compiler build errors (10)** — `set-state-in-effect`, `Date.now`/`Math.random` purity, state-derived var reassignment in SSE handler (`react-hooks/immutability`) in `ai-chat/page.tsx` + `ai-drafting/page.tsx` → fixed via lazy state init, module-scope id helpers, fresh-object updaters (agent `ReactCompilerFixAgent`, verified independently).
4. **13 TS errors** surfaced after re-enabling strict gates — `never[]` fallbacks, missing `summary` on `LegalCitation` maps, middleware narrowing/cookie typing, pre-existing `Navbar.tsx` `description` bug (→ `executiveSummary`).
5. **Legacy test mocks** pinned the *unprotected* insert path — updated to mock the new ownership pre-checks (`clients`/`cases` table-aware `from()` mocks).
6. **`BookOpen` missing import** (pre-existing landing-page 500) — fixed day one.
7. **Edit-tool range discipline** — repeatedly restored interface fields (`min_citation_precision`, `forbidden_phrases`) clobbered by adjacent-range edits; switched to pure insertions.

---

## 12. Verified Final Inventory

**Modified (12):** `.gitignore`, `README.md`, `next.config.ts`, 7 `app/api/ai/*` routes (chat, chat/stream, summarize, match, research, cases/[id]/analyze+review), `app/api/cases/route.ts`, `app/api/time-entries/route.ts`, `app/client/ai-chat/page.tsx`, `app/lawyer/ai-drafting/page.tsx`, `app/page.tsx`, `components/layout/Navbar.tsx`, `tests/api/cases.test.ts`, `tests/api/time-entries.test.ts`, `app/api/ai/runs/[id]/trace/route.ts`

**New (trees):**
- `lib/ai/` — `legalRag.ts` (hybrid offline retrieval + citation verify), `rateLimiter.ts`, `safety/legalGuard.ts`, `knowledge/egyptian-labor-law.json` (46 arts), `agents/` (LegalGraphState + checkpoint), `generation/grounded.ts`
- `lib/llmops/` — 28 files: ids, context, versions, logging (logger/redact/events), tracing (provider/spans), metrics (names/emit), registry (models), runs/store, feedback (schema/api/inject + langmem store/promote/retrieve), eval (scorers/gates/runner/judge + case_deep_suite.json), flags, retention, index barrels
- `app/api/ai/` — `chat/stream/`, `feedback/`, `cases/[id]/analyze+review/`, `runs/[id]/trace/`
- `middleware.ts`
- `evaluation/` — scenarios.json (57), smoke_suite.json, README, reports (baseline-smoke + latest + timestamped runs)
- `supabase/migrations/` — `20260915000000_llmops_runs_feedback.sql`, `20260915000001_llmops_memory.sql`
- `scripts/` — `eval_smoke.sh`, `eval_full.sh`, `eval_compare_baseline.ts`, `retention_cleanup.sh`
- `tests/` — `tests/llmops/` (10 files), `tests/api/` (security-zero, ai-chat-stream, case-deep, legal-guard, legal-rag, evaluation-suite)
- `docs/` — `runbook.md`, `llmops.md`, `challenges.md`, `migration-map.md`, `adr/010–012`, `llmops-ci.yml`
- `.memory/` — `known_constraints.md`, `architecture_decisions.md`, `technical_debt.md` (16 owned items w/ dates)
- `.github/workflows/llmops-ci.yml`, `.env.example`, `legalassist-ai/` (cloned earlier; still untracked sidecar)

---

## 13. Test Suite Composition (249 total)

| Suite | Files | Tests |
|---|---|---|
| API pre-existing (hardened) | 8 | 67 |
| Phase 1–4 feature tests (security-zero, stream, case-deep, guard, rag, eval-suite) | 6 | 80 |
| LLMOps (scaffold, instrumentation, feedback, tracing, memory, eval-runner, graph-spans, judge, flags, retention) | 10 | 102 |

## 14. Known Debt & Waivers (filed, not hidden)

`.memory/technical_debt.md` — TD-01…TD-16 with owners (@myler71) and target dates (2026-10-15 → 2026-11-15): case_status enum migration, lawyer_notes column, updated_at triggers, client RLS, invoice transactionality, composite indexes, AppContext shrink, docs/invoices UI decision, CI action wiring to real runs, Playwright E2E, real RLS integration tests, pgvector ADR, Postgres checkpoint store, legalassist-ai git tracking, LLM-based preGuard upgrade, remaining `no-explicit-any` warnings.

## 15. Two-Mode Architecture (final)

```
chat_fast   → middleware auth → rate limit → preGuard(colloquial map) → retrieveLegalEvidence(hybrid offline)
              → grounded generator (no fabricated articles) → postGuard(citation verify, <0.65 disclaimer)
              → SSE(metadata|token|citation|structured_summary|error|done) → runStore + logs + metrics
case_deep   → same entry → runCaseDeep graph → HITL checkpoint → lawyer review → finalize →
              review→feedback(T0) → trace forensics via /api/ai/runs/{id}/trace
eval        → smoke (PR gate) / full 57-case / case_deep suite / LLM-judge (nightly, never blocking)
```

**Everything runs 100% offline by default; Supabase and Groq are strictly optional adapters.**

---

**Visual walkthrough:** the full architecture, AI-stack data journey, evaluation, and observation loop are diagrammed in Mermaid in the companion doc [`docs/ARCHITECTURE_DEEP_DIVE.md`](./ARCHITECTURE_DEEP_DIVE.md) (12 diagrams: topology, closed iteration loop, ingestion, chat_fast sequence, retrieval internals, guard decision table, case_deep HITL sequence, memory no-poison wall, evaluation system, observability, versioning/rollback, CI gates).
