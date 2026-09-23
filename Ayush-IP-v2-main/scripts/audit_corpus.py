"""
Corpus Audit Script for AyushIP RAG Engine.
Corpus Audit Script for IP-SAKTI Sahayak RAG Engine.
Scans every ingested chunk in ChromaDB (and corpus registry) and reports:
1. Total chunk count.
2. Empty chunks (0 words).
3. Near-empty chunks (< 50 words).
4. Metadata-only chunks (lacking substantive statutory text).
5. Breakdown by authorized source:
   - indiacode.gov.in
   - ipindia.gov.in
   - nbaindia.nic.in
   - tkdl.res.in
"""

import os
import sys
import json
import logging
from collections import defaultdict
import chromadb

logging.basicConfig(level=logging.INFO, format="%(message)s")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROMA_DIR = os.path.join(BASE_DIR, "data", "chroma_db")
CORPUS_JSON = os.path.join(BASE_DIR, "data", "corpus", "corpus_data.json")

def is_metadata_only(text: str) -> bool:
    """
    Checks if a chunk appears to be metadata-only (e.g. only headings, 
    source titles, act numbers, or lacking substantive statutory body).
    """
    cleaned = text.strip()
    words = cleaned.split()
    if len(words) < 15:
        return True
    
    # Check if text is predominantly headers / citations rather than statutory provisions
    indicators = ["section", "act", "rule", "form", "guidelines", "http", "https"]
    non_indicator_words = [w for w in words if w.lower().strip(".,;:()") not in indicators]
    if len(non_indicator_words) < 10:
        return True

    return False

def audit_corpus():
    logging.info("=" * 70)
    logging.info("             AYUSH-IP STATUTORY CORPUS AUDIT REPORT")
    logging.info("=" * 70)

    # 1. Load corpus registry
    if not os.path.exists(CORPUS_JSON):
        logging.error(f"FATAL: Corpus file not found at {CORPUS_JSON}")
        return

    with open(CORPUS_JSON, "r", encoding="utf-8") as f:
        corpus = json.load(f)

    parents = corpus.get("parents", {})
    children = corpus.get("children", [])
    logging.info(f"Loaded corpus registry: {len(parents)} parents, {len(children)} children.")

    # 2. Connect to ChromaDB
    chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)
    collection = chroma_client.get_or_create_collection("ayush_statutes")
    
    # If collection is empty, populate it to match runtime state
    if collection.count() == 0 and children:
        logging.info("Populating ChromaDB 'ayush_statutes' collection for audit...")
        ids = [c["child_id"] for c in children]
        documents = [c["text"] for c in children]
        metadatas = [
            {
                "parent_id": str(c.get("parent_id", "")),
                "section": str(c.get("section_or_form", "")),
                "act_or_database": str(c.get("act_or_database", "")),
                "jurisdiction": str(c.get("jurisdiction", "")),
                "source_url": str(c.get("source_url", "")),
                "source": str(c.get("source", ""))
            }
            for c in children
        ]
        embeddings = [[0.0] * 384 for _ in documents]
        collection.add(ids=ids, documents=documents, metadatas=metadatas, embeddings=embeddings)
        logging.info(f"ChromaDB populated with {collection.count()} chunks.")

    # 3. Retrieve all chunks from ChromaDB
    all_chunks = collection.get(include=["documents", "metadatas"])
    total_chunks = len(all_chunks["ids"])
    logging.info(f"Total ChromaDB Chunks Audited: {total_chunks}\n")

    # Source categorization
    sources = ["indiacode.gov.in", "ipindia.gov.in", "nbaindia.nic.in", "tkdl.res.in", "other"]
    
    stats_by_source = {
        s: {
            "total": 0,
            "empty": 0,
            "near_empty": 0,       # < 50 words
            "metadata_only": 0,     # < 15 words or header only
            "substantive": 0,       # >= 50 words & not metadata only
            "word_counts": [],
            "examples_near_empty": []
        }
        for s in sources
    }

    def get_source_bucket(meta: dict) -> str:
        url = meta.get("source_url", "") or meta.get("source", "")
        for s in ["indiacode.gov.in", "ipindia.gov.in", "nbaindia.nic.in", "tkdl.res.in"]:
            if s in url.lower():
                return s
        return "other"

    for c_id, doc, meta in zip(all_chunks["ids"], all_chunks["documents"], all_chunks["metadatas"]):
        src_bucket = get_source_bucket(meta)
        stats = stats_by_source[src_bucket]
        stats["total"] += 1

        words = doc.split()
        word_count = len(words)
        stats["word_counts"].append(word_count)

        if word_count == 0:
            stats["empty"] += 1
        elif word_count < 50:
            stats["near_empty"] += 1
            if len(stats["examples_near_empty"]) < 3:
                stats["examples_near_empty"].append((c_id, word_count, doc[:100]))
        
        if is_metadata_only(doc):
            stats["metadata_only"] += 1
        elif word_count >= 50:
            stats["substantive"] += 1

    # Print Breakdown Table
    header = f"{'Source':<20} | {'Total':<6} | {'Empty':<6} | {'< 50 Words':<11} | {'Meta-Only':<10} | {'Substantive':<11} | {'Avg Words':<10}"
    logging.info(header)
    logging.info("-" * len(header))

    grand_total = 0
    grand_empty = 0
    grand_near_empty = 0
    grand_meta_only = 0
    grand_substantive = 0

    for s in sources:
        st = stats_by_source[s]
        if st["total"] == 0:
            continue
        grand_total += st["total"]
        grand_empty += st["empty"]
        grand_near_empty += st["near_empty"]
        grand_meta_only += st["metadata_only"]
        grand_substantive += st["substantive"]
        avg_words = sum(st["word_counts"]) / len(st["word_counts"]) if st["word_counts"] else 0

        row = (
            f"{s:<20} | {st['total']:<6} | {st['empty']:<6} | "
            f"{st['near_empty']:<11} | {st['metadata_only']:<10} | "
            f"{st['substantive']:<11} | {avg_words:<10.1f}"
        )
        logging.info(row)

    logging.info("-" * len(header))
    summary_avg = sum(sum(st["word_counts"]) for st in stats_by_source.values()) / max(grand_total, 1)
    summary_row = (
        f"{'OVERALL':<20} | {grand_total:<6} | {grand_empty:<6} | "
        f"{grand_near_empty:<11} | {grand_meta_only:<10} | "
        f"{grand_substantive:<11} | {summary_avg:<10.1f}"
    )
    logging.info(summary_row)
    logging.info("=" * 70)

    # Key Findings
    logging.info("\nCRITICAL AUDIT FINDINGS:")
    logging.info(f"1. Near-empty chunks (< 50 words): {grand_near_empty} of {grand_total} ({grand_near_empty/max(grand_total,1)*100:.1f}%)")
    logging.info(f"2. India Code chunks under 50 words: {stats_by_source['indiacode.gov.in']['near_empty']} of {stats_by_source['indiacode.gov.in']['total']} ({stats_by_source['indiacode.gov.in']['near_empty']/max(stats_by_source['indiacode.gov.in']['total'],1)*100:.1f}%)")
    logging.info(f"3. Metadata-only chunks across corpus: {grand_meta_only} of {grand_total} ({grand_meta_only/max(grand_total,1)*100:.1f}%)")
    
    # Audit Parent Registry Text as well
    logging.info("\nPARENT SECTIONS AUDIT (corpus_data.json):")
    for p_id, p_doc in parents.items():
        p_text = p_doc.get("full_text", "")
        p_wc = len(p_text.split())
        url = p_doc.get("source_url", "")
        act = p_doc.get("act_or_database", "")
        sec = p_doc.get("section_or_form", "")
        status = "OK" if p_wc >= 50 else "UNDER 50 WORDS"
        logging.info(f"[{status}] Parent '{p_id}' ({act} - {sec}): {p_wc} words | URL: {url}")

if __name__ == "__main__":
    audit_corpus()
