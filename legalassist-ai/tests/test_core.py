from app.ingestion.cleaner import normalize_arabic, tokenize
from app.ingestion.chunker import chunk_pages
from app.models import Chunk, SearchHit
from app.rag.hybrid_search import reciprocal_rank_fusion

def test_normalize(): assert normalize_arabic("إلتِزام  آلي") == "التزام الي"
def test_tokenize(): assert "العقد" in tokenize("هذا العقد ساري")
def test_chunk_pages():
    pages = [{"page": 1, "text": "البند 1: الدفع\nيلتزم الطرف الثاني بالسداد.\n\nالبند 2: الإنهاء\nيجوز الإنهاء بإشعار."}]
    chunks = chunk_pages("x", pages)
    assert len(chunks) >= 2 and chunks[0].page == 1
def test_rrf_prefers_overlap():
    a = Chunk(id="a", document_id="d", page=1, clause_id="C1", text="a")
    b = Chunk(id="b", document_id="d", page=1, clause_id="C2", text="b")
    out = reciprocal_rank_fusion([SearchHit(chunk=a, score=1), SearchHit(chunk=b, score=.5)], [SearchHit(chunk=a, score=2)])
    assert out[0].chunk.id == "a"
