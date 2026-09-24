import fs from 'fs';
import path from 'path';
import { preGuard, postGuard } from '../lib/ai/safety/legalGuard';
import {
  retrieveLegalEvidence,
  verifyCitations,
  normalizeArabic,
  normalizeArabicNumbers,
  type LegalChunk,
} from '../lib/ai/legalRag';

export interface EvaluationScenario {
  id: string;
  category: string;
  question_ar: string;
  is_legal: boolean;
  domain: string | null;
  expected_article_anchor?: string[];
  expect_disclaimer?: boolean;
  notes?: string;
}

export interface ScenarioFailure {
  id: string;
  category: string;
  phase: 'guard' | 'domain' | 'retrieval' | 'citation' | 'disclaimer';
  reason: string;
  expected: string;
  actual: string;
}

export interface CategorySummary {
  category: string;
  total: number;
  legalCount: number;
  oodCount: number;
  guardAccuracy: number;
  domainAccuracy?: number;
  avgRecallAt5?: number;
}

export interface EvaluationReport {
  timestamp: string;
  total: number;
  legal_scenarios_count: number;
  ood_scenarios_count: number;
  guard_precision: number;
  guard_recall: number;
  ood_block_rate: number;
  retrieval_recall_at_5: number;
  citation_verify_rate: number;
  disclaimer_rate: number;
  domain_accuracy: number;
  passed: boolean;
  thresholds: {
    guard_precision_target: number;
    ood_block_rate_target: number;
    retrieval_recall_at_5_target: number;
  };
  categories: Record<string, CategorySummary>;
  failures: ScenarioFailure[];
}

/**
 * Checks whether an expected article anchor (e.g. "م 122", "122", "المادة 69")
 * is represented within a retrieved LegalChunk.
 */
export function matchAnchorInChunk(anchor: string, chunk: LegalChunk): boolean {
  if (!anchor || !chunk) return false;

  // 1. Extract numeric digits from anchor (e.g. "122" from "م 122")
  const anchorDigits = normalizeArabicNumbers(anchor).match(/\d+/g);
  if (anchorDigits && anchorDigits.length > 0) {
    const num = anchorDigits[0];

    // Match in article_number
    const artNorm = normalizeArabicNumbers(chunk.article_number || '');
    const artNums: string[] = artNorm.match(/\d+/g) || [];
    if (artNums.includes(num)) return true;

    // Match in id (e.g. labor-law-12-2003-art-122)
    const idNorm = chunk.id || '';
    if (idNorm.includes(num)) return true;

    // Match in title (e.g. المادة 122)
    const titleNorm = normalizeArabicNumbers(chunk.title || '');
    const titleNums: string[] = titleNorm.match(/\d+/g) || [];
    if (titleNums.includes(num)) return true;
  }

  // 2. Normalized text match in article_number, title, or summary
  const normAnchor = normalizeArabic(anchor);
  const normArt = normalizeArabic(chunk.article_number || '');
  const normTitle = normalizeArabic(chunk.title || '');

  return normArt.includes(normAnchor) || normTitle.includes(normAnchor);
}

/**
 * Executes the offline evaluation suite against all scenarios in evaluation/scenarios.json.
 */
export async function runEvaluation(scenariosPath?: string): Promise<EvaluationReport> {
  const resolvedPath =
    scenariosPath ||
    path.join(__dirname, 'scenarios.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Scenarios file not found at: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const scenarios = JSON.parse(raw) as EvaluationScenario[];

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('Scenarios file is empty or not an array');
  }

  // Verification tracking
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  let domainEvaluatedCount = 0;
  let domainCorrectCount = 0;

  let totalRetrievalScenarios = 0;
  let sumRecallAt5 = 0;

  let totalCitationTests = 0;
  let passedCitationTests = 0;

  let totalDisclaimerTests = 0;
  let passedDisclaimerTests = 0;

  const failures: ScenarioFailure[] = [];

  // Per-category tracking
  const categoryStats: Record<
    string,
    {
      total: number;
      legalCount: number;
      oodCount: number;
      guardCorrect: number;
      domainEvaluated: number;
      domainCorrect: number;
      recalls: number[];
    }
  > = {};

  for (const scenario of scenarios) {
    const cat = scenario.category || 'general';
    if (!categoryStats[cat]) {
      categoryStats[cat] = {
        total: 0,
        legalCount: 0,
        oodCount: 0,
        guardCorrect: 0,
        domainEvaluated: 0,
        domainCorrect: 0,
        recalls: [],
      };
    }
    const cStats = categoryStats[cat];
    cStats.total++;

    // --- 1. PRE-GUARD TEST ---
    const guardResult = preGuard(scenario.question_ar);

    if (scenario.is_legal) {
      cStats.legalCount++;
      if (guardResult.is_legal) {
        tp++;
        cStats.guardCorrect++;

        // Domain classification test
        if (scenario.domain) {
          domainEvaluatedCount++;
          cStats.domainEvaluated++;
          if (guardResult.domain === scenario.domain) {
            domainCorrectCount++;
            cStats.domainCorrect++;
          } else {
            failures.push({
              id: scenario.id,
              category: scenario.category,
              phase: 'domain',
              reason: `Domain classification mismatch: expected "${scenario.domain}", got "${guardResult.domain}"`,
              expected: scenario.domain,
              actual: guardResult.domain || 'null',
            });
          }
        }
      } else {
        fn++;
        failures.push({
          id: scenario.id,
          category: scenario.category,
          phase: 'guard',
          reason: `Legal scenario falsely rejected by preGuard as non-legal`,
          expected: 'is_legal=true',
          actual: `is_legal=false (reject: ${guardResult.reject_reason?.slice(0, 80)}...)`,
        });
      }
    } else {
      // OOD control scenario
      cStats.oodCount++;
      if (!guardResult.is_legal) {
        tn++;
        cStats.guardCorrect++;
      } else {
        fp++;
        failures.push({
          id: scenario.id,
          category: scenario.category,
          phase: 'guard',
          reason: `OOD control query erroneously classified as legal`,
          expected: 'is_legal=false',
          actual: `is_legal=true (domain: ${guardResult.domain})`,
        });
      }
    }

    // --- 2. RETRIEVAL RECALL@5 TEST ---
    let retrievedChunks: LegalChunk[] = [];
    if (scenario.is_legal) {
      const retrievalRes = await retrieveLegalEvidence(scenario.question_ar, { topK: 5 });
      retrievedChunks = retrievalRes.evidence || [];

      if (scenario.expected_article_anchor && scenario.expected_article_anchor.length > 0) {
        totalRetrievalScenarios++;
        let anchorsFound = 0;

        for (const anchor of scenario.expected_article_anchor) {
          const matched = retrievedChunks.some((chunk) => matchAnchorInChunk(anchor, chunk));
          if (matched) {
            anchorsFound++;
          }
        }

        const recall = anchorsFound / scenario.expected_article_anchor.length;
        sumRecallAt5 += recall;
        cStats.recalls.push(recall);

        if (recall < 0.5) {
          failures.push({
            id: scenario.id,
            category: scenario.category,
            phase: 'retrieval',
            reason: `Low retrieval recall@5: ${anchorsFound}/${scenario.expected_article_anchor.length} anchors retrieved`,
            expected: scenario.expected_article_anchor.join(', '),
            actual: retrievedChunks.map((c) => c.article_number || c.title).join(' | '),
          });
        }
      }
    }

    // --- 3. CITATION VERIFICATION SMOKE TEST ---
    if (scenario.is_legal && retrievedChunks.length > 0) {
      totalCitationTests++;
      const topChunk = retrievedChunks[0];
      if (topChunk) {
        const citationSmokeText = `تأسيساً على ما نصت عليه ${topChunk.article_number}: ${topChunk.title}`;
        const verifyRes = verifyCitations(citationSmokeText, retrievedChunks);

        if (verifyRes.verified.length > 0 && verifyRes.evidenceScore > 0) {
          passedCitationTests++;
        } else {
          failures.push({
            id: scenario.id,
            category: scenario.category,
            phase: 'citation',
            reason: `Citation verification smoke failed for top chunk: ${topChunk.article_number}`,
            expected: `verified >= 1`,
            actual: `verified=${verifyRes.verified.length}, unverified=${verifyRes.unverified.join(', ')}`,
          });
        }
      }
    }

    // --- 4. EXPECT DISCLAIMER PATH TEST ---
    if (scenario.expect_disclaimer) {
      totalDisclaimerTests++;

      // Assert that an ungrounded or empty-evidence draft triggers action='disclaimer' in postGuard
      const ungroundedText = 'استشارة عامة مجردة عن أي نصوص أو سوابق قضائية';
      const postGuardEmpty = postGuard(ungroundedText, []);

      const triggersDisclaimer =
        postGuardEmpty.action === 'disclaimer' &&
        postGuardEmpty.evidence_score < 0.65 &&
        Boolean(postGuardEmpty.disclaimer);

      if (triggersDisclaimer) {
        passedDisclaimerTests++;
      } else {
        failures.push({
          id: scenario.id,
          category: scenario.category,
          phase: 'disclaimer',
          reason: `postGuard failed to trigger disclaimer on empty evidence`,
          expected: 'action=disclaimer, evidence_score < 0.65, disclaimer text present',
          actual: `action=${postGuardEmpty.action}, evidence_score=${postGuardEmpty.evidence_score}`,
        });
      }
    }
  }

  // Compute final aggregated metrics
  const total = scenarios.length;
  const legalCount = tp + fn;
  const oodCount = tn + fp;

  const guardPrecision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 1.0;
  const guardRecall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 1.0;
  const oodBlockRate = oodCount > 0 ? Number((tn / oodCount).toFixed(4)) : 1.0;
  const retrievalRecallAt5 =
    totalRetrievalScenarios > 0 ? Number((sumRecallAt5 / totalRetrievalScenarios).toFixed(4)) : 1.0;
  const citationVerifyRate =
    totalCitationTests > 0 ? Number((passedCitationTests / totalCitationTests).toFixed(4)) : 1.0;
  const disclaimerRate =
    totalDisclaimerTests > 0 ? Number((passedDisclaimerTests / totalDisclaimerTests).toFixed(4)) : 1.0;
  const domainAccuracy =
    domainEvaluatedCount > 0 ? Number((domainCorrectCount / domainEvaluatedCount).toFixed(4)) : 1.0;

  // Threshold requirements: guard_precision >= 0.9, ood_block_rate = 1.0, retrieval_recall@5 >= 0.8
  const guardPrecisionPassed = guardPrecision >= 0.9;
  const oodBlockPassed = oodBlockRate === 1.0;
  const retrievalRecallPassed = retrievalRecallAt5 >= 0.8;
  const allPassed = guardPrecisionPassed && oodBlockPassed && retrievalRecallPassed;

  // Build category summaries
  const categories: Record<string, CategorySummary> = {};
  for (const [k, v] of Object.entries(categoryStats)) {
    const avgRecall =
      v.recalls.length > 0
        ? Number((v.recalls.reduce((a, b) => a + b, 0) / v.recalls.length).toFixed(4))
        : undefined;

    const domainAcc =
      v.domainEvaluated > 0
        ? Number((v.domainCorrect / v.domainEvaluated).toFixed(4))
        : undefined;

    categories[k] = {
      category: k,
      total: v.total,
      legalCount: v.legalCount,
      oodCount: v.oodCount,
      guardAccuracy: Number((v.guardCorrect / v.total).toFixed(4)),
      domainAccuracy: domainAcc,
      avgRecallAt5: avgRecall,
    };
  }

  const report: EvaluationReport = {
    timestamp: new Date().toISOString(),
    total,
    legal_scenarios_count: legalCount,
    ood_scenarios_count: oodCount,
    guard_precision: guardPrecision,
    guard_recall: guardRecall,
    ood_block_rate: oodBlockRate,
    retrieval_recall_at_5: retrievalRecallAt5,
    citation_verify_rate: citationVerifyRate,
    disclaimer_rate: disclaimerRate,
    domain_accuracy: domainAccuracy,
    passed: allPassed,
    thresholds: {
      guard_precision_target: 0.9,
      ood_block_rate_target: 1.0,
      retrieval_recall_at_5_target: 0.8,
    },
    categories,
    failures,
  };

  // Write reports to evaluation/reports/
  const reportsDir = path.join(path.dirname(resolvedPath), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const jsonReportPath = path.join(reportsDir, 'latest.json');
  fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2), 'utf-8');

  const mdReportPath = path.join(reportsDir, 'latest.md');
  const mdContent = generateMarkdownReport(report);
  fs.writeFileSync(mdReportPath, mdContent, 'utf-8');

  return report;
}

/**
 * Generates human-readable Markdown evaluation report summary.
 */
export function generateMarkdownReport(report: EvaluationReport): string {
  let md = `# ⚖️ HAKMDAR Egyptian Legal AI — Offline Evaluation Report\n\n`;
  md += `- **Generated:** ${report.timestamp}\n`;
  md += `- **Total Scenarios Evaluated:** ${report.total} (Legal: ${report.legal_scenarios_count}, OOD Controls: ${report.ood_scenarios_count})\n`;
  md += `- **Overall Suite Status:** ${report.passed ? '✅ **PASSED ALL THRESHOLDS**' : '❌ **FAILED THRESHOLDS**'}\n\n`;

  md += `## 1. Key Evaluation Metrics vs Targets\n\n`;
  md += `| Metric | Baseline Target | Achieved Score | Status |\n`;
  md += `|---|---|---|---|\n`;
  md += `| **Guard Precision** (Legal vs OOD) | ≥ ${(report.thresholds.guard_precision_target * 100).toFixed(1)}% | **${(report.guard_precision * 100).toFixed(1)}%** (${report.guard_precision}) | ${report.guard_precision >= report.thresholds.guard_precision_target ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **OOD Block Rate** (Zero-Leakage) | = ${(report.thresholds.ood_block_rate_target * 100).toFixed(1)}% | **${(report.ood_block_rate * 100).toFixed(1)}%** (${report.ood_block_rate}) | ${report.ood_block_rate === report.thresholds.ood_block_rate_target ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **Retrieval Recall@5** (Article Anchors) | ≥ ${(report.thresholds.retrieval_recall_at_5_target * 100).toFixed(1)}% | **${(report.retrieval_recall_at_5 * 100).toFixed(1)}%** (${report.retrieval_recall_at_5}) | ${report.retrieval_recall_at_5 >= report.thresholds.retrieval_recall_at_5_target ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **Guard Recall** (Legal Coverage) | ≥ 90.0% | **${(report.guard_recall * 100).toFixed(1)}%** | ${report.guard_recall >= 0.9 ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **Citation Verification Rate** | ≥ 90.0% | **${(report.citation_verify_rate * 100).toFixed(1)}%** | ${report.citation_verify_rate >= 0.9 ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **Disclaimer Trigger Rate** | ≥ 90.0% | **${(report.disclaimer_rate * 100).toFixed(1)}%** | ${report.disclaimer_rate >= 0.9 ? '✅ PASS' : '❌ FAIL'} |\n`;
  md += `| **Domain Classification Accuracy** | ≥ 85.0% | **${(report.domain_accuracy * 100).toFixed(1)}%** | ${report.domain_accuracy >= 0.85 ? '✅ PASS' : '❌ FAIL'} |\n\n`;

  md += `## 2. Category Breakdown\n\n`;
  md += `| Category | Total | Legal | OOD | Guard Acc | Avg Recall@5 | Domain Acc |\n`;
  md += `|---|---|---|---|---|---|---|\n`;

  for (const cat of Object.values(report.categories)) {
    const recallStr = cat.avgRecallAt5 !== undefined ? `${(cat.avgRecallAt5 * 100).toFixed(1)}%` : 'N/A';
    const domainStr = cat.domainAccuracy !== undefined ? `${(cat.domainAccuracy * 100).toFixed(1)}%` : 'N/A';
    md += `| **${cat.category}** | ${cat.total} | ${cat.legalCount} | ${cat.oodCount} | ${(cat.guardAccuracy * 100).toFixed(1)}% | ${recallStr} | ${domainStr} |\n`;
  }

  md += `\n## 3. Failures & Discrepancies\n\n`;
  if (report.failures.length === 0) {
    md += `🎉 **Zero failures!** All scenarios satisfied guard, retrieval, citation, and disclaimer assertions.\n`;
  } else {
    md += `Found **${report.failures.length}** failure(s):\n\n`;
    for (const f of report.failures) {
      md += `- **[${f.phase.toUpperCase()}] Scenario ${f.id} (${f.category}):** ${f.reason}\n`;
      md += `  - *Expected:* \`${f.expected}\`\n`;
      md += `  - *Actual:* \`${f.actual}\`\n`;
    }
  }

  md += `\n---\n*Report generated automatically by HAKMDAR Offline Evaluation Suite.*\n`;
  return md;
}

// CLI entry point
if (require.main === module || process.argv[1]?.endsWith('runner.ts')) {
  console.log('🚀 Starting HAKMDAR Egyptian Legal AI Offline Evaluation Suite...\n');
  runEvaluation()
    .then((report) => {
      console.log('📊 Evaluation Results Summary:');
      console.log(`   - Total Scenarios: ${report.total} (${report.legal_scenarios_count} Legal, ${report.ood_scenarios_count} OOD)`);
      console.log(`   - Guard Precision: ${(report.guard_precision * 100).toFixed(1)}% (Target: >= ${(report.thresholds.guard_precision_target * 100).toFixed(0)}%)`);
      console.log(`   - OOD Block Rate:  ${(report.ood_block_rate * 100).toFixed(1)}% (Target: = ${(report.thresholds.ood_block_rate_target * 100).toFixed(0)}%)`);
      console.log(`   - Retrieval Recall@5: ${(report.retrieval_recall_at_5 * 100).toFixed(1)}% (Target: >= ${(report.thresholds.retrieval_recall_at_5_target * 100).toFixed(0)}%)`);
      console.log(`   - Citation Verify Rate: ${(report.citation_verify_rate * 100).toFixed(1)}%`);
      console.log(`   - Disclaimer Rate: ${(report.disclaimer_rate * 100).toFixed(1)}%`);
      console.log(`   - Domain Accuracy: ${(report.domain_accuracy * 100).toFixed(1)}%`);
      console.log(`   - Failures Count: ${report.failures.length}`);
      console.log(`\n📁 Reports written to:`);
      console.log(`   - evaluation/reports/latest.json`);
      console.log(`   - evaluation/reports/latest.md`);

      if (!report.passed) {
        console.error('\n❌ Evaluation failed target thresholds.');
        process.exit(1);
      } else {
        console.log('\n✅ All evaluation criteria and target thresholds PASSED!');
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('\n💥 Evaluation runner crashed:', err);
      process.exit(1);
    });
}
