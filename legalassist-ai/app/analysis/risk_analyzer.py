import re
from app.models import Chunk, RiskItem
from app.rag.citations import citation_from_chunk
RULES = [
    ("automatic_renewal", "medium", re.compile(r"(?:تجدد|يتجدد|تمديد).{0,45}(?:تلقائ|آلي|automatically)", re.I), "يتضمن البند تجديداً تلقائياً أو آلياً."),
    ("high_penalty", "high", re.compile(r"(?:غرامة|جزاء|penalt).{0,80}(?:\d+(?:[.,]\d+)?\s*%|\d[\d,.]+)", re.I), "يتضمن البند التزاماً جزائياً أو غرامة مالية؛ يلزم التحقق من مقدارها وشروط تطبيقها."),
    ("broad_liability", "high", re.compile(r"(?:مسؤول(?:ية|اً)|liable|liability).{0,80}(?:كافة|جميع|أي وجميع|غير محدود|unlimited|all)", re.I), "قد تكون صياغة المسؤولية واسعة أو غير محدودة."),
    ("termination", "medium", re.compile(r"(?:فسخ|إنهاء|انهاء|termination).{0,100}", re.I), "يوجد شرط إنهاء/فسخ يستحق المراجعة من حيث الإشعار والآثار."),
    ("confidentiality", "medium", re.compile(r"(?:سرية|سري|confidential).{0,120}", re.I), "يتضمن العقد التزاماً بالسرية وقد تكون له قيود أو مدة تستحق المراجعة."),
]
def analyze_risks(chunks: list[Chunk]) -> list[RiskItem]:
    out = []
    for c in chunks:
        for typ, sev, pat, reason in RULES:
            if pat.search(c.text):
                out.append(RiskItem(risk_type=typ, severity=sev, reason=reason, citation=citation_from_chunk(c)))
    out.sort(key=lambda x: {"high": 0, "medium": 1, "low": 2}[x.severity])
    return out
