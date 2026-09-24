from pathlib import Path
import tempfile
from fastapi import FastAPI, UploadFile, File, HTTPException
from pydantic import BaseModel
from app.service import LegalAssistService
app = FastAPI(title="LegalAssist AI Local", version="0.1.0")
svc = LegalAssistService()
class ChatReq(BaseModel): document_id: str; question: str
class AnalyzeReq(BaseModel): document_id: str
class CompareReq(BaseModel): old_document_id: str; new_document_id: str
@app.get("/health")
def health(): return {"status": "ok", "ollama": svc.llm.health()}
@app.post("/documents")
async def upload(file: UploadFile = File(...)):
    suffix = Path(file.filename or "document.pdf").suffix.lower()
    if suffix not in {".pdf", ".docx", ".txt", ".md"}: raise HTTPException(400, "Unsupported file type")
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(await file.read()); tmp = f.name
    try:
        doc_id, chunks = svc.ingest(tmp); return {"document_id": doc_id, "chunks": len(chunks)}
    finally:
        Path(tmp).unlink(missing_ok=True)
@app.post("/chat")
def chat(req: ChatReq): return svc.ask(req.document_id, req.question)
@app.post("/analyze")
def analyze(req: AnalyzeReq): return svc.analyze(req.document_id)
@app.post("/compare")
def compare(req: CompareReq): return svc.compare(req.old_document_id, req.new_document_id)
