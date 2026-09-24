import re
DATE_RE = re.compile(r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b")
MONEY_RE = re.compile(r"(?:\b\d[\d,.]*\s*(?:جنيه|ريال|درهم|دولار|USD|SAR|AED|EGP)\b)", re.I)
PERCENT_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*%")

class ArabicNER:
    def __init__(self, model_name: str, enabled: bool = True):
        self.model_name = model_name
        self.enabled = enabled
        self._pipe = None
    def _load(self):
        if self._pipe is None and self.enabled:
            from transformers import pipeline
            self._pipe = pipeline("token-classification", model=self.model_name, aggregation_strategy="simple")
        return self._pipe
    def extract(self, text: str) -> dict:
        out = {"dates": DATE_RE.findall(text), "money": MONEY_RE.findall(text), "percentages": PERCENT_RE.findall(text), "entities": []}
        if self.enabled:
            try:
                for e in self._load()(text[:5000]):
                    out["entities"].append({"text": e.get("word", ""), "label": e.get("entity_group", e.get("entity", "")), "score": round(float(e.get("score", 0)), 4)})
            except Exception as exc:
                out["ner_warning"] = str(exc)
        return out
