from typing import Literal
from pydantic import BaseModel, Field

class Chunk(BaseModel):
    id: str
    document_id: str
    page: int
    section: str | None = None
    clause_id: str
    text: str

class Citation(BaseModel):
    document_id: str
    page: int
    clause_id: str
    section: str | None = None
    quote: str

class SearchHit(BaseModel):
    chunk: Chunk
    score: float

class RiskItem(BaseModel):
    risk_type: str
    severity: Literal["low", "medium", "high"]
    reason: str
    citation: Citation

class DiffItem(BaseModel):
    change_type: Literal["added", "removed", "modified", "unchanged"]
    old_clause: Chunk | None = None
    new_clause: Chunk | None = None
    similarity: float = 0.0
    impact: str = ""

class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation] = Field(default_factory=list)
