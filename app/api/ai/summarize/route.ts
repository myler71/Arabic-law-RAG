import { NextRequest, NextResponse } from 'next/server';
import { MOCK_LEGAL_CITATIONS } from '@/lib/data/legalData';
import { CaseIntake, LegalCategory } from '@/lib/types';

import {
  runLlmOpsContext,
  newTraceId,
  newRunId,
  hashId,
  resolveVersions,
  llmopsLogger,
  LLMOPS_EVENTS,
  runStore,
} from '@/lib/llmops';

export async function POST(req: NextRequest) {
  const trace_id = req.headers.get('x-trace-id') || newTraceId();
  const run_id = newRunId();
  const session_id = req.headers.get('x-session-id') || null;

  return runLlmOpsContext(
    {
      trace_id,
      run_id,
      session_id,
      user_id_hash: hashId('demo-user'),
      persona: 'client',
      mode: 'chat_fast',
      route: '/api/ai/summarize',
    },
    async () => {
      const t_start = Date.now();
      let outcome: 'success' | 'disclaimer' | 'refuse' | 'error' | 'interrupted' = 'success';
      let error_code: string | null = null;

      try {
        const versions = resolveVersions();
        await runStore.startRun({
          id: run_id,
          trace_id,
          session_id,
          user_id: 'demo-user',
          persona: 'client',
          mode: 'chat_fast',
          route: '/api/ai/summarize',
          git_sha: versions.app_git_sha,
          prompt_version: versions.prompt_version,
          model_id: versions.model_id,
          rag_index_version: versions.rag_index_version,
          guard_version: versions.guard_version,
        });
      } catch (err) {
        console.error('[LLMOps] startRun failed:', err);
      }

      llmopsLogger.info(LLMOPS_EVENTS.REQUEST_START, {
        mode: 'chat_fast',
        locale: 'ar',
        message_len: 0,
        history_turns: 0,
      });

      try {
        const { messages, clientInfo } = await req.json();

        if (!messages || !Array.isArray(messages)) {
          outcome = 'error';
          error_code = 'BAD_REQUEST';
          return NextResponse.json(
            { error: 'Messages array is required' },
            { status: 400, headers: { 'X-Trace-Id': trace_id } }
          );
        }

        const allText = messages.map((m: { text?: string }) => m.text || '').join(' ').toLowerCase();

        let detectedCategory: LegalCategory = 'labor';
        let title = 'طلب دعوى عمالية وتعويض عن إنهاء الخدمة';
        let urgency: CaseIntake['urgency'] = 'high';
        let executiveSummary = 'قام صاحب العمل بإنهاء علاقة العمل بصورة مفاجئة دون مسوغ قانوني أو تحقيق كتابي، مع حرمان الموظف من مستحقاته ومهلة الإخطار ورصيد الإجازات السنوية.';
        let legalClaims = [
          'المطالبة بالتعويض عن الفصل التعسفي بواقع أجر شهرين عن كل سنة خدمة وفقاً للمادة 122 من قانون العمل 12 لسنة 2003.',
          'صرف مقابل مهلة الإخطار القانونية ورصيد الإجازات المستحقة.',
          'إلزام جهة العمل بتسليم شهادة الخبرة وإخلاء الطرف ورد أصل مسوغات التعيين.'
        ];
        let relevantStatutes = MOCK_LEGAL_CITATIONS.labor_termination;
        let aiStrategicRecommendation = 'إيداع محضر رسمي بمكتب العمل وإثبات تاريخ الواقعة فوراً، ثم قيد الدعوى أمام الدائرة العمالية بالمحكمة الابتدائية مع طلب ندب خبير حسابي لتقدير المستحقات المالية.';

        if (allText.includes('شيك') || allText.includes('أمانة') || allText.includes('ايصال')) {
          detectedCategory = 'criminal';
          title = 'جنحة إصدار شيك بدون رصيد قائم وقابل للسحب';
          urgency = 'urgent';
          executiveSummary = 'إصدار شيك تجاري مسحوب على بنك معتمد ورفضه لعدم كفاية الرصيد، مع استحقاق حامل الشيك للوفاء بقيمة المبلغ والمطالبة بالتعويض المدني المؤقت.';
          legalClaims = [
            'معاقبة المتهم بموجب المادة 534 من قانون التجارة رقم 17 لسنة 1999.',
            'الادعاء مدنياً بمبلغ تعويض مؤقت قدره 10,001 جنيه لجبر الضرر المالي.',
            'طلب استصدار أمر منع من السفر أو اتخاذ إجراءات التنفيذ الوقتي.'
          ];
          relevantStatutes = MOCK_LEGAL_CITATIONS.commercial_cheque;
          aiStrategicRecommendation = 'تحريك الجنحة المباشرة أو تقديم بلاغ للنيابة العامة مع إرفاق أصل الشيك وإفادة البنك بالرفض قبل انقضاء مواعيد التقادم الصرفي.';
        } else if (allText.includes('عقد') || allText.includes('شراكة') || allText.includes('فسخ') || allText.includes('توريد')) {
          detectedCategory = 'commercial';
          title = 'نزاع إخلال بالتزامات عقد تجاري ومطالبة بالفسخ والتعويض';
          urgency = 'medium';
          executiveSummary = 'تخلف الطرف الثاني عن الوفاء بالتزاماته التعاقدية الجوهرية وتجاوز المواعيد المحددة بالتسليم رغم استلام الدفعات المالية المتفق عليها.';
          legalClaims = [
            'فسخ العقد سند الدعوى عملاً بالمادتين 147 و 157 من القانون المدني.',
            'إلزام المدعى عليه برد المبالغ المقبوضة مع فائدتها القانونية والتعويض الجابر للضرر وفوات الكسب.'
          ];
          relevantStatutes = MOCK_LEGAL_CITATIONS.contract_breach;
          aiStrategicRecommendation = 'توجيه إنذار رسمي بالإعذار على يد محضر لمنح مهلة 7 أيام ثم رفع الدعوى أمام المحكمة الاقتصادية.';
        }

        const generatedBrief: Partial<CaseIntake> = {
          title,
          category: detectedCategory,
          urgency,
          executiveSummary,
          legalClaims,
          relevantStatutes,
          clientTimeline: [
            { date: 'قبل 3 أشهر', event: 'نشوء العلاقة القانونية والاتفاق المبدئي' },
            { date: 'منذ شهر', event: 'حدوث واقعة النزاع / الإخلال بالالتزام' },
            { date: 'منذ أسبوع', event: 'استشارة المستشار القانوني الذكي في حُكمدار وتجميع الأسانيد' }
          ],
          aiStrategicRecommendation,
          feeEstimate: 'أتعاب استرشادية مقترحة: 8,000 - 15,000 ج.م حسب درجات التقاضي',
          clientName: clientInfo?.name || 'أحمد إبراهيم منصور',
          clientEmail: clientInfo?.email || 'ahmed.mansour@example.com',
          clientPhone: clientInfo?.phone || '+20 102 334 9988',
          clientLocation: clientInfo?.location || 'القاهرة - المعادي',
        };

        return NextResponse.json(
          {
            success: true,
            caseBrief: generatedBrief,
          },
          { headers: { 'X-Trace-Id': trace_id } }
        );
      } catch (error: unknown) {
        outcome = 'error';
        error_code = 'SUMMARIZATION_FAILED';
        const details = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
          { error: 'Summarization failed', details },
          { status: 500, headers: { 'X-Trace-Id': trace_id } }
        );
      } finally {
        const t_total_ms = Date.now() - t_start;
        llmopsLogger.info(LLMOPS_EVENTS.REQUEST_DONE, {
          outcome,
          t_total_ms,
          duration_ms: t_total_ms,
        });
        try {
          await runStore.finishRun(run_id, {
            outcome,
            t_total_ms,
            error_code,
          });
        } catch (storeErr) {
          console.error('[LLMOps] finishRun failed:', storeErr);
        }
      }
    }
  );
}
