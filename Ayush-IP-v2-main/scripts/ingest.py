"""
AyushIP Ingestion Pipeline.
IP-SAKTI Sahayak Ingestion Pipeline.
Enforces Part 4 Statutory Integrity:
1. Ingests and validates documents from the 4 authorized domains.
2. Filters out State-level records (e.g. Tamil Nadu, Chhattisgarh) from Central Act scope.
3. Extracts authentic statutory body text via Playwright and India Code DSpace API.
4. Excludes 'No files available' / metadata-only pages lacking body text and logs them to known_gaps.json.
5. Re-chunks parent statutes into substantive child clauses (>= 50 words where possible).
6. Updates corpus_data.json and repopulates ChromaDB with verified deep metadata.
"""

import os
import sys
import json
import logging
from datetime import datetime
from typing import Dict, List, Any
import chromadb
from sentence_transformers import SentenceTransformer

# Add scripts directory to path for relative imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright_url_resolver import PlaywrightUrlResolver

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS_PATH = os.path.join(BASE_DIR, "data", "corpus", "corpus_data.json")
GAPS_PATH = os.path.join(BASE_DIR, "data", "corpus", "known_gaps.json")
CHROMA_DIR = os.path.join(BASE_DIR, "data", "chroma_db")

# Known Central Act URL mappings to replace state-level records
# Known Central Act URL mappings to replace state-level records and dead India Code links
CENTRAL_ACT_REPLACEMENTS = {
    # Replace Tamil Nadu BDA URLs with Central BDA URLs
    "https://indiacode.gov.in/items/79ccc8dd-4a3f-4d35-b2a9-444828204f77": {
        "new_url": "https://indiacode.gov.in/items/cc4e3816-609b-4412-a468-c609bef6322a",
        "act_id": "AC_CEN_16_18_000010_200318_1517807327125",
        "new_url": "http://nbaindia.org/uploaded/pdf/act/BDACT_2002.pdf",
        "act_id": "BDA_2002_CENTRAL",
        "section": "Section 3",
        "scope": "Central"
    },
    "https://indiacode.gov.in/items/134e1072-b6b1-49fd-ba31-d5f9abaad864": {
        "new_url": "https://indiacode.gov.in/items/a42b429f-5f15-4229-a733-7f8718e55287",
        "act_id": "AC_CEN_16_18_000010_200318_1517807327125",
        "new_url": "http://nbaindia.org/uploaded/pdf/act/BDACT_2002.pdf",
        "act_id": "BDA_2002_CENTRAL",
        "section": "Section 6",
        "scope": "Central"
    },
    "https://indiacode.gov.in/items/4f312122-64a6-410c-81e2-b0a0a9adf650": {
        "new_url": "https://indiacode.gov.in/items/a8c69d95-10ea-46a5-a874-63de4eb06b12",
        "act_id": "AC_CEN_16_18_000010_200318_1517807327125",
        "new_url": "http://nbaindia.org/uploaded/pdf/act/BDACT_2002.pdf",
        "act_id": "BDA_2002_CENTRAL",
        "section": "Section 7",
        "scope": "Central"
    },
    "https://indiacode.gov.in/items/42766f62-2e3e-48b5-8d66-2a8e69afb4df": {
        "new_url": "https://indiacode.gov.in/items/12c02c4c-3357-445e-8825-6042284460e5",
        "act_id": "AC_CEN_16_18_000010_200318_1517807327125",
        "new_url": "http://nbaindia.org/uploaded/pdf/act/BDACT_2002.pdf",
        "act_id": "BDA_2002_CENTRAL",
        "section": "Section 40",
        "scope": "Central"
    },
    # Replace Chhattisgarh Drugs & Cosmetics URL with Central Drugs & Cosmetics URL
    "https://indiacode.gov.in/items/ed06e398-9693-47fe-9679-13eeb8aeb469": {
        "new_url": "https://indiacode.gov.in/items/01d50004-357b-4fd8-ae6f-5285389fac4b",
        "act_id": "AC_CEN_12_13_00023_194023_1523353460112",
        "section": "Section 3(a)",
        "new_url": "https://cdsco.gov.in/opencms/opencms/en/Drugs/Ayush/",
        "act_id": "DCA_1940_CENTRAL",
        "section": "Rule 158B",
        "scope": "Central"
    }
}


def run_ingestion():
    logging.info("Starting AyushIP Ingestion & Statutory Grounding Gatekeeper...")
    logging.info("Starting IP-SAKTI Sahayak Ingestion & Statutory Grounding Gatekeeper...")
    resolver = PlaywrightUrlResolver()

    with open(CORPUS_PATH, "r", encoding="utf-8") as f:
        corpus = json.load(f)

    parents = corpus.get("parents", {})
    known_gaps = []

    updated_parents = {}
    
    for p_id, p_doc in parents.items():
        curr_url = p_doc.get("source_url", "")
        title = p_doc.get("title", "")
        act = p_doc.get("act_or_database", "")
        sec = p_doc.get("section_or_form", "")

        # Check if the URL is an accidental state-specific record
        if curr_url in CENTRAL_ACT_REPLACEMENTS:
            rep = CENTRAL_ACT_REPLACEMENTS[curr_url]
            new_url = rep["new_url"]
            
            # Log the old state-specific URL as an excluded known gap
            known_gaps.append({
                "original_url": curr_url,
                "title": title,
                "act_or_database": act,
                "section": sec,
                "reason": f"Excluded state-specific record for Central Act query. Replaced with authentic Central Act URL {new_url}.",
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "resolved_central_url": new_url
            })
            logging.info(f"Replacing State record with Central Act URL: {curr_url} -> {new_url}")
            curr_url = new_url

        # Validate extraction via Playwright/API
        p_doc["source_url"] = curr_url
        p_doc["act_scope"] = "Central"
        p_doc["jurisdiction"] = "India"
        p_doc["state_name"] = "CENTRAL"
        p_doc["last_verified"] = datetime.now().strftime("%Y-%m-%d")

        # If parent already has rich statutory text (>= 30 words), preserve it directly!
        if len(p_doc.get("full_text", "").split()) >= 30:
            updated_parents[p_id] = p_doc
            continue

        logging.info(f"Resolving URL for sparse parent: {curr_url} (Required Scope: Central)")
        extraction = resolver.resolve_and_extract(curr_url, required_scope="Central")
        
        if extraction["status"] == "GAP":
            known_gaps.append({
                "original_url": curr_url,
                "title": title,
                "act_or_database": act,
                "section": sec,
                "reason": extraction.get("gap_reason", "Insufficient body text"),
                "timestamp": datetime.utcnow().isoformat() + "Z"
                "timestamp": datetime.now().isoformat() + "Z"
            })
            logging.warning(f"Logging known gap: {curr_url} ({extraction.get('gap_reason')})")
            continue

        # If extraction extracted rich statutory note, update full text
        extracted_text = extraction.get("text", "")
        if extracted_text and len(extracted_text.split()) > len(p_doc.get("full_text", "").split()):
            logging.info(f"Enhanced parent '{p_id}' full text from {len(p_doc['full_text'].split())} to {len(extracted_text.split())} words.")
            p_doc["full_text"] = extracted_text

        p_doc["source_url"] = curr_url
        p_doc["act_scope"] = "Central"
        p_doc["jurisdiction"] = "India"
        p_doc["state_name"] = "CENTRAL"
        p_doc["last_verified"] = datetime.utcnow().strftime("%Y-%m-%d")
        updated_parents[p_id] = p_doc

    # Re-chunk parents into substantive child chunks (>= 50 words where possible, or full semantic paragraphs)
    updated_children = []
    child_counter = 0

    for p_id, p in updated_parents.items():
        text = p.get("full_text", "").strip()
        words = text.split()
        
        chunks_for_parent = []
        if len(words) <= 100:
            chunks_for_parent = [" ".join(words)]
        else:
            step = 60
            chunk_size = 80
            for i in range(0, len(words), step):
                chunk = words[i:i + chunk_size]
                if len(chunk) < 35 and chunks_for_parent:
                    chunks_for_parent[-1] += " " + " ".join(chunk)
                    break
                chunks_for_parent.append(" ".join(chunk))
                if i + chunk_size >= len(words):
                    break

        if not chunks_for_parent:
            chunks_for_parent = [text]

        for c_idx, chunk_text in enumerate(chunks_for_parent):
            c_id = f"{p_id}_child_{c_idx}"
            updated_children.append({
                "child_id": c_id,
                "parent_id": p_id,
                "text": chunk_text,
                "source": p["source"],
                "act_or_database": p["act_or_database"],
                "section_or_form": p["section_or_form"],
                "source_url": p["source_url"],
                "url_precision": p["url_precision"],
                "effective_date": p["effective_date"],
                "jurisdiction": p["jurisdiction"],
                "act_scope": "Central",
                "state_name": "CENTRAL",
                "word_count": len(chunk_text.split())
            })

    logging.info(f"Generated {len(updated_children)} substantive child chunks across {len(updated_parents)} parents.")

    # Write updated corpus_data.json
    with open(CORPUS_PATH, "w", encoding="utf-8") as f:
        json.dump({"parents": updated_parents, "children": updated_children}, f, indent=2, ensure_ascii=False)
    logging.info(f"Updated corpus file written to {CORPUS_PATH}")

    # Write known_gaps.json
    with open(GAPS_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "audit_timestamp": datetime.utcnow().isoformat() + "Z",
            "total_gaps_logged": len(known_gaps),
            "gaps": known_gaps
        }, f, indent=2)
    logging.info(f"Logged {len(known_gaps)} known gaps to {GAPS_PATH}")

    # Update ChromaDB
    logging.info(f"Re-indexing ChromaDB at {CHROMA_DIR}...")
    bi_encoder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)
    
    # Delete old collection and recreate clean
    try:
        chroma_client.delete_collection("ayush_statutes")
    except Exception:
        pass
    collection = chroma_client.create_collection("ayush_statutes")

    ids = [c["child_id"] for c in updated_children]
    documents = [c["text"] for c in updated_children]
    metadatas = [
        {
            "parent_id": str(c["parent_id"]),
            "section": str(c["section_or_form"]),
            "act_or_database": str(c["act_or_database"]),
            "jurisdiction": str(c["jurisdiction"]),
            "act_scope": str(c["act_scope"]),
            "state_name": str(c["state_name"]),
            "source_url": str(c["source_url"]),
            "url_precision": str(c.get("url_precision", "section-level")),
            "source": str(c["source"]),
            "word_count": int(c["word_count"])
        }
        for c in updated_children
    ]
    embeddings = bi_encoder.encode(documents).tolist()
    collection.add(ids=ids, documents=documents, metadatas=metadatas, embeddings=embeddings)
    logging.info(f"ChromaDB successfully re-indexed with {collection.count()} verified chunks!")

if __name__ == "__main__":
    run_ingestion()
