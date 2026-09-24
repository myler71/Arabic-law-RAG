# ⚖️ HAKMDAR Egyptian Legal AI — Offline Evaluation Suite

Offline evaluation suite for the **HAKMDAR (حِكِمْدار)** Egyptian Legal AI platform. It evaluates safety classification, Egyptian colloquial phrase mapping, legal evidence retrieval, citation verification, and disclaimer enforcement across **57 curated scenarios** covering core Egyptian legal domains and out-of-domain (OOD) controls.

---

## 🚀 How to Run

The evaluation suite runs **100% offline** without any external LLM dependencies, API keys, or remote network requests.

### 1. Standalone Runner (Recommended)
```bash
npx tsx evaluation/runner.ts
```

### 2. Automated Vitest Test
```bash
npx vitest run tests/api/evaluation-suite.test.ts
```

---

## 📊 Metric Definitions & Target Thresholds

| Metric | Definition | Baseline Target | Achieved Score | Status |
|---|---|---|---|---|
| **Guard Precision** | $\frac{\text{TP}}{\text{TP} + \text{FP}}$ — ratio of genuine legal queries among all queries classified as legal. | **$\ge 90.0\%$** | **$100.0\%$** | ✅ PASS |
| **OOD Block Rate** | $\frac{\text{TN}}{\text{TN} + \text{FP}}$ — zero-leakage guarantee ensuring non-legal queries are strictly blocked. | **$= 100.0\%$** | **$100.0\%$** | ✅ PASS |
| **Retrieval Recall@5** | Average proportion of expected statutory article anchors found in the top 5 retrieved evidence chunks. | **$\ge 80.0\%$** | **$98.5\%$** | ✅ PASS |
| **Guard Recall** | $\frac{\text{TP}}{\text{TP} + \text{FN}}$ — proportion of valid legal questions correctly identified. | **$\ge 90.0\%$** | **$100.0\%$** | ✅ PASS |
| **Citation Verification Rate** | Percentage of top-evidence statutory citations successfully validated by `verifyCitations`. | **$\ge 90.0\%$** | **$100.0\%$** | ✅ PASS |
| **Disclaimer Trigger Rate** | Enforcement rate asserting that evidence scores $< 0.65$ trigger `action='disclaimer'` in `postGuard`. | **$\ge 90.0\%$** | **$100.0\%$** | ✅ PASS |
| **Domain Classification Accuracy** | Accuracy of domain routing across 8 Egyptian legal taxonomy domains. | **$\ge 85.0\%$** | **$100.0\%$** | ✅ PASS |

---

## 📁 Scenario Dataset Composition (`evaluation/scenarios.json`)

Total scenarios: **57** (48 legal scenarios + 9 OOD controls). Every scenario ID is unique.

1. **Labor & Employment Law (`labor`) — 16 scenarios (Target: $\ge 15$):**
   - Wrongful & arbitrary termination (فصل تعسفي - المواد 69، 71، 122).
   - Notice periods & compensation in lieu (مهلة الإخطار وبدل الإخطار - المواد 110، 111، 116).
   - Withholding personnel papers & experience certificates (احتجاز مسوغات التعيين - المادتان 32، 123).
   - Probationary period limits (فترة الاختبار - المادة 31).
   - Disciplinary investigation guarantees & wage deductions (التحقيق التأديبي والخصم - المواد 40، 68).
   - Overtime and working hours (ساعات العمل الإضافية).
   - Company liquidation and contract continuity (تصفية المنشأة والمسؤولية التضامنية - المادة 129).
   - Retirement severance at age 60 (مكافأة نهاية الخدمة - المادتان 126، 127).
   - Retaliatory dismissal for labor complaints (حظر الفصل الانتقامي - المادة 117).
   - Rescinding written resignations within 7 days (العدول عن الاستقالة - المادة 119).
   - Implicit contract renewal (تحول العقد إلى غير محدد المدة - المادة 105).
   - Annual leave cash-out (مقابل رصيد الإجازات السنوية - المادتان 47، 48).
   - Egyptian colloquial termination phrases ("طردني من الشغل", "سرحوني", "مشوني فجأة", "فصلني").

2. **Commercial Law, Checks & Trust Receipts (`commercial`) — 9 scenarios (Target: $\ge 6$):**
   - Bounced checks and bank insufficiency certificates (شيك مرتجع وشيك بدون رصيد - المادة 534 من قانون التجارة 17/1999).
   - Blank promissory notes and breach of trust (إيصال أمانة على بياض - المادة 341 عقوبات والطعن بالتزوير الصلبي).
   - Trust receipt colloquial variant ("القائمة").
   - Joint-stock company capital requirements (قانون الشركات 159/1981).
   - Niche international arbitration and cryptocurrency banking regulations (المادة 194 لسنة 2020).

3. **Civil Law & Lease Disputes (`civil` / `rent`) — 6 scenarios (Target: $\ge 6$):**
   - Tenant refusing to vacate post lease expiry under Law 4/1996 ("مأجر ومبيخرجش").
   - Squatter eviction without title (طرد للغصب).
   - Unpaid rent arrears and lease cancellation (المادة 157 مدني).
   - Security deposit refund upon handover.
   - Unilateral rent increases and pacta sunt servanda (المادة 147 مدني).

4. **Personal Status & Family Law (`personal_status`) — 6 scenarios (Target: $\ge 5$):**
   - Deferred dowry claim (مؤخر الصداق بعد الطلاق).
   - Spousal and child maintenance (نفقة زوجية ونفقة صغار).
   - Khula requirements (دعوى الخلع - المادة 20 من القانون 1 لسنة 2000).
   - Imprisonment for unpaid maintenance (حبس متجمد النفقة).
   - Child visitation regulations (حق الرؤية والاستضافة بمراكز الشباب).
   - Marital furniture list claim (قائمة المنقولات الزوجية واسترداد عفش الزوجية).

5. **Contract Disputes (`contract`) — 5 scenarios (Target: $\ge 5$):**
   - Contract rescission for non-payment (فسخ العقد وإعادة الحال - المادتان 147، 157 مدني).
   - Liquidated damages clause reduction (الشرط الجزائي وتعديله قضائياً - المادة 224 مدني).
   - Binding force of contracts (العقد شريعة المتعاقدين - المادة 147 مدني).
   - Annulment for fraud and earnest money restitution (بطلان العقد للتدليس والغش).
   - Signature authenticity verification (دعوى صحة توقيع).

6. **Procedural & Constitutional Law (`procedural`) — 6 scenarios (Target: $\ge 5$):**
   - Civil prescription / statute of limitations (التقادم المسقط للحقوق المدنية).
   - Labor office 10-day complaint deadline and amicable settlement (مواعيد شكوى مكتب العمل - المادة 70).
   - State Council 60-day administrative cancellation deadline (المادة 10 من قانون مجلس الدولة 47/1972).
   - Constitutional right to litigation & anti-immunity clause (المادة 97 من دستور 2014).
   - Criminal misdemeanor prescription after 3 years (تقادم الدعوى الجنائية وسقوط العقوبة).
   - Civil appeal deadlines (مواعيد الطعن بالاستئناف في قانون المرافعات).

7. **Out-of-Domain (OOD) Negative Controls (`ood`) — 9 scenarios (Target: $\ge 8$):**
   - Cooking & recipes (المكرونة بالبشاميل، صينية كيك الشوكولاتة).
   - Programming & code generation (Python prime numbers, JavaScript binary search).
   - Sports & football (مباراة الأهلي والزمالك في دوري أبطال أفريقيا).
   - Weather & climate forecasts (حالة الطقس ودرجات الحرارة).
   - Music & poetry lyrics (كلمات أغنية لأم كلثوم).
   - Jokes & comedy entertainment (نكت مضحكة ومسرحية كوميدية).
   - Medical advice (استشارة طبية لصداع وسخونية ووصف دواء).

---

## 📝 Generated Output Reports

Each run automatically writes two reports to `evaluation/reports/`:
- **`latest.json`**: Machine-readable JSON summary containing full execution metadata, per-category statistics, and failure traces.
- **`latest.md`**: Human-readable Markdown report table summarizing metrics, category breakdowns, and pass/fail statuses.
