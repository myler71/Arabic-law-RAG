from pathlib import Path
import json, faiss, numpy as np
from app.models import Chunk, SearchHit
class FaissStore:
    def __init__(self, base_dir):
        self.base = Path(base_dir); self.base.mkdir(parents=True, exist_ok=True)
    def save(self, document_id: str, vectors: np.ndarray, chunks: list[Chunk]):
        index = faiss.IndexFlatIP(vectors.shape[1]); index.add(vectors)
        faiss.write_index(index, str(self.base / f"{document_id}.faiss"))
        (self.base / f"{document_id}.json").write_text(json.dumps([c.model_dump() for c in chunks], ensure_ascii=False), encoding="utf-8")
    def load(self, document_id: str):
        index = faiss.read_index(str(self.base / f"{document_id}.faiss"))
        chunks = [Chunk(**x) for x in json.loads((self.base / f"{document_id}.json").read_text(encoding="utf-8"))]
        return index, chunks
    def search(self, document_id: str, qvec: np.ndarray, k: int = 20) -> list[SearchHit]:
        index, chunks = self.load(document_id); k = min(k, len(chunks))
        scores, ids = index.search(qvec.reshape(1, -1), k)
        return [SearchHit(chunk=chunks[int(i)], score=float(s)) for s, i in zip(scores[0], ids[0]) if i >= 0]
