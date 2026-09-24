import re
from app.models import Chunk
from .cleaner import clean_text

CLAUSE_START = re.compile(r"(?m)^(?:\s*(?:المادة|البند|مادة|بند|Article|Clause)\s*[\(\[]?([\d٠-٩]+)[\)\]]?[^\n]*|\s*[\(\[]?([\d٠-٩]+)[\)\]]?\s*[-–:.])")

def _split_page(text: str, max_chars: int = 1400) -> list[str]:
    text = clean_text(text)
    if not text:
        return []
    starts = [m.start() for m in CLAUSE_START.finditer(text)]
    if starts:
        starts.append(len(text))
        parts = [text[starts[i]:starts[i + 1]].strip() for i in range(len(starts) - 1)]
    else:
        parts = re.split(r"\n\s*\n+", text)
    out = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if len(part) <= max_chars:
            out.append(part)
            continue
        sentences = re.split(r"(?<=[.!؟؛])\s+", part)
        buf = ""
        for s in sentences:
            if buf and len(buf) + len(s) + 1 > max_chars:
                out.append(buf.strip())
                buf = s
            else:
                buf = (buf + " " + s).strip()
        if buf:
            out.append(buf.strip())
    return out

def chunk_pages(document_id: str, pages: list[dict]) -> list[Chunk]:
    chunks = []
    n = 1
    for page in pages:
        for part in _split_page(page["text"]):
            first = part.splitlines()[0][:100] if part else ""
            section = first if any(k in first.lower() for k in ["المادة", "البند", "article", "clause"]) else None
            chunks.append(Chunk(id=f"{document_id}:{n}", document_id=document_id, page=page["page"], section=section, clause_id=f"C{n:04d}", text=part))
            n += 1
    return chunks
