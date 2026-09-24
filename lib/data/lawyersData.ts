import { LawyerProfile } from '../types';

export const MOCK_LAWYERS: LawyerProfile[] = [
  {
    id: 'lawyer-1',
    name: 'المستشار / طارق عبد العزيز القاضي',
    title: 'محامٍ بالنقض والدستورية العليا - خبير قضايا العمل والشركات',
    email: 'tarek.kadi@hakmdar-law.eg',
    phone: '+20 100 234 5678',
    avatar: 'https://images.unsplash.com/photo-1556157382-97eda2d62296?auto=format&fit=crop&q=80&w=400',
    location: 'القاهرة (مصر الجديدة والتجمع الخامس)',
    address: 'شارع الثورة، الكوربة، مصر الجديدة، القاهرة',
    barNumber: 'EG-BAR-104928',
    experienceYears: 18,
    specialties: ['labor', 'corporate', 'commercial', 'civil'],
    bio: 'متخصص في قضايا النزاعات العمالية الكبرى، حوكمة الشركات وتأسيس الكيانات الاستثمارية، والطعون أمام محكمة النقض. حاصل على ماجستير القانون التجاري والدولي من جامعة القاهرة، ومقيد أمام محكمة النقض والدستورية العليا منذ أكثر من 10 سنوات.',
    rating: 4.9,
    reviewCount: 142,
    winRate: 94,
    activeCasesCount: 12,
    totalResolvedCases: 380,
    consultationFee: 750,
    languages: ['العربية', 'English', 'Français'],
    education: [
      'ليسانس الحقوق - جامعة القاهرة (مرتبة الشرف)',
      'ماجستير القانون الخاص والتحكيم التجاري الدولي',
      'عضو اتحاد المحامين العرب والجمعية المصرية للقانون الدولي'
    ],
    featuredCases: [
      {
        title: 'نزاع عمالي جماعي وتعويض فصل تعسفي لـ 45 موظفاً',
        category: 'labor',
        outcome: 'تم كسب الحكم بإلزام الشركة بتعويضات كاملة بقيمة 4.2 مليون جنيه',
        year: '2023'
      },
      {
        title: 'استحواذ ودمج شركة برمجيات مع مستثمر أجنبي',
        category: 'corporate',
        outcome: 'إتمام الصفقة وصياغة اتفاقيات الشركاء بقيمة 2.5 مليون دولار',
        year: '2024'
      }
    ],
    reviews: [
      {
        id: 'rev-1',
        clientName: 'م. أحمد الشناوي',
        rating: 5,
        date: 'منذ أسبوعين',
        comment: 'أستاذ طارق متمكن للغاية من تفاصيل قانون العمل. استلم ملخص قضيتي المُعد عبر ذكاء حكمدار وقام بتمثيلي وحصلنا على الحكم في وقت قياسي.',
        caseCategory: 'قضايا العمل'
      },
      {
        id: 'rev-2',
        clientName: 'أ. دينا الشريف',
        rating: 5,
        date: 'منذ شهر',
        comment: 'دقة واحترافية عالية في صياغة العقود التجارية وتسوية الخلاف الودي مع الشريك قبل الوصول للمحكمة.',
        caseCategory: 'الشركات'
      }
    ]
  },
  {
    id: 'lawyer-2',
    name: 'المستشارة / نهى سمير المنشاوي',
    title: 'محامية بالاستئناف العالي ومجلس الدولة - متخصصة في الأحوال الشخصية والمدني',
    email: 'noha.menshawy@hakmdar-law.eg',
    phone: '+20 111 876 5432',
    avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&q=80&w=400',
    location: 'الجيزة (الدقي والشيخ زايد)',
    address: 'شارع مصدق، الدقي، الجيزة',
    barNumber: 'EG-BAR-193847',
    experienceYears: 14,
    specialties: ['family', 'civil', 'real_estate'],
    bio: 'محامية متمرسة في قضايا الأسرة والأحوال الشخصية المعقدة، دعاوى الميراث والتركات، والنزاعات العقارية وعقود البيع والملكية. تتميز بقدرة فائقة على تقديم الاستشارات الاستراتيجية وتسريع وتيرة التقاضي أمام محاكم الأسرة والمدني.',
    rating: 4.85,
    reviewCount: 98,
    winRate: 92,
    activeCasesCount: 9,
    totalResolvedCases: 240,
    consultationFee: 600,
    languages: ['العربية', 'English'],
    education: [
      'ليسانس الحقوق - جامعة عين شمس',
      'دبلوم القانون المدني والعلوم الجنائية',
      'عضو لجنة المرأة بنقابة المحامين العامة'
    ],
    featuredCases: [
      {
        title: 'قسمة تركة عقارية معقدة وتحصيل مستحقات الورثة',
        category: 'family',
        outcome: 'تسوية رضائية وتثبيت ملكية الورثة لأصول بقيمة 18 مليون جنيه',
        year: '2023'
      },
      {
        title: 'دعوى استرداد حيازة وإبطال عقد بيع صوري',
        category: 'real_estate',
        outcome: 'حكم نهائي بالاستئناف بطرد المغتصب ورد العقار لمالكه الأصلي',
        year: '2024'
      }
    ],
    reviews: [
      {
        id: 'rev-3',
        clientName: 'أ. مريم فؤاد',
        rating: 5,
        date: 'منذ 3 أسابيع',
        comment: 'الأستاذة نهى قمة في الرقي والوضوح. شرحت لي كل بنود القضية والخطوات القانونية واستلمت الملف الجاهز من الذكاء الاصطناعي مباشرة.',
        caseCategory: 'الأحوال الشخصية'
      }
    ]
  },
  {
    id: 'lawyer-3',
    name: 'المستشار / كريم محمود الباشا',
    title: 'محامٍ بالنقض الجنائي والاقتصادي - خبير الجرائم المالية والشيكات',
    email: 'karim.basha@hakmdar-law.eg',
    phone: '+20 122 987 6543',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=400',
    location: 'الإسكندرية (سموحة والمنشية)',
    address: 'شارع فوزي معاذ، سموحة، الإسكندرية',
    barNumber: 'EG-BAR-084729',
    experienceYears: 21,
    specialties: ['criminal', 'commercial', 'tax'],
    bio: 'أحد أبرز المحامين الجنائيين في الإسكندرية والقاهرة في قضايا الجرائم المالية، جنح الشيكات وإيصالات الأمانة، التهرب الضريبي والجمركي، والجرائم الإلكترونية. يمتلك خبرة تتجاوز عقدين في الدفاع أمام دوائر الجنايات والمحاكم الاقتصادية.',
    rating: 4.95,
    reviewCount: 210,
    winRate: 96,
    activeCasesCount: 15,
    totalResolvedCases: 520,
    consultationFee: 900,
    languages: ['العربية', 'English'],
    education: [
      'ليسانس الحقوق - جامعة الإسكندرية',
      'دبلوم العلوم الجنائية والجرائم المالية المستحدثة',
      'دكتوراه فخرية في القانون الجنائي المقارن'
    ],
    featuredCases: [
      {
        title: 'البراءة في قضية شيكات تجارية بقيمة 6 ملايين جنيه',
        category: 'criminal',
        outcome: 'حكم بالبراءة لانقضاء الدعوى الجنائية والدفع بانتفاء الركن المعنوي',
        year: '2023'
      },
      {
        title: 'الطعن بالنقض في جنحة تهرب ضريبي لشركة استيراد',
        category: 'tax',
        outcome: 'قبول النقض وإعادة المحاكمة ثم القضاء بالبراءة',
        year: '2024'
      }
    ],
    reviews: [
      {
        id: 'rev-4',
        clientName: 'رجل الأعمال / وائل سالم',
        rating: 5,
        date: 'منذ شهرين',
        comment: 'محامٍ من الطراز الرفيع، درايته بأحكام النقض الجنائية حمت شركتنا من نزاع تجاري كان سيسبب خسائر فادحة.',
        caseCategory: 'القانون الجنائي والتجاري'
      }
    ]
  },
  {
    id: 'lawyer-4',
    name: 'المستشار / ياسر فاروق التميمي',
    title: 'محامٍ بالاستئناف - خبير القضاء الإداري والنزاعات العقارية',
    email: 'yasser.tamimi@hakmdar-law.eg',
    phone: '+20 109 456 1234',
    avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=400',
    location: 'المنصورة والدلتا',
    address: 'شارع الجمهورية، المنصورة، الدقهلية',
    barNumber: 'EG-BAR-145621',
    experienceYears: 12,
    specialties: ['administrative', 'real_estate', 'civil'],
    bio: 'متخصص في قضايا مجلس الدولة والطعون على القرارات الإدارية، نزاعات تراخيص البناء، التعويض عن نزع الملكية للمنفعة العامة، وصحة ونفاذ عقود العقارات والأراضي الزراعية والصناعية.',
    rating: 4.8,
    reviewCount: 76,
    winRate: 91,
    activeCasesCount: 8,
    totalResolvedCases: 190,
    consultationFee: 500,
    languages: ['العربية'],
    education: [
      'ليسانس الحقوق - جامعة المنصورة',
      'دبلوم القانون العام والعلوم الإدارية'
    ],
    featuredCases: [
      {
        title: 'إلغاء قرار إداري بوقف ترخيص مشروع صناعي',
        category: 'administrative',
        outcome: 'حكم محكمة القضاء الإداري بإلغاء القرار وإلزام الجهة بالتعويض',
        year: '2023'
      }
    ],
    reviews: [
      {
        id: 'rev-5',
        clientName: 'م. حسام البحيري',
        rating: 5,
        date: 'منذ شهر',
        comment: 'سرعة استجابة ومتابعة حثيثة أمام محكمة القضاء الإداري بالمنصورة.',
        caseCategory: 'القضاء الإداري'
      }
    ]
  },
  {
    id: 'lawyer-5',
    name: 'المستشارة / سارة هشام عبد النور',
    title: 'محامية متخصصة في الملكية الفكرية والعلامات التجارية والشركات الناشئة',
    email: 'sara.abdelnour@hakmdar-law.eg',
    phone: '+20 114 555 7890',
    avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&q=80&w=400',
    location: 'القاهرة (المعادي والقرية الذكية)',
    address: 'شارع 9، المعادي، القاهرة',
    barNumber: 'EG-BAR-210493',
    experienceYears: 10,
    specialties: ['intellectual_property', 'corporate', 'commercial'],
    bio: 'خبيرة رائدة في تسجيل وحماية العلامات التجارية وبراءات الاختراع، حقوق الملكية الفكرية الرقمية، وصياغة اتفاقيات سرية المعلومات (NDA) وجولات الاستثمار للشركات الناشئة في مصر والشرق الأوسط.',
    rating: 4.9,
    reviewCount: 88,
    winRate: 95,
    activeCasesCount: 11,
    totalResolvedCases: 175,
    consultationFee: 700,
    languages: ['العربية', 'English'],
    education: [
      'ليسانس الحقوق - القسم الإنجليزي جامعة عين شمس',
      'ماجستير الملكية الفكرية وقانون التكنولوجيا - بريطانيا'
    ],
    featuredCases: [
      {
        title: 'وقف تعدي على علامة تجارية مسجلة لتطبيق إلكتروني',
        category: 'intellectual_property',
        outcome: 'أمر وقتي بوقف المنتجات المقلدة وحكم تعويض بالمحكمة الاقتصادية',
        year: '2024'
      }
    ],
    reviews: [
      {
        id: 'rev-6',
        clientName: 'كريم البنا (مؤسس تطبيق تقني)',
        rating: 5,
        date: 'منذ أسبوعين',
        comment: 'أفضل مستشارة قانونية للشركات التقنية والناشئة بدون منازع.',
        caseCategory: 'الملكية الفكرية'
      }
    ]
  }
];
