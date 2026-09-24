from app.models import SearchHit
def reciprocal_rank_fusion(vector_hits: list[SearchHit], bm25_hits: list[SearchHit], k: int = 60) -> list[SearchHit]:
    scores, chunks = {}, {}
    for hits in (vector_hits, bm25_hits):
        for rank, hit in enumerate(hits, 1):
            cid = hit.chunk.id; chunks[cid] = hit.chunk
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
    return [SearchHit(chunk=chunks[cid], score=score) for cid, score in sorted(scores.items(), key=lambda x: x[1], reverse=True)]
