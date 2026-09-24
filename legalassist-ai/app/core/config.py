from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen3:8b"
    embedding_model: str = "BAAI/bge-m3"
    reranker_model: str = "BAAI/bge-reranker-v2-m3"
    ner_model: str = "CAMeL-Lab/bert-base-arabic-camelbert-msa-ner"
    top_k_vector: int = 20
    top_k_bm25: int = 20
    top_k_rerank: int = 6
    enable_ner: bool = True
    enable_ocr: bool = False
    storage_dir: Path = Path("storage")
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

settings = Settings()
