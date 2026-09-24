from pathlib import Path
import hashlib, shutil
from app.core.config import settings
from app.ingestion.parser import parse_document
from app.ingestion.chunker import chunk_pages
from app.rag.embeddings import Embedder
from app.rag.vector_store import FaissStore
from app.rag.bm25 import BM25Store
from app.rag.hybrid_search import reciprocal_rank_fusion
from app.rag.reranker import Reranker
from app.rag.citations import context_block, keep_used_citations
from app.llm.ollama_client import OllamaClient
from app.llm.guardrails import LEGAL_SYSTEM, grounded_prompt
from app.analysis.risk_analyzer import analyze_risks
from app.extraction.ner import ArabicNER
from app.extraction.legal_ie import extract_legal_information
from app.comparison.diff_engine import compare_contracts

class LegalAssistService:
    def __init__(self):
        for p in [settings.storage_dir / "documents", settings.storage_dir / "indexes", settings.storage_dir / "metadata"]:
            p.mkdir(parents=True, exist_ok=True)
        self.embedder = Embedder(settings.embedding_model)
        self.vector = FaissStore(settings.storage_dir / "indexes")
        self.bm25 = BM25Store(settings.storage_dir / "indexes")
        self.reranker = Reranker(settings.reranker_model)
        self.llm = OllamaClient(settings.ollama_base_url, settings.ollama_model)
        self.ner = ArabicNER(settings.ner_model, settings.enable_ner)
    def _doc_id(self, path: Path): return hashlib.sha1(path.read_bytes()).hexdigest()[:16]
    def ingest(self, path: str | Path):
        path = Path(path); doc_id = self._doc_id(path)
        dest = settings.storage_dir / "documents" / f"{doc_id}{path.suffix.lower()}"
        if path.resolve() != dest.resolve(): shutil.copy2(path, dest)
        pages = parse_document(dest, settings.enable_ocr)
        chunks = chunk_pages(doc_id, pages)
        if not chunks: raise ValueError("No extractable text found in document")
        vectors = self.embedder.encode([c.text for c in chunks])
        self.vector.save(doc_id, vectors, chunks); self.bm25.save(doc_id, chunks)
        return doc_id, chunks
    def load_chunks(self, doc_id): return self.vector.load(doc_id)[1]
    def search(self, doc_id, question):
        qv = self.embedder.encode([question])[0]
        vh = self.vector.search(doc_id, qv, settings.top_k_vector)
        bh = self.bm25.search(doc_id, question, settings.top_k_bm25)
        return self.reranker.rerank(question, reciprocal_rank_fusion(vh, bh), settings.top_k_rerank)
    def ask(self, doc_id, question):
        hits = self.search(doc_id, question); chunks = [h.chunk for h in hits]
        answer = self.llm.chat(LEGAL_SYSTEM, grounded_prompt(question, context_block(chunks)))
        return {"answer": answer, "citations": [c.model_dump() for c in keep_used_citations(answer, chunks)]}
    def analyze(self, doc_id):
        chunks = self.load_chunks(doc_id); text = "\n\n".join(c.text for c in chunks)
        return {"ner": self.ner.extract(text[:12000]), "structured": extract_legal_information(self.llm, text), "risks": [r.model_dump() for r in analyze_risks(chunks)]}
    def compare(self, old_id, new_id):
        return [d.model_dump() for d in compare_contracts(self.load_chunks(old_id), self.load_chunks(new_id), self.embedder)]
