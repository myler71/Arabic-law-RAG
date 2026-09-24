import json
from pathlib import Path
from rank_bm25 import BM25Okapi
from app.models import Chunk, SearchHit
from app.ingestion.cleaner import tokenize
class BM25Store:
    def __init__(self, base_dir):
        self.base = Path(base_dir); self.base.mkdir(parents=True, exist_ok=True)
    def save(self, document_id: str, chunks: list[Chunk]):
        (self.base / f"{document_id}.bm25.json").write_text(json.dumps([c.model_dump() for c in chunks], ensure_ascii=False), encoding="utf-8")
    def search(self, document_id: str, query: str, k: int = 20) -> list[SearchHit]:
        chunks = [Chunk(**x) for x in json.loads((self.base / f"{document_id}.bm25.json").read_text(encoding="utf-8"))]
        bm = BM25Okapi([tokenize(c.text) for c in chunks])
        scores = bm.get_scores(tokenize(query))
        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:min(k, len(chunks))]
        return [SearchHit(chunk=chunks[i], score=float(scores[i])) for i in order]
