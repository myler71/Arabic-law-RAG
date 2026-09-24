import re
AR_DIACRITICS = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED]")

def clean_text(text: str) -> str:
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def normalize_arabic(text: str) -> str:
    text = AR_DIACRITICS.sub("", text)
    text = re.sub("[إأآٱ]", "ا", text)
    text = text.replace("ى", "ي")
    return re.sub(r"\s+", " ", text).strip().lower()

def tokenize(text: str) -> list[str]:
    return re.findall(r"[\w\u0600-\u06FF]+", normalize_arabic(text))
