# ADR 012: Continuous Evaluation Gates & Regression Baselines in CI

## Status
Accepted

## Date
2026-09-15

## Context
Deploying changes to prompts, model providers, retrieval parameters, or agent workflows in the Egyptian legal domain presents distinct operational risks. A minor phrasing adjustment in a synthesis prompt or a change in retrieval top-k parameters can inadvertently cause:
1. **Citation Hallucinations**: Invented Egyptian Labor Law article numbers or misattributed court rulings.
2. **Out-of-Domain (OOD) Leakage**: Answering non-legal inquiries (e.g., medical diagnoses, financial scams, coding tasks) without polite refusal.
3. **Dispute Rejection Errors**: Mistakenly rejecting emotionally charged but valid client legal disputes (e.g., *"صاحب العمل طردني وحبس أوراقي"*).
4. **Latency & Cost Regressions**: Unmonitored token blowup or Time-to-First-Token (TTFT) exceeding SLA boundaries ($> 800\text{ms}$).

To prevent regressions, HAKMDAR requires automated, deterministic quality gates integrated directly into continuous integration (CI) pipelines, coupled with clear waiver profiles for pre-production infrastructure states.

---

## Decision

### 1. Multi-Tier Evaluation Strategy
We implement a tiered evaluation hierarchy balancing rapid feedback on pull requests with exhaustive nightly verification:

| Evaluation Suite | Frequency | Target Scope | Execution Time | Release Gate |
|---|---|---|---|---|
| **Smoke Eval (`smoke_suite.json`)** | Every Pull Request | 10–20 curated critical legal scenarios + OOD controls | $< 60\text{s}$ | **Hard Gate**: PR merge blocked on failure |
| **Full Eval (`scenarios.json`)** | Nightly on `main` / Pre-release | $\ge 50$ legal disputes across all domains + $\ge 15$ adversarial OOD controls | $2–5\text{min}$ | **Hard Gate**: Release blocked on failure |
| **Baseline Compare (`eval:compare`)** | Every PR & Nightly Run | Metric delta comparison vs `baseline-smoke.json` | Instantaneous | **Hard Gate**: Fails on negative metric drift |

### 2. Concrete Gate Thresholds

#### Smoke Gate (PR Merge Requirement)
- **OOD Refusal Rate**: $100\%$ (All `must_refuse` scenarios must receive polite refusal).
- **False Refusal on Emotional Legal Disputes**: $0$ on smoke suite (valid disputes must never be blocked).
- **Citation Precision**: $\ge 0.98$ (Every emitted article citation must be verified against retrieved chunks).
- **Hallucinated Citations**: $0$ (Strict zero-tolerance for non-existent legal articles).
- **Pipeline Hard Errors**: $0$ (No unhandled exceptions or 500 status codes).
- **TTFT**: Soft warning if $> 800\text{ms}$; fail if $> 3000\text{ms}$.

#### Regression Baseline Compare Thresholds
When comparing a test run against the accepted baseline (`evaluation/reports/baseline-smoke.json`):
1. **Citation Precision**: Must not drop $> 2$ percentage points ($\Delta \le -0.02$).
2. **Hallucination Count**: Any increase ($> 0$ new hallucinations) immediately fails CI.
3. **Guard OOD Recall**: Must not drop $> 1$ percentage point ($\Delta \le -0.01$).
4. **Retrieval Recall@5**: Must not drop $> 3$ percentage points vs baseline.

### 3. Waiver Profiles (Graceful Degradation)
To enable automated CI without requiring paid third-party API keys or external microservices, we define formal **Waiver Profiles**:

- **`pre_judge` Profile (Default in Open-Source / Offline CI)**:
  - When `GROQ_API_KEY` or `LLM_JUDGE_MODEL` is absent in the runner environment, rule-based scorers (guards, citations, schemas, latencies) execute at 100% rigor.
  - LLM-as-judge rubrics (`faithfulness_judge`, `completeness_judge`) are waived.
  - The generated report explicitly records `"gate": { "waiver": "pre_judge", "waived_scorers": ["faithfulness_judge", "completeness_judge"] }`.
  - The job exits with code `0` if all rule scorers pass.
- **`pre_rag` Profile**:
  - Used prior to provisioning external Python RAG sidecars.
  - Evaluates retrieval against the local in-process deterministic hybrid engine (`legalRag.ts`), verifying that core Egyptian Labor Law articles are correctly resolved.

### 4. CI Workflow Architecture (`.github/workflows/llmops-ci.yml`)
1. **Pull Request Workflow**:
   - `unit`: Runs ESLint, TypeScript compiler checks (`tsc --noEmit`), and Vitest unit tests.
   - `eval_smoke`: Runs `./scripts/eval_smoke.sh` using the `pre_judge` profile.
   - Artifact Upload: Saves `evaluation/reports/` JSON and Markdown reports as GitHub Actions artifacts for forensic review.
2. **Scheduled / Main Workflow**:
   - Runs full test suite + full evaluation (`./scripts/eval_full.sh`).
   - Runs baseline regression check (`scripts/eval_compare_baseline.ts`).
   - Alerts maintainers if quality drifts below thresholds.

---

## Consequences

### Positive
- **Guaranteed Legal Accuracy**: Zero tolerance for fabricated statutory articles is permanently defended by automated CI gates.
- **Developer Experience**: PR feedback arrives within 60 seconds without developer or CI billing friction.
- **Deterministic Offline CI**: PRs can be merged and validated without external API credentials using the `pre_judge` waiver profile.
- **Forensic Transparency**: Every eval run produces permanent JSON/Markdown report artifacts detailing scenario-by-scenario scores and trace IDs.

### Negative / Trade-offs
- Updating baselines requires committing new `baseline-smoke.json` files when legal enhancements intentionally change scores.
- Nightly full evaluation with LLM judges consumes API credits (mitigated by using efficient `groq/qwen3.8-27b` and `groq/compound-mini` endpoints).
