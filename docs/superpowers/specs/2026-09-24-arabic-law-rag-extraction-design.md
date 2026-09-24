# Arabic-law-RAG Extraction Design

Date: 2026-09-24
Source: https://github.com/myler71/hakmdar (public, default branch `master`, HEAD `323f5dc`)
Target: new public repository `myler71/Arabic-law-RAG`, single commit authored by Marwan Ammar (myler71)

## Goal

Extract the AI stack and RAG system from HAKMDAR into a standalone public repository with all AI/LLMOps tests, review documents, and evaluation artifacts. Exclude the web application (pages, components, and non-AI CRUD APIs). The source repository is left untouched.

## Verified source baseline

- Source suite: 24 test files, 249 tests, all passing (Node 22, Vitest 4.1.10).
- Python sidecar `legalassist-ai/`: 4 tests passing (`pytest -q`, Python 3.11.9).
- Secret scan of tracked files: no real credentials. Only placeholder values (`your-supabase-anon-key`, `gsk_your_key_here`) and one live Supabase project URL in a web-only test (`tests/lib/supabase.test.ts`) that is not carried over.
- No personal case data. The corpus is codified Egyptian statute text (Labor Law 12/2003 plus a curated legal database).
- `npm audit` on the extracted manifest: one high-severity advisory in the `postcss` bundled with `next@15.x` (build-time CSS stringify XSS and sourceMappingURL file disclosure; GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q). The fix is a breaking `next@16.3.6+` upgrade, out of scope for an extraction. Exposure here is limited to build-time CSS tooling this repository does not use (no pages, no CSS pipeline). Documented in the README; consumers hosting the routes in a Next.js application should upgrade Next.js.

## Inclusion boundary (user-approved)

### Keep

| Path | Reason |
|---|---|
| `lib/ai/**` | RAG engine, legal guard, grounded generation, multi-agent graph, checkpoint store, rate limiter, Labor Law corpus |
| `lib/llmops/**` | Evaluation suites, judges, gates, LangMem feedback/memory, logging/redaction, metrics, tracing, run store, retention, flags, model registry |
| `lib/data/legalData.ts` | Curated Egyptian legal database used by RAG and `research`/`summarize` routes |
| `lib/data/lawyersData.ts` | Mock lawyer directory used by the `match` AI route |
| `lib/types.ts` | Shared legal/case domain types |
| `lib/supabase.ts` | SSR Supabase client used by every AI route for auth |
| `app/api/ai/**` | Tested HTTP surface: chat, SSE stream, feedback, case analyze/review, trace, match, research, summarize |
| `middleware.ts` | Session refresh, portal protection, offline demo fallback (tested by `security-zero.test.ts`) |
| `tests/api/{ai-chat-stream,case-deep,legal-guard,legal-rag,security-zero,evaluation-suite}.test.ts` | AI tests |
| `tests/llmops/**` (10 files) | LLMOps tests |
| `tests/setup.ts` | WebSocket polyfill required by Supabase client in tests |
| `evaluation/**` | 57-scenario suite, 16-scenario smoke suite, baselines, and committed reports |
| `scripts/{eval_compare_baseline.ts,eval_full.sh,eval_smoke.sh,retention_cleanup.sh}` | Evaluation and retention entry points |
| `supabase/migrations/20260915000000_llmops_runs_feedback.sql`, `20260915000001_llmops_memory.sql` | AI-only schema (see caveat) |
| `docs/AI_ENGINEERING_DEEP_TECHNICAL_REPORT.md`, `ARCHITECTURE_DEEP_DIVE.md`, `SESSION_RECAP_2026-09-15.md`, `llmops.md`, `runbook.md`, `challenges.md`, `adr/010-llmops-stack.md`, `adr/011-langmem-feedback.md`, `adr/012-eval-gates-ci.md`, `visuals/*.html` | AI architecture documents, ADRs, review board, and standalone diagrams |
| `docs/llmops-ci.yml` | CI copy retained for provenance (executable workflow is `.github/workflows/llmops-ci.yml`) |
| `.memory/{architecture_decisions,known_constraints,technical_debt}.md` | Architecture decision index, constraints, AI-relevant debt items (TD-12 through TD-16) |
| `legalassist-ai/` minus `ui/streamlit_app.py` and `run_ui.bat` | Python document-ingestion/RAG sidecar, its 4 tests, REVIEW.md, requirements, run_api.bat |
| `AGENTS.md` (rewritten) | Repo-specific instructions without the Next.js-generated block |

### Exclude

- `app/**/page.tsx`, `app/globals.css`, `app/favicon.ico`, `app/auth/**`, `app/dashboard`, `app/client/**`, `app/lawyer/**`
- `app/api/{cases,clients,documents,invoices,lawyers,time-entries}/**`
- `components/**`, `public/**`, `lib/context/**`, `lib/actions/**`, `lib/validations/**`, `lib/data/{initialCases,translations}.ts`, `lib/supabaseClient.ts`
- Tests for web CRUD: `tests/actions/**`, `tests/api/{cases,clients,clients-detail,documents,invoices,time-entries}.test.ts`, `tests/lib/supabase.test.ts` (contains a live Supabase project URL)
- `supabase/migrations/20260814*`, `20260816*` (practice-management schema, not AI)
- Docs for the web product: `docs/{architecture,api-endpoints,backend-testing,erd,migration-map,team-tasks,MVP_TICKETS_BACKLOG,TECHNICAL_ARCHITECTURE_REPORT}.md`, `docs/tickets/**`, `docs/visuals/*.visual-check.html` (archify harness output)
- Duplicate evaluation reports: `evaluation/reports/temp_inline_case_deep.*` (superseded; already listed in source `.gitignore`)
- Branding assets and any `CLAUDE.md` (symlink to AGENTS.md)

## Data-flow and module boundaries after extraction

The AI stack is framework-agnostic TypeScript with one adapter boundary:

```
HTTP (app/api/ai/*, middleware.ts)  ->  lib/ai (RAG, guard, graph)  ->  lib/llmops (obs, eval, memory)
                                                       |
                                                       +-> optional HTTP to Python sidecar via LEGAL_RAG_BASE_URL
```

- `lib/ai/legalRag.ts` loads the corpus with `fs`/`path` relative to the repo root; `lib/llmops/versions.ts` derives the corpus version from `lib/ai/knowledge/egyptian-labor-law.json`. Both keep working because the directory layout is preserved.
- Store modules (`runs/store.ts`, `feedback/api.ts`, `feedback/langmem/store.ts`, `promote.ts`) fall back to local JSONL under `.llmops/` when `NEXT_PUBLIC_SUPABASE_URL` is unset. This is the default offline path and is what the test suite exercises.
- Service name `hakmdar-next` in log/span/metric envelopes and the `hakmdar-dev` LangSmith project default are retained verbatim because tests assert on them (`tests/llmops/scaffold.test.ts:289`, `instrumentation.test.ts:54,99`).

## Known caveats carried into the README

1. **Python contract gap.** `lib/ai/legalRag.ts:467` calls `POST {LEGAL_RAG_BASE_URL}/api/search`. The FastAPI app (`legalassist-ai/app/api/main.py`) exposes `/documents`, `/chat`, `/analyze`, `/compare`, `/health` but not `/api/search`. The remote RAG path therefore always falls back to local hybrid search. The sidecar is included as-is per the extraction decision; the gap is documented, not fixed.
2. **Migration prerequisites.** The two LLMOps migrations reference `auth.users`, `public.profiles`, and `public.cases`, which live in the excluded practice-management schema. They apply only inside a hakmdar-compatible Supabase project. The JSONL fallback is the supported standalone persistence.
3. **Supabase auth is required for live mode.** The AI routes return 401 without a configured Supabase project and allow guest access only in demo mode (no credentials), matching the Secure-0 design.
4. **Next.js dependency.** The HTTP surface uses `next/server` and `@supabase/ssr`; the repository is an extraction, not a Next.js app. There is no `next build` script; CI runs lint/typecheck/tests/evals only.

## Git history

Fresh repository, one commit:

```
feat: extract Egyptian legal AI stack and RAG engine from hakmdar
```

Author and committer: Marwan Ammar (myler71). No history from other hakmdar contributors is carried over. The README credits the source repository and the hakmdar team.

## Verification gates

1. `npm install` succeeds; `npm run typecheck` and `npx vitest run` all exit 0 with the full retained suite passing (actual: 16 test files, 196 tests; the 8 dropped files are the web-CRUD tests, `tests/actions/**`, `tests/lib/supabase.test.ts`, and the AI route files not listed under "Keep").
2. `python -m pytest -q` inside `legalassist-ai/` passes 4/4.
3. `npx tsx evaluation/runner.ts` runs the 57-scenario suite; `npx tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json --gate smoke` runs the 16-scenario gate.
4. Secret scan of the new tree finds no real credentials.
5. `gh repo create myler71/Arabic-law-RAG --public --source . --remote origin --push` creates the public repository; remote tree matches the local tree; exactly one commit authored by Marwan Ammar.
