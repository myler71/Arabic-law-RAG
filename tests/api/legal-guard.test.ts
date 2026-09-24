import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as aiChatPost } from '@/app/api/ai/chat/route';
import { defaultRateLimiter } from '@/lib/ai/rateLimiter';
import {
  preGuard,
  postGuard,
  COLLOQUIAL_LEGAL_MAPPINGS,
  DOMAIN_TAXONOMY,
  STANDARD_LEGAL_DISCLAIMER,
  DEFAULT_REJECT_REASON,
} from '@/lib/ai/safety/legalGuard';
import type { LegalChunk } from '@/lib/ai/legalRag';
describe('HKM-AI-02: Legal Domain Guard & Citation Protection', () => {
  const mockRetrievedChunks: LegalChunk[] = [
    {
      id: 'chunk-art-122',
      article_number: 'المادة 122',
      law_name: 'قانون العمل الموحد رقم 12 لسنة 2003',
      title: 'التعويض عن الفصل التعسفي',
      text: 'إذا أنهى أحد الطرفين العقد دون مبرر مشروع كاف، التزم بأن يعوض الطرف الآخر عن الضرر الذي يصيبه من جراء هذا الإنهاء...',
      summary: 'التعويض عن الفصل التعسفي لا يقل عن أجر شهرين عن كل سنة خدمة',
      keywords: ['فصل تعسفي', 'تعويض'],
      category: 'labor',
      court: 'محكمة النقض العمالية',
    },
    {
      id: 'chunk-art-69',
      article_number: 'المادة 69',
      law_name: 'قانون العمل الموحد رقم 12 لسنة 2003',
      title: 'حالات فصل العامل لخطأ جسيم',
      text: 'لا يجوز فصل العامل إلا إذا ارتكب خطأ جسيماً، ويعتبر من قبيل الخطأ الجسيم الحالات الآتية...',
      summary: 'حالات الفصل التأديبي لخطأ جسيم حصراً',
      keywords: ['خطأ جسيم', 'فصل تأديبي'],
      category: 'labor',
      court: 'محكمة النقض العمالية',
    },
    {
      id: 'chunk-art-534',
      article_number: 'المادة 534',
      law_name: 'قانون التجارة 17 لسنة 1999',
      title: 'عقوبة إصدار شيك بدون رصيد',
      text: 'يعاقب بالحبس وبغرامة لا تجاوز خمسين ألف جنيه أو بإحدى هاتين العقوبتين كل من أصدر شيكاً ليس له مقابل وفاء...',
      summary: 'عقوبة الشيك الذي لا يقابله رصيد قائم وقابل للسحب',
      keywords: ['شيك بدون رصيد', 'شيك مرتجع'],
      category: 'commercial',
      court: 'محكمة النقض الجنائية',
    },
  ];

  describe('Part 1: preGuard Classification & Egyptian Colloquial Mapping', () => {
    it('classifies emotional legal story ("صاحب الشركة طردني ومش راضي يديني أوراقي") as is_legal=true', () => {
      const query = 'صاحب الشركة طردني ومش راضي يديني أوراقي';
      const result = preGuard(query);

      expect(result.is_legal).toBe(true);
      expect(result.domain).toBe('labor');
      expect(result.mapped_legal_concepts).toContain('احتجاز مسوغات التعيين');
      expect(result.mapped_legal_concepts).toContain('فصل تعسفي');
      expect(result.applicable_laws).toContain('قانون العمل 12/2003');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.reject_reason).toBeNull();
      expect(result.clarification_question).toBeDefined();
    });

    it('classifies emotional document withholding story ("صاحب الشركة رافض يديني أوراقي") as is_legal=true', () => {
      const query = 'صاحب الشركة رافض يديني أوراقي';
      const result = preGuard(query);

      expect(result.is_legal).toBe(true);
      expect(result.domain).toBe('labor');
      expect(result.mapped_legal_concepts).toContain('احتجاز مسوغات التعيين');
      expect(result.applicable_laws).toContain('قانون العمل 12/2003');
      expect(result.reject_reason).toBeNull();
    });

    it('rejects non-legal programming requests ("اكتب لي كود بيثون") with polite reject_reason', () => {
      const query = 'اكتب لي كود بيثون';
      const result = preGuard(query);

      expect(result.is_legal).toBe(false);
      expect(result.domain).toBeNull();
      expect(result.mapped_legal_concepts).toEqual([]);
      expect(result.applicable_laws).toEqual([]);
      expect(result.confidence).toBe(0);
      expect(result.reject_reason).toContain('حِكِمْدار');
      expect(result.clarification_question).toBeNull();
    });

    it('rejects non-legal cooking, sports, and weather queries', () => {
      const queries = [
        'طريقة عمل المكرونة بالبشاميل',
        'مين فاز في ماتش الأهلي والزمالك أمس؟',
        'ما هي درجات الحرارة والطقس غداً في الإسكندرية؟',
        'قولي نكتة مضحكة عن الصعايدة',
        'كلمات أغنية أم كلثوم الأطلال',
      ];

      for (const q of queries) {
        const result = preGuard(q);
        expect(result.is_legal).toBe(false);
        expect(result.domain).toBeNull();
        expect(result.reject_reason).toBeTruthy();
      }
    });

    it('correctly maps Egyptian colloquial phrases for wrongful termination ("فصلني", "طردني من الشغل", "القائمة")', () => {
      // 1. فصلني
      const res1 = preGuard('المدير فصلني الأسبوع اللي فات بدون أي سبب');
      expect(res1.is_legal).toBe(true);
      expect(res1.domain).toBe('labor');
      expect(res1.mapped_legal_concepts).toContain('فصل تعسفي');
      expect(res1.mapped_legal_concepts).toContain('إنهاء علاقة عمل');
      expect(res1.applicable_laws).toContain('قانون العمل 12/2003');

      // 2. طردني من الشغل
      const res2 = preGuard('صاحب العمل طردني من الشغل ومعطانيش فلوسي');
      expect(res2.is_legal).toBe(true);
      expect(res2.domain).toBe('labor');
      expect(res2.mapped_legal_concepts).toContain('فصل تعسفي');
      expect(res2.mapped_legal_concepts).toContain('إنهاء علاقة عمل');
      expect(res2.applicable_laws).toContain('قانون العمل 12/2003');

      // 3. القائمة
      const res3 = preGuard('القائمة');
      expect(res3.is_legal).toBe(true);
      expect(res3.domain).toBe('labor');
      expect(res3.mapped_legal_concepts).toContain('فصل تعسفي');
      expect(res3.mapped_legal_concepts).toContain('إنهاء علاقة عمل');
      expect(res3.applicable_laws).toContain('قانون العمل 12/2003');
    });

    it('correctly maps check disputes ("شيك مرتجع", "شيك بدون رصيد")', () => {
      const res1 = preGuard('عندي شيك مرتجع من البنك الأهلي ومش عارف أعمل إيه');
      expect(res1.is_legal).toBe(true);
      expect(res1.domain).toBe('commercial');
      expect(res1.mapped_legal_concepts).toContain('شيك');
      expect(res1.mapped_legal_concepts).toContain('جريمة ديون');
      expect(res1.applicable_laws).toContain('قانون التجارة 17/1999');
      expect(res1.applicable_laws).toContain('عقوبات 340/341');

      const res2 = preGuard('ما هي عقوبة إصدار شيك بدون رصيد في مصر؟');
      expect(res2.is_legal).toBe(true);
      expect(res2.domain).toBe('commercial');
      expect(res2.mapped_legal_concepts).toContain('شيك');
      expect(res2.mapped_legal_concepts).toContain('جريمة ديون');
      expect(res2.applicable_laws).toContain('قانون التجارة 17/1999');
    });

    it('correctly maps personal status disputes ("مؤخر الصداق", "نفقة")', () => {
      const res1 = preGuard('أريد رفع دعوى للمطالبة بـ مؤخر الصداق بعد الطلاق');
      expect(res1.is_legal).toBe(true);
      expect(res1.domain).toBe('personal_status');
      expect(res1.mapped_legal_concepts).toContain('مؤخر الصداق');
      expect(res1.applicable_laws).toContain('الأحوال الشخصية 25/1920');

      const res2 = preGuard('زوجي ممتنع عن دفع نفقة الصغار والزوجية');
      expect(res2.is_legal).toBe(true);
      expect(res2.domain).toBe('personal_status');
      expect(res2.mapped_legal_concepts).toContain('نفقة');
      expect(res2.applicable_laws).toContain('الأحوال الشخصية 25/1920');
    });

    it('correctly maps rent disputes ("مأجر ومبيخرجش", "طرد للغصب")', () => {
      const res1 = preGuard('عندي مستأجر مأجر ومبيخرجش بعد انتهاء مدة العقد');
      expect(res1.is_legal).toBe(true);
      expect(res1.domain).toBe('rent');
      expect(res1.mapped_legal_concepts).toContain('طرد للغصب');
      expect(res1.applicable_laws).toContain('قانون الإيجار');

      const res2 = preGuard('إجراءات دعوى طرد للغصب من الشقة');
      expect(res2.is_legal).toBe(true);
      expect(res2.domain).toBe('rent');
      expect(res2.mapped_legal_concepts).toContain('طرد للغصب');
      expect(res2.applicable_laws).toContain('قانون الإيجار');
    });

    it('classifies legal queries across administrative and constitutional domains', () => {
      const adminRes = preGuard('أريد الطعن في قرار إداري صادر من جهة العمل الحكومية أمام مجلس الدولة');
      expect(adminRes.is_legal).toBe(true);
      expect(adminRes.domain).toBe('administrative');
      expect(adminRes.applicable_laws).toContain('قانون مجلس الدولة 47/1972');

      const constRes = preGuard('ما هي شروط الدفع بعدم الدستورية أمام المحكمة الدستورية العليا؟');
      expect(constRes.is_legal).toBe(true);
      expect(constRes.domain).toBe('constitutional');
      expect(constRes.applicable_laws).toContain('دستور جمهورية مصر العربية 2014 وتعديلاته');
    });

    it('exports data-driven COLLOQUIAL_LEGAL_MAPPINGS dictionary for reuse', () => {
      expect(COLLOQUIAL_LEGAL_MAPPINGS['فصلني']).toBeDefined();
      expect(COLLOQUIAL_LEGAL_MAPPINGS['شيك بدون رصيد']).toBeDefined();
      expect(COLLOQUIAL_LEGAL_MAPPINGS['مؤخر الصداق']).toBeDefined();
      expect(COLLOQUIAL_LEGAL_MAPPINGS['مأجر ومبيخرجش']).toBeDefined();
      expect(COLLOQUIAL_LEGAL_MAPPINGS['صاحب الشركة رافض يديني أوراقي']).toBeDefined();
    });
  });

  describe('Part 2: postGuard Citation Verification & Fabrication Kill-Switch', () => {
    it('passes verified citations and produces action="pass" when evidence_score >= 0.65', () => {
      const aiResponse = `
        بناءً على نص المادة 122 من قانون العمل، يستحق العامل تعويضاً لا يقل عن أجر شهرين عن كل سنة خدمة.
        كما توضح المادة 69 حالات الفصل لخطأ جسيم على سبيل الحصر.
      `;

      const result = postGuard(aiResponse, mockRetrievedChunks);

      expect(result.action).toBe('pass');
      expect(result.evidence_score).toBe(1.0);
      expect(result.verified_citations.length).toBe(2);
      expect(result.cleaned_text).toContain('المادة 122');
      expect(result.cleaned_text).toContain('المادة 69');
      expect(result.cleaned_text).not.toContain(STANDARD_LEGAL_DISCLAIMER);
    });

    it('strips or flags fabricated article numbers absent from retrieved chunks (fabrication kill-switch)', () => {
      const aiResponse = `
        وفقاً لنص المادة 122 من قانون العمل، يحق للعامل المطالبة بالتعويض.
        ومع ذلك، استناداً إلى المادة 999 تسقط الدعوى بعد مرور ستة أشهر.
      `;

      const result = postGuard(aiResponse, mockRetrievedChunks);

      // Fabrication kill-switch asserts:
      // 1. Fabricated article "المادة 999" must be stripped/flagged in cleaned_text
      expect(result.cleaned_text).not.toContain('المادة 999');
      expect(result.cleaned_text).toContain('[مادة غير موثقة]');
      // 2. Real article is kept
      expect(result.cleaned_text).toContain('المادة 122');
      // 3. Evidence score was 1 / 2 = 0.5 < 0.65 -> action='disclaimer'
      expect(result.evidence_score).toBe(0.5);
      expect(result.action).toBe('disclaimer');
      expect(result.cleaned_text).toContain(STANDARD_LEGAL_DISCLAIMER);
    });

    it('strips fabricated article numbers in Eastern Arabic numerals (المادة ٩٩٩)', () => {
      const aiResponse = `
        بموجب المادة ٩٩٩ من القانون المزعوم تسقط الحقوق فوراً.
      `;

      const result = postGuard(aiResponse, mockRetrievedChunks);

      expect(result.cleaned_text).not.toContain('المادة ٩٩٩');
      expect(result.cleaned_text).toContain('[مادة غير موثقة]');
      expect(result.action).toBe('disclaimer');
      expect(result.evidence_score).toBe(0.0);
      expect(result.cleaned_text).toContain(STANDARD_LEGAL_DISCLAIMER);
    });

    it('triggers action="disclaimer" with standard Arabic text when evidence_score < 0.65', () => {
      const aiResponseWithoutCitations = `
        يجب على الموظف التوجه لمكتب العمل المختص وتقديم شكوى رسمية ودية لبدء التحقيق في النزاع.
      `;

      const result = postGuard(aiResponseWithoutCitations, mockRetrievedChunks);

      expect(result.action).toBe('disclaimer');
      expect(result.evidence_score).toBe(0.0);
      expect(result.cleaned_text).toContain(
        'لم يتم العثور على نص تشريعي صريح أو سابقة قضائية مطابقة في قاعدة البيانات. يُرجى مراجعة محامٍ متخصص لتكييف الواقعة بدقة وعدم الاعتماد على استنتاج آلي.'
      );
    });

    it('handles multiple fabricated articles and completely flags all of them', () => {
      const aiResponse = `
        تنص المادة 777 على الإخطار، والمادة 888 على المستحقات، بينما تنص المادة 122 على التعويض.
      `;

      const result = postGuard(aiResponse, mockRetrievedChunks);

      expect(result.cleaned_text).not.toContain('المادة 777');
      expect(result.cleaned_text).not.toContain('المادة 888');
      expect(result.cleaned_text).toContain('المادة 122');
      expect(result.evidence_score).toBeCloseTo(0.33, 1);
      expect(result.action).toBe('disclaimer');
    });
  });

  describe('Part 3: Route Integration (app/api/ai/chat/route.ts)', () => {
    beforeEach(() => {
      defaultRateLimiter.reset();
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    });

    it('rejects non-legal query ("اكتب لي كود بيثون") with citations=[] and caseBriefReady=false', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: { 'x-real-ip': '192.168.1.101' },
        body: JSON.stringify({ message: 'اكتب لي كود بيثون' }),
      });

      const res = await aiChatPost(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.reply).toContain('حِكِمْدار');
      expect(body.citations).toEqual([]);
      expect(body.caseBriefReady).toBe(false);
    });

    it('rejects non-legal recipe query ("طريقة عمل الكنافة بالمانجو") with citations=[] and caseBriefReady=false', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: { 'x-real-ip': '192.168.1.102' },
        body: JSON.stringify({ message: 'طريقة عمل الكنافة بالمانجو' }),
      });

      const res = await aiChatPost(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.reply).toContain('حِكِمْدار');
      expect(body.citations).toEqual([]);
      expect(body.caseBriefReady).toBe(false);
    });

    it('accepts emotional legal story ("صاحب الشركة طردني ومش راضي يديني أوراقي") and returns legal advice', async () => {
      const req = new NextRequest('http://localhost:3000/api/ai/chat', {
        method: 'POST',
        headers: { 'x-real-ip': '192.168.1.103' },
        body: JSON.stringify({ message: 'صاحب الشركة طردني ومش راضي يديني أوراقي' }),
      });

      const res = await aiChatPost(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.reply).toBeDefined();
      expect(body.reply).not.toContain('سؤالك يتعلق بمجال');
      expect(body.caseBriefReady).toBe(true);
    });
  });
});
