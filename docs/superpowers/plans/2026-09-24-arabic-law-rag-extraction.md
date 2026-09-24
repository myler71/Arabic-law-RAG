# Arabic-law-RAG Extraction Implementation Plan

> **Status:** completed and superseded. This plan records the original extraction, executed on 2026-09-24. The extraction constraint that the source application's telemetry identifiers be kept "verbatim" applied only until the follow-up commit that removed that branding from every file, identifier, and artifact. The branding-removal commit also rewrote the brand-pinned test assertions onto the policy contract they verify.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the AI stack and RAG system from the source application into the new public repository `myler71/Arabic-law-RAG` with a single commit authored by Marwan Ammar.

**Architecture:** Fresh repository with a selected-path copy from a local clone of the source application, then config/docs rewrites so the retained AI surface (lib/ai, lib/llmops, app/api/ai, middleware, evaluation, scripts, tests, docs, legalassist-ai minus UI) builds, typechecks, tests, and evaluates without the web app.

**Tech Stack:** TypeScript 5.7, Next.js 15 request/response types, Supabase SSR client, Zod, Vitest 4, tsx, Python 3.11 (pytest, FastAPI, FAISS/BM25/Ollama).

**Spec:** `docs/superpowers/specs/2026-09-24-arabic-law-rag-extraction-design.md`

## Global Constraints

- The source clone is read-only; do not modify or commit anything in it.
- Target repository path: `C:/tmp/Arabic-law-RAG`; remote `myler71/Arabic-law-RAG` (public).
- Exactly one commit, author and committer Marwan Ammar (myler71).
- Keep `service: 'arabic-law-rag'` and the `arabic-law-rag-dev` LangSmith default verbatim; tests assert on them.
- Keep `x-arabic-law-rag-demo-mode` middleware header verbatim; `tests/api/security-zero.test.ts:73` asserts it.
- Do not fix the Python `/api/search` gap; document it in the README.
- No test file may be edited to make it pass; only drops are allowed for web-CRUD tests.

---

### Task 1: Initialize repository and copy retained paths

**Files:**
- Create: `C:/tmp/Arabic-law-RAG/.git/`
- Copy: paths listed under "Keep" in the spec

**Interfaces:**
- Consumes: `the source clone` working tree at `323f5dc`
- Produces: untracked extraction tree plus spec and plan documents

- [ ] **Step 1: Initialize the git repository**

Run: `git init -b main` in `C:/tmp/Arabic-law-RAG`
Expected: `Initialized empty Git repository`

- [ ] **Step 2: Copy retained paths**

Copy from `the source clone`:
```
app/api/ai
middleware.ts
lib/ai
lib/llmops
lib/data/legalData.ts
lib/data/lawyersData.ts
lib/types.ts
lib/supabase.ts
tests/setup.ts
tests/api/ai-chat-stream.test.ts
tests/api/case-deep.test.ts
tests/api/legal-guard.test.ts
tests/api/legal-rag.test.ts
tests/api/security-zero.test.ts
tests/api/evaluation-suite.test.ts
tests/llmops
evaluation/README.md
evaluation/runner.ts
evaluation/scenarios.json
evaluation/smoke_suite.json
evaluation/reports
scripts/eval_compare_baseline.ts
scripts/eval_full.sh
scripts/eval_smoke.sh
scripts/retention_cleanup.sh
.github/workflows/llmops-ci.yml
docs/AI_ENGINEERING_DEEP_TECHNICAL_REPORT.md
docs/ARCHITECTURE_DEEP_DIVE.md
docs/SESSION_RECAP_2026-09-15.md
docs/llmops.md
docs/runbook.md
docs/challenges.md
docs/llmops-ci.yml
docs/adr/010-llmops-stack.md
docs/adr/011-langmem-feedback.md
docs/adr/012-eval-gates-ci.md
docs/visuals/arabic-law-rag-ai-architecture.html
docs/visuals/arabic-law-rag-ai-dataflow.html
docs/visuals/arabic-law-rag-ai-lifecycle.html
docs/visuals/arabic-law-rag-ai-sequence.html
docs/visuals/arabic-law-rag-ai-stack.html
docs/visuals/arabic-law-rag-deep-workflow.html
.memory/architecture_decisions.md
.memory/known_constraints.md
.memory/technical_debt.md
legalassist-ai/.env.example
legalassist-ai/.gitignore
legalassist-ai/README.md
legalassist-ai/REVIEW.md
legalassist-ai/app
legalassist-ai/requirements.txt
legalassist-ai/run_api.bat
legalassist-ai/tests
.env.example
.gitignore
```

- [ ] **Step 3: Delete superseded evaluation reports**

Delete `evaluation/reports/temp_inline_case_deep.*` (10 files). These are duplicated `case_deep` outputs already ignored by the source `.gitignore`.

- [ ] **Step 4: Confirm no web paths remain**

Run: `git status --porcelain` and verify no path matches `app/(auth)`, `app/auth`, `app/client`, `app/lawyer`, `app/dashboard`, `app/api/(cases|clients|documents|invoices|lawyers|time-entries)`, `components`, `public`, `lib/context`, `lib/actions`, `lib/validations`, `lib/supabaseClient`, `tests/actions`, `tests/lib`.

Expected: clean.

---

### Task 2: Rewrite root configuration for the extracted surface

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `AGENTS.md`, `README.md`
- Modify: `.github/workflows/llmops-ci.yml`

**Interfaces:**
- Consumes: copied tree from Task 1
- Produces: installable, typecheckable, testable, lintable repository

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "arabic-law-rag",
  "version": "0.1.0",
  "private": false,
  "description": "Offline-first Egyptian legal AI stack: hybrid Arabic RAG, legal domain guard, multi-agent case graph, and LLMOps evaluation suite.",
  "license": "MIT",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "eval": "tsx evaluation/runner.ts",
    "eval:smoke": "tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json --gate smoke",
    "eval:compare": "tsx scripts/eval_compare_baseline.ts --current evaluation/reports/latest.json --baseline evaluation/reports/baseline-smoke.json",
    "retention": "tsx lib/llmops/retention.ts"
  },
  "dependencies": {
    "@supabase/ssr": "^0.5.2",
    "@supabase/supabase-js": "^2.49.1",
    "next": "^15.1.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.0",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx", "**/*.mts"],
  "exclude": ["node_modules", ".next", "out", "legalassist-ai"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

Keep dependency, test, build, env, LLMOps, and Python sections from the source `.gitignore`; drop the `/public` and `legalassist-ai/storage/` paths only if they no longer exist (they may stay harmless). Add `.DS_Store`, `*.pem`, `*.log`.

- [ ] **Step 5: Write `AGENTS.md`**

```md
# Arabic-law-RAG — Agent Instructions

This repository is the AI/RAG extraction of [the source application](https://github.com/myler71/the source application). It is a library plus a thin Next.js route surface; it is not a deployable Next.js application (no pages, no `next build`).

## Ground rules

- The corpus is authoritative codified law. Never fabricate article numbers; `lib/ai/safety/legalGuard.ts` is the enforcement point.
- All core paths must run offline. Do not add required cloud calls to `lib/ai` or `lib/llmops`.
- `service: 'arabic-law-rag'` in log/span/metric envelopes and `x-arabic-law-rag-demo-mode` in middleware are asserted by tests; do not rename without updating tests and the extraction spec.
- Do not add test files that assert implementation details (field copies, wiring, source text). Tests must assert observable behavior.
- Run `npm test`, `npm run typecheck`, and `npm run eval` before claiming completion.

## Layout

- `lib/ai/` — RAG engine, guard, grounded generation, multi-agent graph, checkpoint store
- `lib/llmops/` — evaluation, judges, gates, memory, logging, metrics, tracing, stores
- `app/api/ai/` — HTTP/SSE adapters (chat, stream, feedback, analyze, review, trace, match, research, summarize)
- `evaluation/` — 57-scenario suite, 16-scenario smoke suite, baselines, reports
- `legalassist-ai/` — optional Python document-ingestion sidecar (no Streamlit UI)
- `docs/adr/` — architecture decision records
```

- [ ] **Step 6: Write `README.md`**

Sections: title and one-paragraph description; provenance (extracted from the source application at `323f5dc`, single commit, original team credited); what is included/excluded; architecture summary (dual-mode engine, guard, LLMOps); install and test commands; evaluation commands and thresholds; Python sidecar section including the `/api/search` gap; Supabase migrations caveat; legal disclaimer; license.

- [ ] **Step 7: Update `.github/workflows/llmops-ci.yml`**

Replace `Run ESLint` step with nothing; replace `npm run lint` with `npm run typecheck`; rename workflow to `Arabic-law-RAG CI`; keep smoke and nightly eval jobs; the `unit` job must run `npm ci`, `npm run typecheck`, `npx vitest run`.

- [ ] **Step 8: Install and verify**

Run: `npm install --no-audit --no-fund` then `npm run typecheck`
Expected: typecheck exits 0.

---

### Task 3: Full verification

**Files:** none modified

- [ ] **Step 1: Run the TypeScript suite**

Run: `npx vitest run --reporter=dot`
Expected: all retained test files pass. Actual result: 16 test files, 196 tests, 0 failures.

- [ ] **Step 2: Run the Python suite**

Run: `python -m pytest -q` in `legalassist-ai`
Expected: `4 passed`.

- [ ] **Step 3: Run the evaluation suites**

Run: `npx tsx evaluation/runner.ts` and `npx tsx lib/llmops/eval/runner.ts evaluation/smoke_suite.json --gate smoke`
Expected: 57-scenario suite passes thresholds; 16-scenario smoke gate passes.

- [ ] **Step 4: Secret scan**

Run a regex scan for `sk-`, `gsk_`, `AIza`, `eyJ`, `ghp_`, `-----BEGIN`, and 14-digit Egyptian national IDs over tracked files.
Expected: only placeholders and test fixtures.

---

### Task 4: Commit, publish, verify remote

- [ ] **Step 1: Stage and commit**

Run: `git add -A && git commit -m "feat: extract Egyptian legal AI stack and RAG engine from the source application"`
Expected: one commit, author Marwan Ammar.

- [ ] **Step 2: Create the public repository and push**

Run: `gh repo create myler71/Arabic-law-RAG --public --source . --remote origin --push --description "Offline-first Egyptian legal AI stack: hybrid Arabic RAG, legal domain guard, multi-agent case graph, LLMOps evaluation suite"`
Expected: repository is public at `https://github.com/myler71/Arabic-law-RAG`.

- [ ] **Step 3: Verify remote**

Run: `gh api repos/myler71/Arabic-law-RAG --jq '{visibility,default_branch}'`, `git log --format='%an %ae %cn %ce'`, and a tree listing diff against local `HEAD`.
Expected: `PUBLIC`, branch `main`, exactly one commit by Marwan Ammar, identical tree.

- [ ] **Step 4: Watch CI**

Run: `gh run watch` on the first workflow run.
Expected: unit, smoke, and (on schedule only) nightly jobs pass.
