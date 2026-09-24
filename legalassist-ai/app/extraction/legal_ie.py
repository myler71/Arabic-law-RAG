import json
from app.llm.ollama_client import OllamaClient

SCHEMA_KEYS = [
    "parties",
    "dates",
    "obligations",
    "payment_terms",
    "termination",
    "liabilities",
    "penalties",
    "governing_law",
    "renewal",
    "confidentiality",
]


def extract_legal_information(
    llm: OllamaClient,
    text: str,
) -> dict:

    system = """
أنت نظام متخصص في استخراج المعلومات من العقود القانونية العربية.

القواعد:
- أخرج JSON صالح فقط.
- لا تستخدم Markdown.
- لا تكتب أي شرح خارج JSON.
- لا تستنتج أي معلومة غير موجودة صراحة في المستند.
- إذا لم تجد معلومة استخدم [].
- احتفظ بالنص الداعم في evidence.
- لا تقدم استشارة قانونية.
""".strip()

    expected_schema = {
        key: [
            {
                "value": "القيمة المستخرجة",
                "evidence": "النص الداعم من العقد",
            }
        ]
        for key in SCHEMA_KEYS
    }

    user = f"""
استخرج المعلومات القانونية التالية من النص:

{", ".join(SCHEMA_KEYS)}

يجب أن يكون الرد بنفس هذا الشكل:

{json.dumps(expected_schema, ensure_ascii=False, indent=2)}

النص القانوني:

{text[:18000]}
""".strip()

    raw = llm.chat(
        system=system,
        user=user,
        temperature=0,
    ).strip()

    # Remove possible Markdown fences
    if raw.startswith("```json"):
        raw = raw[len("```json"):]

    elif raw.startswith("```"):
        raw = raw[3:]

    if raw.endswith("```"):
        raw = raw[:-3]

    raw = raw.strip()

    try:
        data = json.loads(raw)

    except json.JSONDecodeError:
        # محاولة استخراج JSON لو الموديل كتب كلام قبله أو بعده
        start = raw.find("{")
        end = raw.rfind("}")

        if start != -1 and end != -1 and end > start:
            try:
                data = json.loads(
                    raw[start:end + 1]
                )
            except json.JSONDecodeError:
                data = {
                    key: []
                    for key in SCHEMA_KEYS
                }

                data["raw_model_output"] = raw

        else:
            data = {
                key: []
                for key in SCHEMA_KEYS
            }

            data["raw_model_output"] = raw

    for key in SCHEMA_KEYS:
        if key not in data:
            data[key] = []

        if data[key] is None:
            data[key] = []

    return data