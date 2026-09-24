"""
AyushIP FastAPI Backend Server.
IP-SAKTI Sahayak FastAPI Backend Server.
Runs on HOST=127.0.0.1, PORT=8000.
Exposes:
- POST /api/gemini/chat (Full RAG Pipeline with 4-domain grounding & citation verification)
- POST /api/abs/check (Dedicated ABS Assessment)
- GET /api/health (Health check and corpus statistics)
- GET /api/citations/sample (Sample citations from the four authorized domains)
"""

import os
import logging
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, model_validator
import uvicorn
from dotenv import load_dotenv

import sys
from pathlib import Path

# Ensure backend directory is in sys.path regardless of working directory
backend_dir = str(Path(__file__).resolve().parent)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from rag_service import (
    generate_rag_response, 
    evaluate_abs_compliance,
    parents_registry, 
    children_registry, 
    retrieve_hybrid_candidates,
    expand_to_parents
)

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s - %(message)s")

app = FastAPI(title="AyushIP Statutory RAG Engine", version="1.0.0")
app = FastAPI(title="IP-SAKTI Sahayak Statutory RAG Engine", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatMessage(BaseModel):
    role: str
    content: str
    citations: Optional[List[Dict[str, Any]]] = None
    confidence: Optional[str] = None
    needsHumanEscalation: Optional[bool] = None
    isClassicalTKDL: Optional[bool] = None
    absChecklist: Optional[Dict[str, Any]] = None

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    jurisdiction: Optional[str] = "India"
    formulationCategory: Optional[str] = "Unknown"
    outputLanguage: Optional[str] = "Auto"

class AbsCheckRequest(BaseModel):
    query: Optional[str] = None
    formulationName: Optional[str] = None
    ingredients: Optional[Any] = None
    jurisdiction: Optional[str] = "India"
    formulationCategory: Optional[str] = "Unknown"

    @model_validator(mode="after")
    def ensure_query(self):
        if not self.query:
            parts = []
            if self.formulationName:
                parts.append(str(self.formulationName))
            if self.ingredients:
                if isinstance(self.ingredients, list):
                    parts.append(" ".join(str(i) for i in self.ingredients))
                else:
                    parts.append(str(self.ingredients))
            self.query = " ".join(parts).strip() or "Ayurvedic formulation"
        return self

@app.get("/")
def root():
    return {
        "status": "online",
        "message": "AyushIP Statutory RAG Backend is running.",
        "message": "IP-SAKTI Sahayak Statutory RAG Backend is running.",
        "frontend_url": "http://localhost:3000",
        "docs_url": "/docs",
        "health_check": "/api/health"
    }

@app.get("/api/health")
def health():
    return {
        "status": "healthy",
        "engine": "AyushIP Statutory RAG",
        "engine": "IP-SAKTI Sahayak Statutory RAG",
        "total_parent_sections": len(parents_registry),
        "total_child_clauses": len(children_registry),
        "authorized_domains": [
            "indiacode.gov.in",
            "ipindia.gov.in",
            "nbaindia.nic.in",
            "tkdl.res.in"
        ],
        "confidence_threshold": float(os.getenv("RETRIEVAL_CONFIDENCE_THRESHOLD", "0.35")),
        "model": os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
    }

@app.post("/api/gemini/chat")
async def chat_endpoint(req: ChatRequest):
    try:
        dict_messages = [m.model_dump() for m in req.messages]
        result = generate_rag_response(
            messages=dict_messages,
            jurisdiction=req.jurisdiction or "India",
            formulation_category=req.formulationCategory or "Unknown",
            output_language=req.outputLanguage or "Auto"
        )
        return result
    except Exception as e:
        logging.error(f"Error in /api/gemini/chat: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/abs/check")
async def abs_check_endpoint(req: AbsCheckRequest):
    try:
        candidates = retrieve_hybrid_candidates(req.query, top_y=5, jurisdiction=req.jurisdiction)
        parents = expand_to_parents(candidates)
        assessment = evaluate_abs_compliance(req.query, parents)
        return assessment
    except Exception as e:
        logging.error(f"Error in /api/abs/check: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/statutes")
def list_statutes():
    """
    Returns the complete directory of indexed parent statutory documents.
    """
    statutes = []
    for pid, p in parents_registry.items():
        statutes.append({
            "parent_id": pid,
            "title": p.get("title"),
            "act_or_database": p.get("act_or_database"),
            "section_or_form": p.get("section_or_form"),
            "source": p.get("source"),
            "source_url": p.get("source_url"),
            "official_pdf_url": p.get("official_pdf_url", p.get("source_url")),
            "jurisdiction": p.get("jurisdiction", "India"),
            "effective_date": p.get("effective_date"),
            "char_count": len(p.get("full_text", "")),
            "word_count": len(p.get("full_text", "").split())
        })
    return {"total": len(statutes), "statutes": statutes}

@app.get("/api/statutes/{parent_id}")
def get_statute(parent_id: str):
    """
    Returns the full, verbatim parent statutory document and metadata for in-app reading.
    """
    if parent_id in parents_registry:
        return parents_registry[parent_id]
    
    # Try searching by section or title match
    parent_id_clean = parent_id.lower().replace("-", " ").replace("_", " ")
    for pid, p in parents_registry.items():
        sec = p.get("section_or_form", "").lower()
        title = p.get("title", "").lower()
        if parent_id_clean in sec or sec in parent_id_clean or parent_id_clean in title:
            return p
            
    raise HTTPException(status_code=404, detail=f"Statutory document '{parent_id}' not found.")

@app.get("/api/citations/sample")
def sample_citations():
    """
    Returns verified sample citations across all 4 domains for instant verification.
    """
    samples = []
    seen = set()
    for p in parents_registry.values():
        src = p["source"]
        if src not in seen:
            seen.add(src)
            samples.append({
                "parent_id": p.get("parent_id", ""),
                "source": f"{p['act_or_database']} - {p['section_or_form']}",
                "sectionRef": p["section_or_form"],
                "portal": src,
                "url": p["source_url"],
                "official_pdf_url": p.get("official_pdf_url", p["source_url"]),
                "url_precision": p["url_precision"],
                "effective_date": p["effective_date"],
                "jurisdiction": p["jurisdiction"],
                "snippet": p["full_text"][:150] + "..."
            })
    return {"sample_citations": samples}

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("BACKEND_PORT", os.getenv("PYTHON_PORT", "8001")))
    logging.info(f"Starting IP-SAKTI Sahayak FastAPI Server on http://{host}:{port}...")
    uvicorn.run(app, host=host, port=port)


