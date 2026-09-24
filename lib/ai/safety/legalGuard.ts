import {
  verifyCitations,
  normalizeArabic,
  normalizeArabicNumbers,
  type LegalChunk,
  type LegalCitation,
} from '../legalRag';

export interface PreGuardResult {
  is_legal: boolean;
  domain: string | null;
  mapped_legal_concepts: string[];
  applicable_laws: string[];
  confidence: number;
  reject_reason: string | null;
  clarification_question: string | null;
}

export interface PostGuardResult {
  action: 'pass' | 'disclaimer';
  evidence_score: number;
  cleaned_text: string;
  verified_citations: LegalCitation[];
  unverified_citations?: string[];
  disclaimer?: string | null;
}

export interface PostGuardOptions {
  threshold?: number;
  flagPlaceholder?: string;
  appendDisclaimer?: boolean;
}

export interface ColloquialLegalEntry {
  patterns: string[];
  concepts: string[];
  laws: string[];
  domain: string;
  clarification_question?: string;
}

/**
 * Standard disclaimer appended when evidence score < 0.65
 */
export const STANDARD_LEGAL_DISCLAIMER =
  'لم يتم العثور على نص تشريعي صريح أو سابقة قضائية مطابقة في قاعدة البيانات. يُرجى مراجعة محامٍ متخصص لتكييف الواقعة بدقة وعدم الاعتماد على استنتاج آلي.';

/**
 * Default polite rejection message for non-legal queries
 */
export const DEFAULT_REJECT_REASON =
  '⚖️ **تنبيه التخصص القانوني:**\n\n' +
  'عذراً، أنا **المستشار القانوني حِكِمْدار**، نظام ذكاء اصطناعي مخصص ومقيد حصرياً للإجابة على **الاستفسارات القانونية، التشريعية، الدستورية، وإجراءات التقاضي في جمهورية مصر العربية**.\n\n' +
  'يرجى طرح استفسار يتعلق بموضوع قانوني (مثل: قضايا العمل، العقود، الشركات، الشيكات، الإيجارات، أو الحقوق الدستورية).';

/**
 * Egyptian colloquial mapping dictionary (data-driven object, exported for reuse)
 */
export const COLLOQUIAL_LEGAL_MAPPINGS: Record<string, ColloquialLegalEntry> = {
  // Labor / termination
  'فصلني': {
    patterns: ['فصلني', 'طردني من الشغل', 'طردني', 'مشاني من الشغل', 'سرحوني', 'رفدوني', 'فصل تعسفي'],
    concepts: ['فصل تعسفي', 'إنهاء علاقة عمل'],
    laws: ['قانون العمل 12/2003'],
    domain: 'labor',
    clarification_question: 'هل تم إخطارك بأسباب الفصل كتابةً، وهل كان عقد العمل محدد المدة أم غير محدد المدة؟',
  },
  'طردني من الشغل': {
    patterns: ['طردني من الشغل', 'طردني من العمل', 'مشوني من الشغل', 'طردوني من العمل'],
    concepts: ['فصل تعسفي', 'إنهاء علاقة عمل'],
    laws: ['قانون العمل 12/2003'],
    domain: 'labor',
    clarification_question: 'هل تقدمت بشكوى لمكتب العمل المختص خلال مهلة الـ 10 أيام المقررة قانوناً؟',
  },
  'قائمة المنقولات الزوجية': {
    patterns: ['قائمة المنقولات الزوجية', 'قايمة المنقولات الزوجية', 'قايمة العفش', 'عفش الزوجية'],
    concepts: ['قائمة منقولات', 'تبديد منقولات'],
    laws: ['الأحوال الشخصية 25/1920', 'قانون العقوبات 58/1937'],
    domain: 'personal_status',
    clarification_question: 'هل تم توقيع قائمة المنقولات الزوجية كتابةً وما هو بيان الأعيان الثابتة بها؟',
  },
  'القائمة': {
    patterns: ['القائمة', 'قايمة'],
    concepts: ['فصل تعسفي', 'إنهاء علاقة عمل'],
    laws: ['قانون العمل 12/2003'],
    domain: 'labor',
    clarification_question: 'هل تقصد القائمة العمالية لإنهاء الخدمة وتصفية المستحقات أم قائمة المنقولات الزوجية؟',
  },

  // Commercial / checks / debts
  'شيك مرتجع': {
    patterns: ['شيك مرتجع', 'شيك راجع', 'شيك رفض', 'ارتجاع شيك', 'شيك بدون رصيد'],
    concepts: ['شيك', 'جريمة ديون'],
    laws: ['قانون التجارة 17/1999', 'عقوبات 340/341'],
    domain: 'commercial',
    clarification_question: 'هل حصلت على إفادة رسمية (رفض بنكي) من البنك المسحوب عليه بعدم وجود رصيد قائم وقابل للسحب؟',
  },
  'شيك بدون رصيد': {
    patterns: ['شيك بدون رصيد', 'شيك بلا رصيد', 'إصدار شيك بدون رصيد', 'شيك ليس له مقابل وفاء'],
    concepts: ['شيك', 'جريمة ديون'],
    laws: ['قانون التجارة 17/1999', 'عقوبات 340/341'],
    domain: 'commercial',
    clarification_question: 'ما هو تاريخ إصدار واستحقاق الشيك، وهل قمت بتوجيه إنذار رسمي أو تحرير محضر جنحة شيك مباشرة؟',
  },

  // Personal status / family
  'مؤخر الصداق': {
    patterns: ['مؤخر الصداق', 'مؤخر صداق', 'المؤخر'],
    concepts: ['مؤخر الصداق', 'نفقة'],
    laws: ['الأحوال الشخصية 25/1920'],
    domain: 'personal_status',
    clarification_question: 'هل تم توثيق الطلاق رسمياً بقسيمة طلاق معتمدة للمطالبة بمؤخر الصداق؟',
  },
  'نفقة': {
    patterns: ['نفقة', 'نفقات', 'نفقة زوجية', 'نفقة صغار', 'نفقة متعة', 'نفقة عدة'],
    concepts: ['مؤخر الصداق', 'نفقة'],
    laws: ['الأحوال الشخصية 25/1920'],
    domain: 'personal_status',
    clarification_question: 'ما هو نوع النفقة المطالب بها (زوجية / صغار / متعة)، وهل لديك مستندات تفيد مفردات دخل الزوج؟',
  },

  // Rent / occupancy
  'مأجر ومبيخرجش': {
    patterns: ['مأجر ومبيخرجش', 'ماجر ومبيخرجش', 'المستأجر مبيخرجش', 'مش راضي يخرج من الشقة', 'مش راضي يسلم العين'],
    concepts: ['طرد للغصب', 'انتهاء عقد الإيجار'],
    laws: ['قانون الإيجار'],
    domain: 'rent',
    clarification_question: 'هل عقد الإيجار محدد المدة ومثبت التاريخ وما هو تاريخ انتهاء مدته، وهل تم توجيه إنذار رسمي بالإخلاء؟',
  },
  'طرد للغصب': {
    patterns: ['طرد للغصب', 'طرد غصب', 'دعوى طرد للغصب', 'وضع يد بدون سند', 'غصب العين'],
    concepts: ['طرد للغصب', 'انتهاء عقد الإيجار'],
    laws: ['قانون الإيجار'],
    domain: 'rent',
    clarification_question: 'هل يشغل واضع اليد العقار بموجب علاقة إيجارية سابقة منتهية أم بدون أي سند قانوني على الإطلاق؟',
  },

  // Emotional legal stories: employer withholding documents
  'صاحب الشركة رافض يديني أوراقي': {
    patterns: [
      'صاحب الشركة رافض يديني أوراقي',
      'مش راضي يديني أوراقي',
      'مش راضيين يدوني أوراقي',
      'رافض يديني أوراقي',
      'احتجاز أوراقي',
      'احتجاز مسوغات التعيين',
      'رافض يسلمني مسوغات التعيين',
      'مش راضي يسلمني شهادة الخبرة',
      'حابس أوراقي',
      'أوراقي محجوزة في الشركة',
    ],
    concepts: ['احتجاز مسوغات التعيين', 'إنهاء علاقة عمل'],
    laws: ['قانون العمل 12/2003'],
    domain: 'labor',
    clarification_question: 'هل تم توقيع إخلاء طرف واستلام شهادة نهاية الخدمة من جهة العمل رسمياً، وهل تقدمت بطلب كتابي لإدارة الموارد البشرية؟',
  },

  // Trust breach / Promissory notes
  'إيصال أمانة على بياض': {
    patterns: ['إيصال أمانة على بياض', 'وصل أمانة على بياض', 'مضاني على بياض', 'توقيع على بياض'],
    concepts: ['خيانة أمانة', 'طعن بالتزوير الصلبي'],
    laws: ['قانون العقوبات 58/1937', 'عقوبات 340/341'],
    domain: 'criminal',
    clarification_question: 'هل قمت بالتوقيع أو البصمة على بياض، وهل تم ملء بيانات صلب الإيصال بصلب زمني مغاير؟',
  },

  // Fraud / Theft
  'نصب واحتيال': {
    patterns: ['نصب عليا', 'خد فلوسي ونصب عليا', 'نصب واحتيال', 'احتيال مالي', 'سرق فلوسي'],
    concepts: ['نصب واحتيال', 'جريمة ديون'],
    laws: ['قانون العقوبات 58/1937'],
    domain: 'criminal',
    clarification_question: 'هل تم تسليم المبالغ النقدية بناءً على طرق احتيالية أو إيهام بمشروع كاذب، وهل توجد إيصالات تحويل بنكية؟',
  },
};

/**
 * Domain keyword taxonomy across 8 core Egyptian legal domains
 */
export const DOMAIN_TAXONOMY: Record<
  string,
  {
    nameAr: string;
    primaryLaws: string[];
    keywords: string[];
    concepts: string[];
  }
> = {
  labor: {
    nameAr: 'قانون العمل والنزاعات العمالية',
    primaryLaws: ['قانون العمل 12/2003', 'قانون التأمينات والمعاشات 148/2019'],
    keywords: [
      'عمل', 'عمال', 'عامل', 'موظف', 'صاحب العمل', 'صاحب الشركة', 'الشركة', 'المدير',
      'فصل', 'طرد', 'فصل تعسفي', 'استقالة', 'إنهاء عقد', 'عقد عمل',
      'مرتب', 'راتب', 'أجر', 'أجور', 'مستحقات', 'مكافأة نهاية الخدمة',
      'مكتب العمل', 'تأمينات', 'تأمين اجتماعي', 'تأمينات اجتماعية',
      'مسوغات التعيين', 'أوراقي', 'شهادة خبرة', 'شهادة الخدمة',
      'إجازة', 'إجازات', 'إجازة سنوية', 'إجازة مرضية', 'رصيد إجازات',
      'ساعات العمل', 'بدل راحة', 'وقت إضافي', 'أوفرتايم', 'جزاءات',
      'تحقيق إداري', 'إنذار بالفصل', 'انقطاع عن العمل', 'إصابة عمل',
      'تعويض عن الفصل', 'لجنة ثلاثية', 'محكمة عمالية'
    ],
    concepts: ['فصل تعسفي', 'إنهاء علاقة عمل', 'مستحقات عمالية', 'احتجاز مسوغات التعيين', 'مكافأة نهاية الخدمة', 'تعويض عمالي'],
  },
  civil: {
    nameAr: 'القانون المدني والمعاملات والعقود',
    primaryLaws: ['القانون المدني 131/1948', 'قانون الإثبات 25/1968'],
    keywords: [
      'مدني', 'عقد', 'عقود', 'التزام', 'بطلان', 'فسخ', 'فسخ عقد', 'إبطال',
      'تعويض', 'تعويض مدني', 'ضرر', 'أضرار', 'مسؤولية تقصيرية', 'مسؤولية عقدية',
      'ملكية', 'حيازة', 'شفعة', 'ارتفاق', 'انتفاع', 'رهن', 'رهن رسمي', 'رهن حيازي',
      'بيع', 'شراء', 'عقد بيع', 'عربون', 'صحة توقيع', 'صحة ونفاذ', 'دعوى صحة ونفاذ',
      'دعوى صحة توقيع', 'تقادم', 'سقوط الحق', 'إثراء بلا سبب', 'رد غير المستحق',
      'عيب خفي', 'ضمان العيوب', 'مقاولة', 'مقاول', 'وكالة', 'وديعة', 'صلح'
    ],
    concepts: ['فسخ عقد', 'المسؤولية المدنية والتعويض', 'دعوى صحة توقيع', 'إثبات الالتزام', 'دعوى صحة ونفاذ'],
  },
  commercial: {
    nameAr: 'القانون التجاري والشركات والأوراق المالية',
    primaryLaws: ['قانون التجارة 17/1999', 'قانون الشركات 159/1981', 'قانون الاستثمار 72/2017'],
    keywords: [
      'تجاري', 'تجارة', 'تاجر', 'شركة', 'شركات', 'سجل تجاري', 'بطاقة ضريبية',
      'شيك', 'شيكات', 'كمبيالة', 'سند لأمر', 'أوراق تجارية', 'بروتستو',
      'إفلاس', 'تصفية', 'تصفية شركة', 'حل شركة', 'شريك', 'شركاء', 'حصص',
      'أسهم', 'سندات', 'مجلس إدارة', 'جمعية عمومية', 'علامة تجارية', 'اسم تجاري',
      'براءة اختراع', 'عقد توزيع', 'عقد توريد', 'وكالة تجارية', 'سمسرة', 'اعتماد مستندي'
    ],
    concepts: ['شيك', 'أوراق تجارية', 'نزاع شركات', 'إفلاس وتصفية', 'سجل تجاري'],
  },
  criminal: {
    nameAr: 'قانون العقوبات والإجراءات الجنائية',
    primaryLaws: ['قانون العقوبات 58/1937', 'قانون الإجراءات الجنائية 150/1950'],
    keywords: [
      'جنائي', 'جناية', 'جنحة', 'مخالفة', 'عقوبة', 'حبس', 'سجن', 'غرامة',
      'سرقة', 'نصب', 'احتيال', 'خيانة أمانة', 'إيصال أمانة', 'وصل أمانة',
      'شيك بدون رصيد', 'شيك مرتجع', 'تزوير', 'تزييف', 'رشوة', 'اختلاس',
      'ضرب', 'جرح', 'عاهة مستديمة', 'قتل', 'تهديد', 'ابتزاز', 'ابتزاز إلكتروني',
      'سب', 'قذف', 'تشهير', 'جرائم الإنترنت', 'محضر', 'محضر شرطة', 'قسم الشرطة',
      'نيابة', 'النيابة العامة', 'تحقيق', 'أمر إحالة', 'كفالة', 'إخلاء سبيل',
      'معارضة', 'استئناف', 'نقض جنائي', 'رد اعتبار', 'سقوط العقوبة'
    ],
    concepts: ['جريمة ديون', 'خيانة أمانة', 'نصب واحتيال', 'إجراءات جنائية', 'جنحة شيك بدون رصيد'],
  },
  personal_status: {
    nameAr: 'قانون الأحوال الشخصية والأسرة',
    primaryLaws: [
      'قانون الأحوال الشخصية 25/1920 والمعدل بالقانون 25/1929',
      'قانون تنظيم بعض أوضاع التقاضي في مسائل الأحوال الشخصية 1/2000',
      'قانون المواريث 77/1943'
    ],
    keywords: [
      'أحوال شخصية', 'أسرة', 'محكمة الأسرة', 'زواج', 'عقد زواج', 'طلاق', 'خلع',
      'نفقة', 'نفقات', 'نفقة زوجية', 'نفقة صغار', 'نفقة متعة', 'مؤخر', 'مؤخر الصداق',
      'مهر', 'صداق', 'عدة', 'أجر مسكن', 'أجر حضانة', 'أجر رضاعة',
      'قايمة', 'قائمة', 'قائمة المنقولات', 'تبديد منقولات', 'عفش',
      'حضانة', 'حاضنة', 'رؤية', 'حق الرؤية', 'استضافة', 'مسكن الزوجية',
      'تمكين', 'قرار تمكين', 'ولاية تعليمية', 'وصاية', 'وصي', 'قوامة',
      'ميراث', 'ورث', 'تركة', 'إعلام وراثة', 'حصر تركة', 'قسمة تركة', 'وصية', 'حجب', 'رد'
    ],
    concepts: ['نفقة', 'مؤخر الصداق', 'طلاق للضرر', 'خلع', 'حضانة ورؤية', 'قائمة منقولات', 'إعلام وراثة'],
  },
  rent: {
    nameAr: 'قانون الإيجار وإشغال العقارات',
    primaryLaws: ['قانون الإيجار', 'قانون الإيجار المدني 4/1996', 'قوانين إيجار الأماكن 49/1977 و136/1981'],
    keywords: [
      'إيجار', 'أجرة', 'مؤجر', 'مستأجر', 'عقد إيجار', 'مأجر', 'مأجر ومبيخرجش',
      'طرد', 'إخلاء', 'طرد للغصب', 'غصب', 'طرد لعدم سداد الأجرة',
      'قانون قديم', 'إيجار قديم', 'قانون جديد', 'إيجار جديد', 'امتداد قانوني',
      'امتداد عقد الإيجار', 'انتهاء العقد', 'زيادة الإيجار', 'متأخرات إيجار',
      'إنذار عرض أجرة', 'فسخ عقد إيجار', 'استرداد العين المؤجرة'
    ],
    concepts: ['قانون الإيجار', 'طرد للغصب', 'إخلاء لعدم سداد الأجرة', 'امتداد عقد الإيجار', 'فسخ عقد الإيجار'],
  },
  administrative: {
    nameAr: 'القانون الإداري وقضاء مجلس الدولة',
    primaryLaws: ['قانون مجلس الدولة 47/1972', 'قانون الخدمة المدنية 81/2016'],
    keywords: [
      'إداري', 'مجلس الدولة', 'محكمة القضاء الإداري', 'المحكمة الإدارية العليا',
      'قرار إداري', 'إلغاء قرار إداري', 'سحب قرار إداري', 'دعوى إلغاء',
      'موظف عام', 'خدمة مدنية', 'ترقية', 'تخطي في الترقية', 'تأديب',
      'مجلس تأديب', 'جزاء تأديبي', 'تسوية معاش', 'رصيد إجازات حكومي',
      'مناقصات', 'مزايدات', 'عقد إداري', 'نزع ملكية للمنفعة العامة'
    ],
    concepts: ['دعوى إلغاء قرار إداري', 'قضاء مجلس الدولة', 'حقوق الموظف العام في الخدمة المدنية'],
  },
  constitutional: {
    nameAr: 'القانون الدستوري والمحكمة الدستورية العليا',
    primaryLaws: ['دستور جمهورية مصر العربية 2014 وتعديلاته', 'قانون المحكمة الدستورية العليا 48/1979'],
    keywords: [
      'دستور', 'دستوري', 'دستورية', 'المحكمة الدستورية العليا', 'المحكمة الدستورية',
      'عدم دستورية', 'طعن بعدم الدستورية', 'الدفع بعدم الدستورية',
      'حق التقاضي', 'مبدأ المساواة', 'الحريات العامة', 'حقوق الإنسان',
      'الفصل بين السلطات', 'تفسير تشريعي', 'رقابة دستورية'
    ],
    concepts: ['رقابة دستورية القوانين', 'الدفع بعدم الدستورية', 'الحقوق والحريات الدستورية'],
  },
};

/**
 * Non-legal categories with regex patterns (cooking, programming, sports, weather, jokes, music)
 */
export const NON_LEGAL_CATEGORIES: Record<string, { label: string; patterns: RegExp[] }> = {
  cooking: {
    label: 'الطبخ والمأكولات',
    patterns: [
      /(?:طريقة عمل|وصفة|طبخ|أكل|طعام|مقادير|شيف|وجبة|حلويات|كيك|مطبخ|شوربة|سلطة)/iu,
    ],
  },
  programming: {
    label: 'البرمجة والتقنية',
    patterns: [
      /(?:كود برمجي|برمجة|javascript|python|typescript|java\b|c\+\+|html|css|react|sql\b|خوارزمية|دالة برمجية|سيرفر|اكتب لي كود|اكتب كود|بيثون|بايثون)/iu,
    ],
  },
  sports: {
    label: 'الرياضة وكرة القدم',
    patterns: [
      /(?:كرة قدم|مباراة|دوري|كأس العالم|الأهلي|الزمالك|محمد صلاح|ريال مدريد|برشلونة|ماتش)/iu,
    ],
  },
  weather: {
    label: 'الطقس والأحوال الجوية',
    patterns: [
      /(?:طقس|الطقس|درجة الحرارة|أمطار|مناخ|حالة الجو)/iu,
    ],
  },
  jokes: {
    label: 'النكات والترفيه',
    patterns: [
      /(?:نكتة|نكت|اضحكني|مسرحية|فيلم سينمائي|مسلسل|فنان)/iu,
    ],
  },
  music: {
    label: 'الموسيقى والشعر',
    patterns: [
      /(?:أغنية|اغنية|موسيقى|لحن|ألحان|شعر غزلي|قصيدة شعر|كلمات أغنية)/iu,
    ],
  },
  medical: {
    label: 'الاستشارات الطبية والصحية',
    patterns: [
      /(?:علاج|دواء|أعراض|صداع|طبيب|دكتور|روشتة|مستشفى|جرعة|مسكن|تشخيص طبي|مرض|ضغط الدم|مضاد حيوي|ألم في المعدة|ألم في الظهر|سخونية)/iu,
    ],
  },
};

/**
 * Converts Western ASCII digits (0-9) to Eastern Arabic numerals (٠-٩).
 */
export function toEasternArabicNumerals(numStr: string): string {
  const easternDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return numStr.replace(/\d/g, (d) => easternDigits[parseInt(d, 10)] ?? d);
}

/**
 * Pre-guard: Classifies an incoming message into legal vs non-legal across 8 domains,
 * maps colloquial Egyptian phrases into formal legal concepts & laws,
 * and extracts relevant clarification questions.
 */
export function preGuard(message: string): PreGuardResult {
  if (!message || typeof message !== 'string') {
    return {
      is_legal: false,
      domain: null,
      mapped_legal_concepts: [],
      applicable_laws: [],
      confidence: 0,
      reject_reason: 'يرجى إدخال استفسارك القانوني لنتمكن من تقديم المشورة الموثقة.',
      clarification_question: null,
    };
  }

  const trimmed = message.trim();
  if (trimmed.length < 2) {
    return {
      is_legal: false,
      domain: null,
      mapped_legal_concepts: [],
      applicable_laws: [],
      confidence: 0,
      reject_reason: DEFAULT_REJECT_REASON,
      clarification_question: null,
    };
  }

  const normalized = normalizeArabic(normalizeArabicNumbers(trimmed.toLowerCase()));

  // 1. Check Egyptian colloquial mapping dictionary
  const matchedConcepts = new Set<string>();
  const matchedLaws = new Set<string>();
  let primaryDomain: string | null = null;
  let highestDomainWeight = 0;
  let suggestedClarification: string | null = null;
  let colloquialHitCount = 0;

  for (const [key, entry] of Object.entries(COLLOQUIAL_LEGAL_MAPPINGS)) {
    let matched = false;

    // Check direct normalized key match
    const normKey = normalizeArabic(normalizeArabicNumbers(key.toLowerCase()));
    if (normalized.includes(normKey)) {
      matched = true;
    } else {
      // Check entry patterns
      for (const pat of entry.patterns) {
        const normPat = normalizeArabic(normalizeArabicNumbers(pat.toLowerCase()));
        if (normalized.includes(normPat)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      colloquialHitCount++;
      for (const concept of entry.concepts) matchedConcepts.add(concept);
      for (const law of entry.laws) matchedLaws.add(law);
      if (!primaryDomain || highestDomainWeight < 10) {
        primaryDomain = entry.domain;
        highestDomainWeight = 10;
      }
      if (!suggestedClarification && entry.clarification_question) {
        suggestedClarification = entry.clarification_question;
      }
    }
  }

  // 2. Emotional legal stories detection (e.g. 'صاحب الشركة رافض يديني أوراقي', 'صاحب الشركة طردني ومش راضي يديني أوراقي')
  const hasEmployerRef = /(?:صاحب العمل|صاحب الشرك[ةه]|الشرك[ةه]|المدير|الشغل|العمل)/iu.test(normalized);
  const hasWithholdingPapers = /(?:أوراقي|اوراقي|ورقي|مسوغات|شهادة الخبر[ةه]|المؤهل)/iu.test(normalized) &&
    /(?:رافض|مش راضي|مش راضيين|حابس|ممتنع|رفض|حجز)/iu.test(normalized);
  const hasEmotionalTermination = /(?:طردني|فصلني|مشاني|رماني|بهدلني|خصم|طرد تعسفي)/iu.test(normalized);

  if (hasEmployerRef && hasWithholdingPapers) {
    matchedConcepts.add('احتجاز مسوغات التعيين');
    matchedConcepts.add('إنهاء علاقة عمل');
    matchedLaws.add('قانون العمل 12/2003');
    primaryDomain = 'labor';
    highestDomainWeight = 15;
    if (!suggestedClarification) {
      suggestedClarification = 'هل تقدمت بطلب رسمي لإدارة الشركة أو إنذار على يد محضر لاستلام مسوغات التعيين؟';
    }
  }

  if (hasEmployerRef && hasEmotionalTermination) {
    matchedConcepts.add('فصل تعسفي');
    matchedConcepts.add('إنهاء علاقة عمل');
    matchedLaws.add('قانون العمل 12/2003');
    if (!primaryDomain) primaryDomain = 'labor';
  }

  // 3. Score against domain taxonomy across 8 domains
  const domainScores: Record<string, number> = {};

  for (const [dom, data] of Object.entries(DOMAIN_TAXONOMY)) {
    let score = 0;
    for (const kw of data.keywords) {
      const normKw = normalizeArabic(normalizeArabicNumbers(kw.toLowerCase()));
      if (normKw === 'عمل') {
        const withoutCurrencyOrOps = normalized
          .replace(/(?:ال)?عمل[ةا]ت?/gu, ' ')
          .replace(/(?:ال)?عمليات/gu, ' ')
          .replace(/(?:ال)?معاملات/gu, ' ');
        if (withoutCurrencyOrOps.includes('طريقة عمل')) {
          const stripped = withoutCurrencyOrOps.replace(/طريقة عمل/gu, ' ');
          if (/(?:^|\s)(?:ال)?عمل(?:$|\s)/u.test(stripped)) {
            score += 1;
          }
        } else if (/(?:^|\s)(?:ال)?عمل(?:$|\s)/u.test(withoutCurrencyOrOps)) {
          score += 1;
        }
      } else if (normalized.includes(normKw)) {
        score += 1;
      }
    }
    for (const cp of data.concepts) {
      const normCp = normalizeArabic(normalizeArabicNumbers(cp.toLowerCase()));
      if (normalized.includes(normCp)) {
        score += 2;
      }
    }
    domainScores[dom] = score;

    if (score > highestDomainWeight) {
      highestDomainWeight = score;
      primaryDomain = dom;
    }
  }

  // If a domain scored well, add its primary laws & concepts if relevant
  if (primaryDomain && DOMAIN_TAXONOMY[primaryDomain]) {
    const domData = DOMAIN_TAXONOMY[primaryDomain];
    if (domainScores[primaryDomain] > 0 || colloquialHitCount > 0) {
      for (const law of domData.primaryLaws) {
        matchedLaws.add(law);
      }
    }
  }

  // 4. General legal terminology check
  const generalLegalMatches = /(?:قانون|محكم[ةه]|دعوى|محامي|قضي[ةه]|حكم|حق|التزام|عقد|شرعي|استشار[ةه] قانوني[ةه]|جنح[ةه]|جناي[ةه]|دستور|مجلس الدول[ةه]|نقض|استئناف|تقاضي|مستحقات|تعويض)/iu.test(
    normalized
  );

  // 5. Non-legal category check (cooking, programming, sports, weather, jokes, music)
  let nonLegalDetected = false;
  let nonLegalCategoryLabel: string | null = null;

  for (const [, cat] of Object.entries(NON_LEGAL_CATEGORIES)) {
    for (const pat of cat.patterns) {
      if (pat.test(trimmed) || pat.test(normalized)) {
        nonLegalDetected = true;
        nonLegalCategoryLabel = cat.label;
        break;
      }
    }
    if (nonLegalDetected) break;
  }

  // 6. Synthesis and Classification Decision
  const hasStrongLegalSignal =
    colloquialHitCount > 0 ||
    (hasEmployerRef && (hasWithholdingPapers || hasEmotionalTermination)) ||
    (!nonLegalDetected && (matchedConcepts.size > 0 || highestDomainWeight >= 1 || generalLegalMatches)) ||
    (nonLegalDetected && (matchedConcepts.size >= 2 || highestDomainWeight >= 3));
  // If strong legal signals are present, prioritize legal classification even if incidental non-legal words exist
  if (hasStrongLegalSignal) {
    const finalConcepts = Array.from(matchedConcepts);
    const finalLaws = Array.from(matchedLaws);

    // If domain wasn't firmly set, pick best scoring or fall back to general
    if (!primaryDomain && generalLegalMatches) {
      primaryDomain = 'civil';
      finalLaws.push('القانون المدني 131/1948');
    }

    // Default clarification question if not already picked
    if (!suggestedClarification && primaryDomain) {
      switch (primaryDomain) {
        case 'labor':
          suggestedClarification = 'هل يوجد عقد عمل مكتوب يحدد تاريخ بدء العمل وقيمة الراتب المتفق عليه؟';
          break;
        case 'commercial':
          suggestedClarification = 'هل النزاع محرر بشأنه أوراق تجارية (شيك / كمبيالة) أو مسجل بالسجل التجاري؟';
          break;
        case 'personal_status':
          suggestedClarification = 'هل الدعوى مرفوعة أمام محكمة الأسرة وما هي طلباتك القضائية المحددة؟';
          break;
        case 'rent':
          suggestedClarification = 'هل عقد الإيجار خاضع للقانون المدني رقم 4 لسنة 1996 أم لقوانين الإيجار القديمة؟';
          break;
        case 'criminal':
          suggestedClarification = 'هل تم تحرير محضر رسمي بقسم الشرطة أو النيابة العامة وما هو رقمه؟';
          break;
        case 'administrative':
          suggestedClarification = 'هل القرار المطعون فيه صادر من جهة إدارية عامة وخلال ميعاد الـ 60 يوماً؟';
          break;
        case 'constitutional':
          suggestedClarification = 'هل تم الدفع بعدم الدستورية أثناء نظر دعوى موضوعية قائمة بالفعل؟';
          break;
        default:
          suggestedClarification = 'ما هي المستندات والأدلة الكتابية المتوفرة لإثبات الواقعة أمام القضاء؟';
          break;
      }
    }

    const confidence = Math.min(
      0.99,
      0.7 + (colloquialHitCount * 0.1) + (finalConcepts.length * 0.05) + (highestDomainWeight * 0.02)
    );

    return {
      is_legal: true,
      domain: primaryDomain,
      mapped_legal_concepts: finalConcepts,
      applicable_laws: finalLaws,
      confidence: Number(confidence.toFixed(2)),
      reject_reason: null,
      clarification_question: suggestedClarification,
    };
  }

  // Non-legal or unclassifiable query
  if (nonLegalDetected) {
    const politeReject =
      `⚖️ **تنبيه التخصص القانوني:**\n\n` +
      `عذراً، أنا **المستشار القانوني حِكِمْدار**، نظام ذكاء اصطناعي مخصص ومقيد حصرياً للإجابة على **الاستفسارات القانونية، التشريعية، الدستورية، وإجراءات التقاضي في جمهورية مصر العربية**.\n\n` +
      `سؤالك يتعلق بمجال (${nonLegalCategoryLabel || 'خارج التخصص القانوني'}). يرجى التكرم بطرح استفسار يخص القوانين أو الدعاوى القضائية المصرية لنتمكن من مساعدتك.`;

    return {
      is_legal: false,
      domain: null,
      mapped_legal_concepts: [],
      applicable_laws: [],
      confidence: 0,
      reject_reason: politeReject,
      clarification_question: null,
    };
  }

  // Fallback rejection for non-legal or ambiguous inputs lacking any legal context
  return {
    is_legal: false,
    domain: null,
    mapped_legal_concepts: [],
    applicable_laws: [],
    confidence: 0,
    reject_reason: DEFAULT_REJECT_REASON,
    clarification_question: null,
  };
}

/**
 * Post-guard: Verifies generated citations against retrieved evidence chunks.
 * - Strips / flags hallucinated article citations not supported by retrieved chunks (fabrication kill-switch).
 * - If evidence_score < 0.65, sets action='disclaimer' and appends standard legal disclaimer.
 */
export function postGuard(
  generatedText: string,
  retrievedChunks: LegalChunk[],
  options?: PostGuardOptions
): PostGuardResult {
  const threshold = options?.threshold ?? 0.65;
  const flagPlaceholder = options?.flagPlaceholder ?? '[مادة غير موثقة]';
  const shouldAppendDisclaimer = options?.appendDisclaimer ?? true;

  if (!generatedText || typeof generatedText !== 'string') {
    return {
      action: 'disclaimer',
      evidence_score: 0,
      cleaned_text: STANDARD_LEGAL_DISCLAIMER,
      verified_citations: [],
      unverified_citations: [],
      disclaimer: STANDARD_LEGAL_DISCLAIMER,
    };
  }

  // 1. Verify citations using legalRag
  const citationResult = verifyCitations(generatedText, retrievedChunks || []);
  const evidenceScore = citationResult.evidenceScore;
  const unverified = citationResult.unverified;

  // 2. Strip / Flag fabricated article numbers
  let cleanedText = generatedText;

  for (const unverifiedArticle of unverified) {
    // Extract numeric part from unverified article string (e.g. "المادة 999" -> "999")
    const numMatch = normalizeArabicNumbers(unverifiedArticle).match(/\d+/);
    if (numMatch && numMatch[0]) {
      const num = numMatch[0];
      const easternNum = toEasternArabicNumerals(num);

      // Regex matching variations of "المادة 999" or "م 999" or "المادة رقم 999"
      const unverifiedRegex = new RegExp(
        `(?:المادتين|المادتان|المواد|المـ*ادة|مـ*ادة|م\\/|م\\s*)(?:\\s*رقم)?\\s*(?:${num}|${easternNum})`,
        'gu'
      );

      cleanedText = cleanedText.replace(unverifiedRegex, flagPlaceholder);
    }
  }

  // 3. Evaluate threshold and disclaimer requirement
  const isDisclaimerRequired = evidenceScore < threshold;
  const action: 'pass' | 'disclaimer' = isDisclaimerRequired ? 'disclaimer' : 'pass';
  const disclaimer = isDisclaimerRequired ? STANDARD_LEGAL_DISCLAIMER : null;

  if (isDisclaimerRequired && shouldAppendDisclaimer) {
    cleanedText = `${cleanedText.trim()}\n\n⚠️ **تنبيه قانوني:**\n${STANDARD_LEGAL_DISCLAIMER}`;
  }

  return {
    action,
    evidence_score: evidenceScore,
    cleaned_text: cleanedText,
    verified_citations: citationResult.verified,
    unverified_citations: unverified,
    disclaimer,
  };
}
