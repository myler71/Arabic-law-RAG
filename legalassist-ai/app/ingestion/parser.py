from pathlib import Path
import io
import fitz
from docx import Document
from PIL import Image
from .cleaner import clean_text

def _parse_pdf(path: Path) -> list[dict]:
    pages = []
    with fitz.open(str(path)) as doc:
        for i, page in enumerate(doc):
            pages.append({"page": i + 1, "text": clean_text(page.get_text("text"))})
    return pages

def _ocr_pdf(path: Path) -> list[dict]:
    import pytesseract
    pages = []
    with fitz.open(str(path)) as doc:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            txt = pytesseract.image_to_string(img, lang="ara+eng")
            pages.append({"page": i + 1, "text": clean_text(txt)})
    return pages

def parse_document(path: str | Path, enable_ocr: bool = False) -> list[dict]:
    path = Path(path)
    ext = path.suffix.lower()
    if ext == ".pdf":
        pages = _parse_pdf(path)
        if enable_ocr and sum(len(p["text"]) for p in pages) < 50:
            pages = _ocr_pdf(path)
        return pages
    if ext == ".docx":
        doc = Document(str(path))
        text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
        return [{"page": 1, "text": clean_text(text)}]
    if ext in {".txt", ".md"}:
        return [{"page": 1, "text": clean_text(path.read_text(encoding="utf-8"))}]
    raise ValueError(f"Unsupported file type: {ext}")
