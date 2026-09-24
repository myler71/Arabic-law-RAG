from difflib import SequenceMatcher
import numpy as np
from app.models import Chunk, DiffItem
from app.rag.embeddings import Embedder

def _cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

def compare_contracts(old: list[Chunk], new: list[Chunk], embedder: Embedder, threshold: float = 0.72) -> list[DiffItem]:
    if not old and not new: return []
    oldv = embedder.encode([c.text for c in old]) if old else np.empty((0, 1), dtype="float32")
    newv = embedder.encode([c.text for c in new]) if new else np.empty((0, 1), dtype="float32")
    used_new, diffs = set(), []
    for i, oc in enumerate(old):
        best_j, best = None, -1.0
        for j, nc in enumerate(new):
            if j in used_new: continue
            s = _cos(oldv[i], newv[j])
            if s > best: best_j, best = j, s
        if best_j is not None and best >= threshold:
            used_new.add(best_j); nc = new[best_j]
            lexical = SequenceMatcher(None, oc.text, nc.text).ratio()
            typ = "unchanged" if lexical > 0.985 else "modified"
            impact = "لا تغيير جوهري ظاهر." if typ == "unchanged" else "تم تعديل صياغة البند؛ راجع الفرق والأثر قبل الاعتماد."
            diffs.append(DiffItem(change_type=typ, old_clause=oc, new_clause=nc, similarity=best, impact=impact))
        else:
            diffs.append(DiffItem(change_type="removed", old_clause=oc, similarity=max(best, 0.0), impact="البند موجود في النسخة القديمة ولم يظهر له مقابل موثوق في الجديدة."))
    for j, nc in enumerate(new):
        if j not in used_new:
            diffs.append(DiffItem(change_type="added", new_clause=nc, impact="بند جديد في النسخة الجديدة."))
    diffs.sort(key=lambda x: {"modified": 0, "added": 1, "removed": 2, "unchanged": 3}[x.change_type])
    return diffs
