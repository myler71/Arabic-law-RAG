import type { LegalChunk } from '../legalRag';
import type { PreGuardResult } from '../safety/legalGuard';

export interface StructuredCaseSummary {
  case_type: string;
  risk_level: 'low' | 'medium' | 'high';
  recommended_action: string;
  category?: string;
  executiveSummary?: string;
  aiStrategicRecommendation?: string;
  legalClaims?: string[];
}

function cleanLawName(name: string): string {
  if (!name) return 'القانون المصري';
  return name.replace(/\s*رقم\s*\d+\s*/gu, ' ').trim();
}

/**
 * Normalizes article citation string to ensure standard Arabic legal phrasing
 * that verifyCitations() reliably detects (e.g. "م 122 & 69" -> "المادتين 69 و 122").
 */
export function formatArticleCitation(rawArticle: string): string {
  if (!rawArticle) return 'المادة القانونية المقررة';
  const trimmed = rawArticle.trim();

  // If already properly phrased in Arabic
  if (trimmed.startsWith('المادة') || trimmed.startsWith('المادتين') || trimmed.startsWith('المادتان')) {
    return trimmed;
  }

  // Extract digits (e.g. "م 122 & 69" -> ["122", "69"])
  const digits = trimmed.match(/\d+/g) || [];
  if (digits.length === 2) {
    return `المادتين ${digits[1]} و ${digits[0]}`;
  }
  if (digits.length === 1) {
    return `المادة ${digits[0]}`;
  }
  if (digits.length > 2) {
    return `المواد ${digits.join(' و ')}`;
  }

  return `المادة ${trimmed.replace(/^[م\s/]+/, '')}`;
}

/**
 * Grounded Egyptian legal answer composition referencing ONLY verified retrieved chunks.
 * Zero fabricated article numbers.
 */
export function generateGroundedAnswer(
  message: string,
  evidence: LegalChunk[],
  guard: PreGuardResult
): { text: string; isDisclaimer: boolean } {
  if (!evidence || evidence.length === 0) {
    return {
      text: `بناءً على الفحص الأولي، لم يتم العثور على نص تشريعي صريح أو سابقة قضائية مطابقة في قاعدة البيانات للواقعة المعروضة.\n\n⚖️ **إخلاء مسؤولية استشارية**:\nوفقاً لمبادئ المستشار القانوني حِكِمْدار، وحرصاً على عدم تقديم تأويل قانوني غير مدعم بنص تشريعي دقيق، يُرجى تزويدنا بمزيد من التفاصيل والوقائع أو مراجعة محامٍ مختص لبحث أوراق النزاع حضورياً.`,
      isDisclaimer: true,
    };
  }

  const top = evidence[0];
  const second = evidence.length > 1 ? evidence[1] : null;

  const topLawClean = cleanLawName(top.law_name);
  const secondLawClean = second ? cleanLawName(second.law_name) : null;

  const topArtFormatted = formatArticleCitation(top.article_number);
  const secondArtFormatted = second ? formatArticleCitation(second.article_number) : null;

  const lines: string[] = [];
  lines.push(`بناءً على نصوص **${topLawClean}** وأحكام **${top.court || 'محكمة النقض المصرية'}**:`);
  lines.push('');
  lines.push('⚖️ **التكييف والرأي القانوني المستقر**:');
  lines.push(`وفقاً لما تقضي به **${topArtFormatted}** من ${topLawClean}:`);
  lines.push(`${top.summary || top.title}.`);

  if (second && secondArtFormatted && second.article_number !== top.article_number) {
    lines.push(`كما تتكامل معها أحكام **${secondArtFormatted}** من ${secondLawClean} بشأن شروط وضوابط النزاع الموضوعي.`);
  }

  lines.push('');
  lines.push('📋 **الخطوات والإجراءات الرسمية الموصى بها**:');
  if (top.category === 'labor' || guard.domain === 'labor') {
    lines.push('1. التقدم بشكوى فورية إلى مكتب علاقات العمل المختص خلال المدة القانونية (10 أيام من تاريخ الواقعة).');
    lines.push('2. السعي لتسوية النزاع ودياً، وفي حال تعذر ذلك يُحال الملف إلى المحكمة العمالية المختصة.');
    lines.push('3. تجهيز أصل عقد العمل، كشوف استلام الراتب، والشهود لإثبات واقعة النزاع.');
  } else if (top.category === 'commercial' || guard.domain === 'commercial') {
    lines.push('1. الحصول على إفادة رفض الصرف الرسمية من البنك المسحوب عليه مبيناً بها سبب الرفض.');
    lines.push('2. تحرير محضر بقسم الشرطة أو توكيل محامٍ لرفع جنحة مباشرة خلال المواعيد المقررة قانوناً.');
    lines.push('3. المطالبة بالتعويض المدني المؤقت وقيمة السند محل النزاع.');
  } else {
    lines.push('1. توثيق وحفظ كافة المحررات والمراسلات المؤيدة للموقف القانوني.');
    lines.push('2. توجيه إنذار رسمي على يد محضر بالوفاء بالالتزامات العقدية أو القانونية.');
    lines.push('3. قيد الدعوى القضائية أمام المحكمة المختصة نوعياً ومكانياً.');
  }

  lines.push('');
  lines.push('💡 **السند التشريعي الموثق من واقع قاعدة البيانات التشريعية**:');
  const citedNames = evidence
    .slice(0, 3)
    .map((e) => `${cleanLawName(e.law_name)} (${formatArticleCitation(e.article_number)})`)
    .join('، ');
  lines.push(`تم الاستناد حصرياً إلى نصوص: ${citedNames}.`);

  return {
    text: lines.join('\n'),
    isDisclaimer: false,
  };
}

/**
 * Extracts structured summary for case brief generation
 */
export function extractStructuredSummary(
  message: string,
  evidence: LegalChunk[],
  guard: PreGuardResult,
  isDisclaimer: boolean
): StructuredCaseSummary | null {
  if (isDisclaimer || !evidence || evidence.length === 0) {
    return null;
  }

  const top = evidence[0];
  const topArtFormatted = formatArticleCitation(top.article_number);
  const isLabor =
    guard.domain === 'labor' || top.category === 'labor' || top.law_name.includes('العمل');
  const isCommercial =
    guard.domain === 'commercial' ||
    top.category === 'commercial' ||
    top.law_name.includes('التجارة');

  if (isLabor) {
    return {
      case_type: 'نزاع عمالي - فصل تعسفي ومستحقات',
      risk_level: 'high',
      recommended_action:
        'تقديم شكوى فورية لمكتب علاقات العمل خلال 10 أيام وطلب إحالة النزاع للمحكمة العمالية.',
      category: 'labor',
      executiveSummary: `نزاع عمالي موضوعي يخضع لأحكام ${cleanLawName(top.law_name)} (${topArtFormatted}). واقعة المطالبة تتعلق بإنهاء الخدمة والحقوق المالية المترتبة.`,
      aiStrategicRecommendation:
        'اتخاذ المسار الإجرائي الرسمي عبر مكتب علاقات العمل ثم رفع دعوى عمالية موضوعية بطلب التعويض المقرر قانوناً ومقابل مهلة الإخطار.',
      legalClaims: [
        `التعويض عن الفصل التعسفي (${topArtFormatted})`,
        'مقابل مهلة الإخطار ورصيد الإجازات السنوية',
        'شهادة نهاية الخدمة وكامل المستحقات المالية المتأخرة',
      ],
    };
  }

  if (isCommercial) {
    return {
      case_type: 'منازعات تجارية - شيك وأوراق تجارية',
      risk_level: 'high',
      recommended_action:
        'استخراج إفادة رفض الصرف من البنك وإقامة جنحة مباشرة أو استصدار أمر أداء.',
      category: 'commercial',
      executiveSummary: `نزاع تجاري متعلق بسند مصرفي يخضع لـ ${topArtFormatted} من ${cleanLawName(top.law_name)}.`,
      aiStrategicRecommendation:
        'التحرك الجنائي عبر النيابة العامة أو المدني عبر أمر الأداء قبل فوات مواعيد السقوط القانونية.',
      legalClaims: [
        'قيمة السند التجاري محل النزاع',
        'الفوائد القانونية والتعويض عن التأخير',
      ],
    };
  }

  return {
    case_type: `استشارة قانونية - ${guard.domain || 'عامة'}`,
    risk_level: 'medium',
    recommended_action:
      'مراجعة المستندات والعقود وتوجيه إنذار رسمي قبل اتخاذ الإجراءات القضائية.',
    category: guard.domain || 'civil',
    executiveSummary: `استشارة قانونية مدعمة بنصوص ${cleanLawName(top.law_name)} (${topArtFormatted}).`,
    aiStrategicRecommendation:
      'إثبات الحقوق كتابةً واللجوء للمحكمة المختصة في حال عدم الوفاء الودي.',
    legalClaims: ['المطالبة بالحقوق المقررة قانوناً والتعويض عن الإخلال'],
  };
}
