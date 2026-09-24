from app.models import SearchHit
class Reranker:
    def __init__(self, model_name: str):
        self.model_name = model_name; self._model = None
    def _load(self):
        if self._model is None:
            from sentence_transformers import CrossEncoder
            self._model = CrossEncoder(self.model_name, trust_remote_code=True)
        return self._model
    def rerank(self, query: str, hits: list[SearchHit], top_k: int = 6) -> list[SearchHit]:
        if not hits: return []
        try:
            scores = self._load().predict([[query, h.chunk.text] for h in hits])
            ranked = sorted(zip(hits, scores), key=lambda x: float(x[1]), reverse=True)[:top_k]
            return [SearchHit(chunk=h.chunk, score=float(s)) for h, s in ranked]
        except Exception:
            return hits[:top_k]
