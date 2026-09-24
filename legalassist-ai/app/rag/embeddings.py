import numpy as np
class Embedder:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self._model = None
    def _load(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_name)
        return self._model
    def encode(self, texts: list[str]) -> np.ndarray:
        arr = self._load().encode(texts, normalize_embeddings=True, show_progress_bar=False)
        return np.asarray(arr, dtype="float32")
