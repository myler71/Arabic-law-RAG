import {
  preGuard,
  postGuard,
  DEFAULT_REJECT_REASON,
} from '../safety/legalGuard';
import {
  retrieveLegalEvidence,
  normalizeArabic,
  normalizeArabicNumbers,
  type LegalChunk,
  type LegalCitation,
} from '../legalRag';
import type {
  LegalGraphState,
  SpecialistOutput,
  SpecialistFinding,
  RoutePlan,
} from './types';
import { memoryCheckpointStore } from './checkpoint';
import { withActiveSpan } from '../../llmops/tracing/spans';
import { llmopsLogger } from '../../llmops/logging/logger';
import { LLMOPS_EVENTS } from '../../llmops/logging/events';
import { updateLlmOpsContext, getLlmOpsContext } from '../../llmops/context';

/**
 * Deterministic domain-to-specialists mapping table.
 */
const DOMAIN_SPECIALISTS_MAP: Record<string, string[]> = {
  labor: ['statutory_specialist', 'cassation_specialist', 'procedural_specialist', 'contract_specialist'],
  commercial: ['statutory_specialist', 'cassation_specialist', 'contract_specialist', 'procedural_specialist'],
  civil: ['statutory_specialist', 'cassation_specialist', 'contract_specialist', 'procedural_specialist'],
  criminal: ['statutory_specialist', 'cassation_specialist', 'procedural_specialist'],
  rent: ['statutory_specialist', 'contract_specialist', 'procedural_specialist'],
  personal_status: ['statutory_specialist', 'cassation_specialist', 'procedural_specialist'],
  administrative: ['statutory_specialist', 'cassation_specialist', 'procedural_specialist'],
  constitutional: ['statutory_specialist', 'cassation_specialist', 'procedural_specialist'],
};

const DEFAULT_SPECIALISTS = ['statutory_specialist', 'procedural_specialist'];

/**
 * Execute the deterministic multi-agent legal graph up to the HITL human review checkpoint.
 */
export async function runCaseDeep(initialState: LegalGraphState): Promise<LegalGraphState> {
  const state: LegalGraphState = {
    ...initialState,
    trace_id: initialState.trace_id || `trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    run_id: initialState.run_id || `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    timings: initialState.timings ? [...initialState.timings] : [],
    specialist_outputs: initialState.specialist_outputs ? { ...initialState.specialist_outputs } : {},
    retrieved_chunks: initialState.retrieved_chunks ? [...initialState.retrieved_chunks] : [],
    citations: initialState.citations ? [...initialState.citations] : [],
    hitl: { ...initialState.hitl },
  };

  if (state.trace_id && (!getLlmOpsContext().trace_id || getLlmOpsContext().trace_id !== state.trace_id)) {
    updateLlmOpsContext({ trace_id: state.trace_id, run_id: state.run_id, mode: 'case_deep' });
  }

  // Step 1: Input Guard (preGuard)
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_START, { node_name: 'guard_input' });
  const guardStart = Date.now();
  const preResult = await withActiveSpan(
    'ai.guard_pre',
    { node_name: 'guard_input', step: 'guard_input' },
    async (span) => {
      const res = preGuard(state.raw_query);
      span.attributes.is_legal = res.is_legal;
      span.attributes.domain = res.domain;
      return res;
    }
  );
  const guardDuration = Date.now() - guardStart;
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_DONE, {
    node_name: 'guard_input',
    latency_ms: guardDuration,
    duration_ms: guardDuration,
  });
  state.guard_pre = preResult;
  state.normalized_query = normalizeArabic(state.raw_query);
  state.timings.push({
    step: 'guard_input',
    duration_ms: guardDuration,
    ts: Date.now(),
  });

  if (!preResult.is_legal) {
    state.errors = [preResult.reject_reason || 'غير قانوني'];
    state.final_response = preResult.reject_reason || DEFAULT_REJECT_REASON;
    state.hitl = {
      status: 'rejected',
      notes: 'تم الرفض بواسطة الفحص الأولي: استفسار خارج النطاق القانوني',
      reviewed_at: new Date().toISOString(),
    };
    return state;
  }

  // Step 2: Route Planning
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_START, { node_name: 'route_plan' });
  const routeStart = Date.now();
  const resolvedDomain = preResult.domain || 'general';
  const selectedSpecialists = DOMAIN_SPECIALISTS_MAP[resolvedDomain] || DEFAULT_SPECIALISTS;

  await withActiveSpan(
    'ai.graph.route_plan',
    { node_name: 'route_plan', step: 'route_plan' },
    async (span) => {
      state.route_plan = {
        domain: resolvedDomain,
        specialists: [...selectedSpecialists],
        rationale: `توجيه تلقائي محدد لقطاع: ${resolvedDomain}`,
        mapped_concepts: preResult.mapped_legal_concepts || [],
        applicable_laws: preResult.applicable_laws || [],
      };
      span.attributes.domain = resolvedDomain;
      span.attributes.specialists = state.route_plan.specialists;
    }
  );
  const routeDuration = Date.now() - routeStart;
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_DONE, {
    node_name: 'route_plan',
    latency_ms: routeDuration,
    duration_ms: routeDuration,
  });
  state.timings.push({
    step: 'route_plan',
    duration_ms: routeDuration,
    ts: Date.now(),
  });

  // Step 3: Retrieval
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_START, { node_name: 'retrieve' });
  const retrieveStart = Date.now();
  await withActiveSpan(
    'ai.retrieve',
    { node_name: 'retrieve', step: 'retrieve' },
    async (span) => {
      if (state.retrieved_chunks.length === 0) {
        const retrievalRes = await retrieveLegalEvidence(state.raw_query, {
          domain: state.route_plan!.domain,
          topK: 5,
        });
        state.retrieved_chunks = retrievalRes.evidence;
      }
      const chunkIds = state.retrieved_chunks.map((c) => c.id || '');
      const evidenceScore = state.retrieved_chunks.length > 0 ? (state.retrieved_chunks.length >= 3 ? 0.9 : 0.7) : 0.0;
      span.attributes.chunk_ids = chunkIds;
      span.attributes.evidence_score = evidenceScore;
    }
  );
  const retrieveDuration = Date.now() - retrieveStart;
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_DONE, {
    node_name: 'retrieve',
    latency_ms: retrieveDuration,
    duration_ms: retrieveDuration,
  });
  state.timings.push({
    step: 'retrieve',
    duration_ms: retrieveDuration,
    ts: Date.now(),
  });

  // Step 4: Sequential Specialists Execution
  for (const specialistName of state.route_plan!.specialists) {
    llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_START, { node_name: specialistName });
    const specStart = Date.now();
    const shortSpec = specialistName.replace(/_specialist$/, '');
    await withActiveSpan(
      `ai.graph.${shortSpec}`,
      { node_name: specialistName, step: `specialist:${specialistName}` },
      async (span) => {
        const output = executeSpecialist(specialistName, state.retrieved_chunks, state.route_plan!);
        state.specialist_outputs[specialistName] = output;
        span.attributes.chunk_ids = output.chunk_ids;
      }
    );
    const specDuration = Date.now() - specStart;
    llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_DONE, {
      node_name: specialistName,
      latency_ms: specDuration,
      duration_ms: specDuration,
    });
    state.timings.push({
      step: `specialist:${specialistName}`,
      duration_ms: specDuration,
      ts: Date.now(),
    });
  }

  // Step 5: Synthesis
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_START, { node_name: 'synthesize' });
  const synthStart = Date.now();
  await withActiveSpan(
    'ai.graph.synthesize',
    { node_name: 'synthesize', step: 'synthesize' },
    async (span) => {
      const synthesis = synthesizeDraft(state);
      state.draft_answer = synthesis.draft;
      state.structured_summary = synthesis.summary;
      state.citations = synthesis.citations;
      const chunkIds = state.retrieved_chunks.map((c) => c.id || '');
      const evidenceScore = state.retrieved_chunks.length > 0 ? (state.retrieved_chunks.length >= 3 ? 0.9 : 0.7) : 0.0;
      span.attributes.chunk_ids = chunkIds;
      span.attributes.evidence_score = evidenceScore;
    }
  );
  const synthDuration = Date.now() - synthStart;
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_DONE, {
    node_name: 'synthesize',
    latency_ms: synthDuration,
    duration_ms: synthDuration,
  });
  state.timings.push({
    step: 'synthesize',
    duration_ms: synthDuration,
    ts: Date.now(),
  });

  // Step 6: Human Review Stop & Checkpoint
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_START, { node_name: 'hitl' });
  const reviewStart = Date.now();
  const checkpointId = `chk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  state.hitl = {
    status: 'awaiting_review',
    checkpoint_id: checkpointId,
  };
  await withActiveSpan(
    'ai.hitl',
    { node_name: 'hitl', checkpoint_id: checkpointId },
    async (span) => {
      await memoryCheckpointStore.set(checkpointId, state);
      await memoryCheckpointStore.setTrace(state.trace_id, state);
      if (state.run_id) {
        await memoryCheckpointStore.setTrace(state.run_id, state);
      }
      span.attributes.checkpoint_id = checkpointId;
    }
  );
  const reviewDuration = Date.now() - reviewStart;
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_DONE, {
    node_name: 'hitl',
    latency_ms: reviewDuration,
    duration_ms: reviewDuration,
  });
  state.timings.push({
    step: 'human_review',
    duration_ms: reviewDuration,
    ts: Date.now(),
  });

  // Note: state is returned WITHOUT final_response at this stage
  return state;
}

/**
 * Resume execution of a paused Case-Deep workflow with lawyer review feedback.
 */
export async function resumeCaseDeep(
  checkpointIdOrState: string | LegalGraphState,
  review: {
    decision: 'approve' | 'modify' | 'reject';
    notes?: string;
    modified_draft?: string;
    reviewer_id?: string;
  }
): Promise<LegalGraphState> {
  let state: LegalGraphState | null;
  if (typeof checkpointIdOrState === 'string') {
    state = await memoryCheckpointStore.get(checkpointIdOrState);
    if (!state) {
      throw new Error(`Checkpoint not found: ${checkpointIdOrState}`);
    }
  } else {
    state = JSON.parse(JSON.stringify(checkpointIdOrState));
  }

  return finalize(state!, review);
}

/**
 * Finalize review decision: applies guard_post, cleans text, records episodic memory.
 */
export async function finalize(
  state: LegalGraphState,
  review: {
    decision: 'approve' | 'modify' | 'reject';
    notes?: string;
    modified_draft?: string;
    reviewer_id?: string;
  }
): Promise<LegalGraphState> {
  if (state.trace_id && (!getLlmOpsContext().trace_id || getLlmOpsContext().trace_id !== state.trace_id)) {
    updateLlmOpsContext({ trace_id: state.trace_id, run_id: state.run_id, mode: 'case_deep' });
  }

  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_START, { node_name: 'finalize' });
  const finalizeStart = Date.now();
  const reviewedAt = new Date().toISOString();

  await withActiveSpan(
    'ai.graph.finalize',
    { node_name: 'finalize', decision: review.decision },
    async (span) => {
      state.hitl = {
        ...state.hitl,
        decision: review.decision,
        notes: review.notes,
        reviewer_id: review.reviewer_id,
        reviewed_at: reviewedAt,
        modified_draft: review.modified_draft,
      };

      if (review.decision === 'reject') {
        state.hitl.status = 'rejected';
        state.final_response = 'تم رفض مسودة الرأي القانوني من قبل المحامي المراجع.' +
          (review.notes ? `\n\nأسباب الرفض وملاحظات التعديل: ${review.notes}` : '');
        state.episodic_memory = {
          action: 'reject',
          decision: 'reject',
          reviewer_id: review.reviewer_id,
          notes: review.notes,
          reviewed_at: reviewedAt,
          query: state.raw_query,
          domain: state.route_plan?.domain,
        };
        span.attributes.decision = 'reject';
      } else {
        state.hitl.status = review.decision === 'modify' ? 'modified' : 'approved';
        const textToFinalize = review.decision === 'modify' && review.modified_draft
          ? review.modified_draft
          : (state.draft_answer || '');

        // Post-Guard Verification against retrieved chunks
        const postResult = postGuard(textToFinalize, state.retrieved_chunks, { threshold: 0.65 });
        state.guard_post = postResult;
        state.final_response = postResult.cleaned_text;
        state.citations = postResult.verified_citations;

        // Fabrication guard clean-up: Strip unverified articles from specialist outputs findings
        if (postResult.unverified_citations && postResult.unverified_citations.length > 0) {
          for (const unv of postResult.unverified_citations) {
            const unvNorm = normalizeArabicNumbers(unv).match(/\d+/)?.[0];
            if (unvNorm) {
              for (const spec of Object.values(state.specialist_outputs)) {
                for (const finding of spec.findings) {
                  if (finding.article_number && normalizeArabicNumbers(finding.article_number).includes(unvNorm)) {
                    finding.article_number = '[مادة غير موثقة]';
                    finding.finding = finding.finding.replace(
                      new RegExp(`(?:المادة|مادة|م)\\s*${unvNorm}`, 'gu'),
                      '[مادة غير موثقة]'
                    );
                  }
                }
              }
            }
          }
        }

        state.episodic_memory = {
          action: review.decision,
          decision: review.decision,
          reviewer_id: review.reviewer_id,
          notes: review.notes,
          reviewed_at: reviewedAt,
          query: state.raw_query,
          domain: state.route_plan?.domain,
          evidence_score: postResult.evidence_score,
          verified_citations_count: postResult.verified_citations.length,
        };
        span.attributes.decision = review.decision;
        span.attributes.evidence_score = postResult.evidence_score;
      }

      if (state.hitl.checkpoint_id) {
        await memoryCheckpointStore.set(state.hitl.checkpoint_id, state);
      }
      if (state.trace_id) {
        await memoryCheckpointStore.setTrace(state.trace_id, state);
      }
      if (state.run_id) {
        await memoryCheckpointStore.setTrace(state.run_id, state);
      }
    }
  );

  const finalizeDuration = Date.now() - finalizeStart;
  llmopsLogger.info(LLMOPS_EVENTS.GRAPH_NODE_DONE, {
    node_name: 'finalize',
    latency_ms: finalizeDuration,
    duration_ms: finalizeDuration,
  });
  state.timings.push({
    step: 'finalize',
    duration_ms: finalizeDuration,
    ts: Date.now(),
  });

  return state;
}


/**
 * Specialist executor: runs purely from retrieved chunks metadata without fabricating articles.
 */
function executeSpecialist(
  specialistName: string,
  chunks: LegalChunk[],
  routePlan: RoutePlan
): SpecialistOutput {
  const findings: SpecialistFinding[] = [];
  const chunkIds: string[] = [];

  switch (specialistName) {
    case 'statutory_specialist': {
      for (const chunk of chunks) {
        if (chunk.article_number) {
          chunkIds.push(chunk.id);
          findings.push({
            article_number: chunk.article_number,
            law_name: chunk.law_name,
            court: chunk.court,
            chunk_ids: [chunk.id],
            source_title: chunk.title,
            finding: `تطبيق نص ${chunk.article_number} من ${chunk.law_name}: ${chunk.summary || chunk.text.slice(0, 160)}`,
            confidence: 0.95,
          });
        }
      }
      return {
        specialist_name: specialistName,
        domain: routePlan.domain,
        findings,
        chunk_ids: Array.from(new Set(chunkIds)),
        summary: findings.length > 0
          ? `تم استخلاص ${findings.length} مادة قانونية مستندة للأدلة المسترجعة صراحة دون استحداث.`
          : 'لم تتضمن الأدلة نصوص مواد صريحة مطابقة للواقعة المعروضة.',
      };
    }

    case 'cassation_specialist': {
      for (const chunk of chunks) {
        const isCassation = chunk.court?.includes('نقض') || chunk.title?.includes('نقض') || chunk.keywords?.includes('نقض');
        if (isCassation || chunk.court) {
          chunkIds.push(chunk.id);
          findings.push({
            court: chunk.court || 'محكمة النقض المصرية',
            article_number: chunk.article_number,
            chunk_ids: [chunk.id],
            source_title: chunk.title,
            finding: `مبدأ محكمة النقض بشأن ${chunk.title}: ${chunk.summary || chunk.text.slice(0, 150)}`,
            confidence: 0.9,
          });
        }
      }
      return {
        specialist_name: specialistName,
        domain: routePlan.domain,
        findings,
        chunk_ids: Array.from(new Set(chunkIds)),
        summary: findings.length > 0
          ? `تم رصد سوابق ومبادئ قضائية من محكمة النقض مرتبطة بالواقعة.`
          : 'لم تتوفر سوابق قضائية مباشرة من محكمة النقض في حزمة الأدلة المتاحة.',
      };
    }

    case 'procedural_specialist': {
      for (const chunk of chunks) {
        chunkIds.push(chunk.id);
      }
      const proceduralText = routePlan.domain === 'labor'
        ? 'وجوب تقديم شكوى لمكتب العمل خلال 10 أيام من تاريخ النزاع، واستيفاء الإجراءات التوفيقية قبل اللجوء للمحكمة العمالية.'
        : routePlan.domain === 'commercial'
        ? 'مراعاة مواعيد تقديم الاحتجاجات (البروتستو) وقيد الدعوى المباشرة ومواعيد سقوط الشيك التجارية.'
        : 'مراعاة مواعيد رفع الدعوى وقواعد الاختصاص القيمي والمكاني وصحة الإعلانات القضائية.';

      findings.push({
        chunk_ids: [...chunkIds],
        finding: proceduralText,
        confidence: 0.88,
      });

      return {
        specialist_name: specialistName,
        domain: routePlan.domain,
        findings,
        chunk_ids: Array.from(new Set(chunkIds)),
        summary: `تم حصر المواعيد والإجراءات الشكلية الواجبة الاتباع لقطاع ${routePlan.domain}.`,
      };
    }

    case 'contract_specialist': {
      for (const chunk of chunks) {
        chunkIds.push(chunk.id);
      }
      findings.push({
        chunk_ids: [...chunkIds],
        finding: 'فحص التكييف القانوني لبنود العقد ومدى انطباق شروط الإنهاء والفسخ والتعويض الاتفاقي والشرط الجزائي وفق أحكام القانون الواجب التطبيق.',
        confidence: 0.85,
      });

      return {
        specialist_name: specialistName,
        domain: routePlan.domain,
        findings,
        chunk_ids: Array.from(new Set(chunkIds)),
        summary: 'تم تقييم الجوانب والآثار العقدية والتزامات الأطراف.',
      };
    }

    default: {
      return {
        specialist_name: specialistName,
        domain: routePlan.domain,
        findings: [],
        chunk_ids: [],
        summary: `اختصاص عام: ${specialistName}`,
      };
    }
  }
}

/**
 * Synthesizes Arabic draft memo in professional Fus'ha with decision-support tone.
 */
function synthesizeDraft(state: LegalGraphState): {
  draft: string;
  summary: Record<string, unknown>;
  citations: LegalCitation[];
} {
  const chunks = state.retrieved_chunks;
  const specialistOutputs = state.specialist_outputs;

  const citations: LegalCitation[] = chunks.map((c) => ({
    id: c.id,
    title: c.title,
    lawName: c.law_name,
    articleNumber: c.article_number,
    category: (c.category as LegalCitation['category']) || 'civil',
    court: c.court || '',
    url: `/laws/${encodeURIComponent(c.law_name)}`,
    summary: c.summary || c.text?.slice(0, 200) || '',
  }));

  const statutoryFindings = specialistOutputs['statutory_specialist']?.findings || [];
  const cassationFindings = specialistOutputs['cassation_specialist']?.findings || [];
  const proceduralFindings = specialistOutputs['procedural_specialist']?.findings || [];

  const legalBasisList = statutoryFindings.map(
    (f) => `${f.article_number || 'نص تشريعي'} من ${f.law_name || 'القانون الساري'}`
  );

  const draftParts: string[] = [];
  draftParts.push('# مذكرة رأي قانوني استشاري لدعم القرار');
  draftParts.push('## أولاً: الوقائع والتكييف القانوني للنزاع');
  draftParts.push(`بناءً على المعطيات المعروضة: "${state.raw_query}". يقع النزاع تحت مظلة ${state.route_plan?.domain || 'القانون المصري'}.`);

  draftParts.push('## ثانياً: التأصيل التشريعي والمبادئ القضائية المقررة');
  if (statutoryFindings.length > 0) {
    for (const sf of statutoryFindings) {
      draftParts.push(`- **${sf.article_number} من ${sf.law_name}:** ${sf.finding}`);
    }
  } else {
    draftParts.push('لم تسفر قاعدة البيانات التشريعية عن مواد مطابقة قطعية مرتبطة بالواقعة مباشرة.');
  }

  if (cassationFindings.length > 0) {
    draftParts.push('### مبادئ محكمة النقض:');
    for (const cf of cassationFindings) {
      draftParts.push(`- ${cf.finding}`);
    }
  }

  draftParts.push('## ثالثاً: التحليل الموضوعي وموقف الدعوى');
  draftParts.push('يتعين الاستناد إلى الأدلة المادية وشهادات الشهود والمستندات الكتابية لإثبات عناصر الضرر والمطالبة بالحقوق المستحقة قانوناً.');

  draftParts.push('## رابعاً: التوصيات الإجرائية ومخاطر التقاضي');
  if (proceduralFindings.length > 0) {
    for (const pf of proceduralFindings) {
      draftParts.push(`- ${pf.finding}`);
    }
  }

  const draftText = draftParts.join('\n\n');

  const summary = {
    case_characterization: `نزاع ${state.route_plan?.domain || 'قانوني'} يتطلب إثبات عناصر الدعوى`,
    case_type: state.route_plan?.domain || 'نزاع قانوني',
    risk_level: 'medium' as const,
    recommended_action: proceduralFindings[0]?.finding || 'استكمال المستندات والمتابعة الإجرائية',
    key_findings: statutoryFindings.map((f) => f.finding),
    legal_basis: legalBasisList,
    procedural_recommendations: proceduralFindings.map((f) => f.finding),
    litigation_risks: [
      'فوات المواعيد المقررة قانوناً لتقديم الشكوى أو رفع الدعوى',
      'عدم كفاية المستندات لإثبات عنصر الضرر أو الإخلال',
    ],
  };

  return {
    draft: draftText,
    summary,
    citations,
  };
}
