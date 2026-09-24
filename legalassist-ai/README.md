LegalAssist AI — Local Arabic Legal Document Intelligence

A local-first project for analyzing Arabic contracts and legal documents without AWS or the OpenAI API. After downloading the models for the first time, analysis, search, and generation can run entirely locally.

Features

PDF / DOCX / TXT parsing

Arabic text cleaning + clause-aware chunking

Local Arabic NER using CAMeLBERT + Regex for money, dates, and percentages

Structured JSON information extraction using a local LLM

Hybrid Search: FAISS semantic retrieval + BM25 keyword retrieval

Reciprocal Rank Fusion followed by local reranking

Citation-grounded chat with page + clause IDs

Rule-based contract risk flags linked to supporting evidence

Contract version comparison: added / removed / modified / unchanged

Guardrails that prevent unsupported answers and clearly state that outputs are not definitive legal advice

FastAPI + Streamlit UI

Default Models

LLM: qwen3:8b via Ollama

Embeddings: BAAI/bge-m3

Reranker: BAAI/bge-reranker-v2-m3

Arabic NER: CAMeL-Lab/bert-base-arabic-camelbert-msa-ner

Windows Quick Start

python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
ollama pull qwen3:8b
streamlit run ui/streamlit_app.py

To run the API instead of the UI:

uvicorn app.api.main:app --reload --host 127.0.0.1 --port 8000

OCR

By default, ENABLE_OCR=false. If the contract is an image-only PDF, install Tesseract locally with the Arabic language pack, then change the setting to true. Images are not sent to any external service.

API

POST /documents

POST /analyze

POST /chat

POST /compare

GET /health

RAG Pipeline

Question → BGE-M3 → FAISS Top-K + BM25 Top-K → RRF → BGE reranker → Top clauses → Qwen3 local → grounded answer + citations.

Each chunk keeps document_id, page, clause_id, section, and text metadata so citations can be verified easily.

Notes

The Risk Engine is intentionally conservative: it flags potential risks and shows the supporting evidence, but does not make definitive legal judgments.

Version comparison uses semantic clause matching followed by lexical comparison; the threshold can be adjusted depending on the contract type.

General-purpose NER is not enough to extract obligations or termination conditions, so the system also uses Legal IE powered by a local LLM.

Hugging Face models require internet access only for the first download. Once cached locally, the system can run offline.

Tests

pytest -q
