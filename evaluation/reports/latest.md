# ⚖️ HAKMDAR Egyptian Legal AI — Offline Evaluation Report

- **Generated:** 2026-09-24T10:00:38.969Z
- **Total Scenarios Evaluated:** 57 (Legal: 48, OOD Controls: 9)
- **Overall Suite Status:** ✅ **PASSED ALL THRESHOLDS**

## 1. Key Evaluation Metrics vs Targets

| Metric | Baseline Target | Achieved Score | Status |
|---|---|---|---|
| **Guard Precision** (Legal vs OOD) | ≥ 90.0% | **100.0%** (1) | ✅ PASS |
| **OOD Block Rate** (Zero-Leakage) | = 100.0% | **100.0%** (1) | ✅ PASS |
| **Retrieval Recall@5** (Article Anchors) | ≥ 80.0% | **98.5%** (0.9853) | ✅ PASS |
| **Guard Recall** (Legal Coverage) | ≥ 90.0% | **100.0%** | ✅ PASS |
| **Citation Verification Rate** | ≥ 90.0% | **100.0%** | ✅ PASS |
| **Disclaimer Trigger Rate** | ≥ 90.0% | **100.0%** | ✅ PASS |
| **Domain Classification Accuracy** | ≥ 85.0% | **100.0%** | ✅ PASS |

## 2. Category Breakdown

| Category | Total | Legal | OOD | Guard Acc | Avg Recall@5 | Domain Acc |
|---|---|---|---|---|---|---|
| **labor** | 16 | 16 | 0 | 100.0% | 96.4% | 100.0% |
| **commercial** | 9 | 9 | 0 | 100.0% | 100.0% | 100.0% |
| **civil** | 6 | 6 | 0 | 100.0% | 100.0% | 100.0% |
| **personal_status** | 6 | 6 | 0 | 100.0% | 100.0% | 100.0% |
| **contract** | 5 | 5 | 0 | 100.0% | 100.0% | 100.0% |
| **procedural** | 6 | 6 | 0 | 100.0% | 100.0% | 100.0% |
| **ood** | 9 | 0 | 9 | 100.0% | N/A | N/A |

## 3. Failures & Discrepancies

🎉 **Zero failures!** All scenarios satisfied guard, retrieval, citation, and disclaimer assertions.

---
*Report generated automatically by HAKMDAR Offline Evaluation Suite.*
