from app.models import Chunk, Citation
def source_id(c: Chunk) -> str:
    return f"{c.document_id}:p{c.page}:{c.clause_id}"
def context_block(chunks: list[Chunk]) -> str:
    return "\n\n".join(f"[{source_id(c)}]\n{c.text}" for c in chunks)
def citation_from_chunk(c: Chunk) -> Citation:
    return Citation(document_id=c.document_id, page=c.page, clause_id=c.clause_id, section=c.section, quote=c.text[:280])
def keep_used_citations(answer: str, chunks: list[Chunk]) -> list[Citation]:
    used = [citation_from_chunk(c) for c in chunks if f"[{source_id(c)}]" in answer]
    return used or [citation_from_chunk(c) for c in chunks[:3]]
