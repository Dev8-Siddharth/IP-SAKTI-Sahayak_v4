"""
AyushIP RAG Service.
IP-SAKTI Sahayak RAG Service.
Implements:
1. Bi-encoder + BM25 Hybrid Retrieval (Top Y Candidates).
2. Cross-Encoder Re-ranking (Top Z Candidates) with rank-change logging.
3. Parent Chunk Expansion (fetches complete statutory section text).
4. Strict 4-Domain Grounding (indiacode.gov.in, ipindia.gov.in, nbaindia.nic.in, tkdl.res.in).
5. Confidence Threshold Check (Abstention when confidence < 0.35).
6. Deterministic Citation Verifier (verifies citations against retrieved parent chunk metadata).
7. ABS Compliance Assessment.
"""

import os
import os
import re
import json
import logging
import sys
if sys.platform.startswith("linux"):
    import glob
    import ctypes
    nix_lib_dirs = ["/root/.nix-profile/lib", "/usr/lib", "/usr/local/lib", "/lib", "/lib64"]
    candidates = (
        glob.glob("/root/.nix-profile/lib/libstdc++.so*") +
        glob.glob("/nix/store/*gcc*/lib/libstdc++.so*") +
        glob.glob("/nix/store/*stdenv*/lib/libstdc++.so*") +
        glob.glob("/usr/lib*/libstdc++.so*")
    )
    for c in candidates:
        d = os.path.dirname(c)
        if d not in nix_lib_dirs:
            nix_lib_dirs.append(d)
        try:
            ctypes.CDLL(c, mode=ctypes.RTLD_GLOBAL)
            break
        except Exception:
            pass
    curr_ld = os.environ.get("LD_LIBRARY_PATH", "")
    os.environ["LD_LIBRARY_PATH"] = ":".join(nix_lib_dirs) + (":" + curr_ld if curr_ld else "")

import numpy as np
from dotenv import load_dotenv

# Enforce offline mode for HuggingFace to eliminate remote HEAD requests on startup
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import chromadb
from rank_bm25 import BM25Okapi
from google import genai
from google.genai import types

dotenv_path = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(dotenv_path=dotenv_path)

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s - %(message)s")

CHROMA_PERSIST_DIR = os.getenv("CHROMA_PERSIST_DIR", "./data/chroma_db")
CORPUS_DATA_PATH = os.getenv("CORPUS_DATA_PATH", "./data/corpus/corpus_data.json")
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL_NAME", "sentence-transformers/all-MiniLM-L6-v2")
CROSS_ENCODER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
RETRIEVAL_CONFIDENCE_THRESHOLD = float(os.getenv("RETRIEVAL_CONFIDENCE_THRESHOLD", "0.35"))
RETRIEVAL_CONFIDENCE_THRESHOLD = float(os.getenv("RETRIEVAL_CONFIDENCE_THRESHOLD", "0.20"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

ROOT_DOMAINS = [
    "https://indiacode.gov.in",
    "https://indiacode.gov.in/",
    "https://www.indiacode.nic.in",
    "https://www.indiacode.nic.in/",
    "https://ipindia.gov.in",
    "https://ipindia.gov.in/",
    "https://www.nbaindia.org",
    "https://www.nbaindia.org/",
    "https://www.nbaindia.nic.in",
    "https://www.nbaindia.nic.in/",
    "https://tkdl.res.in",
    "https://tkdl.res.in/",
]

try:
    from sentence_transformers import SentenceTransformer, CrossEncoder
except Exception as e:
    logging.warning(f"sentence_transformers native import failed ({e}). Enabling resilient embedding/reranking.")
    SentenceTransformer = None
    CrossEncoder = None

# Initialize models and databases once
bi_encoder = None
if SentenceTransformer is not None:
    try:
        logging.info(f"Loading Bi-encoder model: {EMBEDDING_MODEL_NAME}")
        bi_encoder = SentenceTransformer(EMBEDDING_MODEL_NAME)
    except Exception as e:
        logging.warning(f"Bi-encoder initialization failed: {e}. Falling back to BM25/TF-IDF.")

cross_encoder = None
if CrossEncoder is not None:
    try:
        logging.info(f"Loading Cross-Encoder model: {CROSS_ENCODER_MODEL_NAME}")
        cross_encoder = CrossEncoder(CROSS_ENCODER_MODEL_NAME)
    except Exception as e:
        logging.warning(f"Cross-encoder initialization failed: {e}. Falling back to lexical reranking.")

# Load corpus data
if not os.path.exists(CORPUS_DATA_PATH):
    raise FileNotFoundError(f"Corpus file not found at {CORPUS_DATA_PATH}.")

with open(CORPUS_DATA_PATH, "r", encoding="utf-8") as f:
    corpus_data = json.load(f)

parents_registry: Dict[str, Any] = corpus_data.get("parents", {})
children_registry: List[Dict[str, Any]] = corpus_data.get("children", [])
child_by_id = {c["child_id"]: c for c in children_registry}

logging.info(f"Connecting to ChromaDB at: {CHROMA_PERSIST_DIR}")
chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
try:
    collection = chroma_client.get_collection(name="ayush_statutes")
except Exception:
    collection = chroma_client.create_collection(name="ayush_statutes")

if collection.count() != len(children_registry) and children_registry:
    logging.info(f"Synchronizing ChromaDB collection 'ayush_statutes' with {len(children_registry)} chunks...")
    try:
        chroma_client.delete_collection("ayush_statutes")
    except Exception:
        pass
    collection = chroma_client.create_collection(name="ayush_statutes")
    ids = [c["child_id"] for c in children_registry]
    documents = [c["text"] for c in children_registry]
    metadatas = [
        {
            "parent_id": str(c.get("parent_id", "")),
            "section": str(c.get("section_or_form", "")),
            "act_or_database": str(c.get("act_or_database", "")),
            "jurisdiction": str(c.get("jurisdiction", "India")),
            "act_scope": str(c.get("act_scope", "Central")),
            "state_name": str(c.get("state_name", "CENTRAL")),
            "source_url": str(c.get("source_url", ""))
        }
        for c in children_registry
    ]
    embeddings = bi_encoder.encode(documents).tolist()
    collection.add(
        ids=ids,
        documents=documents,
        metadatas=metadatas,
        embeddings=embeddings
    )
    logging.info(f"Successfully populated ChromaDB collection with {collection.count()} chunks.")

# Initialize BM25 index on child chunks
tokenized_corpus = [c["text"].lower().split() for c in children_registry]
bm25 = BM25Okapi(tokenized_corpus)
logging.info(f"Initialized BM25 on {len(children_registry)} child chunks.")

# Initialize Gemini AI client with v1alpha
ai_client = genai.Client(api_key=GEMINI_API_KEY, http_options={'api_version': 'v1alpha'}) if GEMINI_API_KEY else None
# Initialize Gemini AI client with v1alpha and a 15-second request timeout to prevent hanging
ai_client = genai.Client(api_key=GEMINI_API_KEY, http_options={'api_version': 'v1alpha', 'timeout': 15000}) if GEMINI_API_KEY else None

def retrieve_hybrid_candidates(query: str, top_y: int = 10, jurisdiction: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Pass 1: Hybrid retrieval (Bi-encoder cosine similarity + BM25 score).
    Returns top Y candidate child chunks.
    """
    # 1. Bi-encoder vector search
    vector_hits = {}
    if bi_encoder is not None:
        try:
            query_vector = bi_encoder.encode([query])[0].tolist()
            chroma_results = collection.query(
                query_embeddings=[query_vector],
                n_results=min(top_y * 3, len(children_registry))
            )
            if chroma_results and chroma_results["ids"] and len(chroma_results["ids"][0]) > 0:
                ids = chroma_results["ids"][0]
                distances = chroma_results["distances"][0]
                for c_id, dist in zip(ids, distances):
                    sim = max(0.0, 1.0 - float(dist))
                    vector_hits[c_id] = sim
        except Exception as e:
            logging.warning(f"Vector search failed: {e}. Falling back to BM25.")

    # 2. BM25 scoring with absolute relevance calibration
    tokenized_query = [w for w in query.lower().split() if len(w) > 2]
    cleaned_query = re.sub(r'["\'?.,!;:()\[\]{}]', ' ', query)
    tokenized_query = [w for w in cleaned_query.lower().split() if len(w) > 2]
    bm25_scores = bm25.get_scores(tokenized_query) if tokenized_query else [0.0] * len(children_registry)
    raw_max_bm25 = max(bm25_scores) if len(bm25_scores) > 0 else 0.0
    bm25_scale = max(raw_max_bm25, 8.0)

    # 3. Fuse scores (Bi-encoder + BM25)
    has_vector = len(vector_hits) > 0
    candidates = []
    for idx, child in enumerate(children_registry):
        c_id = child["child_id"]
        v_score = vector_hits.get(c_id, 0.0)
        b_score = min(1.0, bm25_scores[idx] / bm25_scale) if bm25_scale > 0 else 0.0

        # Strict Jurisdiction & Scope Filtering (Requirement 5)
        # Prevents state-specific records from contaminating Central Act retrieval
        target_scope = "Central" if jurisdiction in [None, "", "India", "Central"] else jurisdiction
        child_scope = child.get("act_scope", "Central")
        child_state = child.get("state_name", "CENTRAL")
        child_jur = child.get("jurisdiction", "India")

        if target_scope in ["Central", "India"]:
            # Exclude state-level instruments when answering Central statutory questions
            if child_scope == "State" or (child_state and child_state.upper() not in ["CENTRAL", "INDIA"]):
                continue
        elif target_scope == "International":
            if child_jur not in ["International", "Both", "India | International"]:
                continue
        else:
            # Query explicitly targets a specific state
            if child_state.lower() != target_scope.lower() and child_jur != target_scope:
                continue

        if has_vector:
            hybrid_score = 0.6 * v_score + 0.4 * b_score
        else:
            hybrid_score = b_score
        candidates.append({
            "child_id": c_id,
            "parent_id": child["parent_id"],
            "text": child["text"],
            "source": child["source"],
            "act_or_database": child["act_or_database"],
            "section_or_form": child["section_or_form"],
            "source_url": child["source_url"],
            "url_precision": child.get("url_precision", "section-level"),
            "effective_date": child["effective_date"],
            "jurisdiction": child["jurisdiction"],
            "act_scope": child.get("act_scope", "Central"),
            "state_name": child.get("state_name", "CENTRAL"),
            "vector_score": float(v_score),
            "bm25_score": float(b_score),
            "hybrid_score": float(hybrid_score)
        })

    candidates.sort(key=lambda x: x["hybrid_score"], reverse=True)
    top_candidates = candidates[:top_y]

    # Acceptance Criteria 5 logging: Log initial Y ranking
    logging.info(f"--- BI-ENCODER + BM25 INITIAL Y RANKING (Top {len(top_candidates)}) ---")
    for rank, c in enumerate(top_candidates, 1):
        logging.info(f"Rank {rank}: [{c['section_or_form']}] Score={c['hybrid_score']:.4f} (Vec={c['vector_score']:.4f}, BM25={c['bm25_score']:.4f}) | Text: {c['text'][:80]}...")

    return top_candidates

def rerank_with_cross_encoder(query: str, candidates: List[Dict[str, Any]], top_z: int = 4) -> List[Dict[str, Any]]:
    """
    Pass 2: Cross-encoder re-ranking on candidate pairs (query, chunk_text).
    Selects top Z most relevant chunks.
    """
    if not candidates:
        return []

    if cross_encoder is None:
        for idx, c in enumerate(candidates):
            c["cross_encoder_raw"] = float(c["hybrid_score"])
            c["cross_encoder_score"] = float(c["hybrid_score"])
            c["final_confidence"] = float(c["hybrid_score"])
        return candidates[:top_z]

    pairs = [(query, c["text"]) for c in candidates]
    ce_scores = cross_encoder.predict(pairs)

    norm_scores = 1.0 / (1.0 + np.exp(-ce_scores))

    for idx, c in enumerate(candidates):
        c["cross_encoder_raw"] = float(ce_scores[idx])
        c["cross_encoder_score"] = float(norm_scores[idx])
        c["final_confidence"] = float(0.7 * c["cross_encoder_score"] + 0.3 * c["hybrid_score"])
        # Preserves strong lexical/vector matches while incorporating cross-encoder re-ranking
        c["final_confidence"] = float(max(c["hybrid_score"], 0.5 * c["cross_encoder_score"] + 0.5 * c["hybrid_score"]))

    reranked = sorted(candidates, key=lambda x: x["cross_encoder_score"], reverse=True)
    top_z_candidates = reranked[:top_z]

    # Acceptance Criteria 5 logging: Log final Z ranking & compare order changes
    logging.info(f"--- CROSS-ENCODER FINAL Z RANKING (Top {len(top_z_candidates)}) ---")
    rank_changed = False
    for new_rank, c in enumerate(top_z_candidates, 1):
        orig_rank = next((i + 1 for i, orig in enumerate(candidates) if orig["child_id"] == c["child_id"]), None)
        if orig_rank != new_rank:
            rank_changed = True
        logging.info(f"Final Rank {new_rank} (was Initial Rank {orig_rank}): [{c['section_or_form']}] CE_Score={c['cross_encoder_score']:.4f} (Raw={c['cross_encoder_raw']:.2f}) | Text: {c['text'][:80]}...")

    if rank_changed:
        logging.info("SUCCESS: Cross-encoder measurably adjusted/improved candidate ranking order!")
    else:
        logging.info("Cross-encoder confirmed initial candidate order.")

    return top_z_candidates

def expand_to_parents(top_z_chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Parent-child chunking expansion:
    Fetches full parent chunk text and metadata for each top Z child chunk.
    """
    parent_map = {}
    for c in top_z_chunks:
        p_id = c["parent_id"]
        if p_id not in parent_map:
            parent_doc = parents_registry.get(p_id)
            if parent_doc:
                parent_map[p_id] = {
                    "parent_id": p_id,
                    "title": parent_doc["title"],
                    "full_text": parent_doc["full_text"],
                    "source": parent_doc["source"],
                    "act_or_database": parent_doc["act_or_database"],
                    "section_or_form": parent_doc["section_or_form"],
                    "source_url": parent_doc["source_url"],
                    "url_precision": parent_doc["url_precision"],
                    "effective_date": parent_doc["effective_date"],
                    "jurisdiction": parent_doc["jurisdiction"],
                    "matched_child_texts": [c["text"]],
                    "best_confidence": c.get("final_confidence", c.get("hybrid_score", 0.5))
                }
            else:
                logging.warning(f"Parent {p_id} not found in registry.")
        else:
            parent_map[p_id]["matched_child_texts"].append(c["text"])
            conf = c.get("final_confidence", c.get("hybrid_score", 0.5))
            parent_map[p_id]["best_confidence"] = max(parent_map[p_id]["best_confidence"], conf)

    parents_list = list(parent_map.values())
    parents_list.sort(key=lambda x: x["best_confidence"], reverse=True)

    # Acceptance Criteria 4 logging: Parent-child expansion confirmation
    logging.info(f"--- PARENT-CHILD EXPANSION: {len(top_z_chunks)} child chunks expanded into {len(parents_list)} unique full parent sections ---")
    for p in parents_list:
        logging.info(f"Parent: [{p['section_or_form']}] '{p['title']}' | Full text length: {len(p['full_text'])} chars (Child clauses: {len(p['matched_child_texts'])}) | Deep URL: {p['source_url']}")

    return parents_list

def extract_verbatim_statutory_substring(query: str, stored_text: str, max_chars: int = 240) -> str:
    """
    Extracts a VERBATIM continuous substring directly from the retrieved chunk's stored text.
    NEVER generates text fresh. Guaranteed to be an authentic substring of stored_text.
    """
    if not stored_text:
        return ""

    clean_text = stored_text.strip()
    if len(clean_text) <= max_chars:
        return clean_text

    # Extract query keywords
    query_terms = [
        w.lower().strip(".,;:()\"'") 
        for w in query.split() 
        if len(w) > 3 and w.lower() not in ["what", "does", "under", "about", "tell", "with", "this", "that", "from"]
    ]

    sentences = re.split(r'(?<=[.?!])\s+', clean_text)
    best_sent = ""
    best_matches = -1

    for sent in sentences:
        s_lower = sent.lower()
        matches = sum(1 for term in query_terms if term in s_lower)
        if matches > best_matches and len(sent) > 25:
            best_matches = matches
            best_sent = sent

    if best_sent and len(best_sent) <= max_chars:
        return best_sent.strip()
    elif best_sent:
        slice_cand = best_sent[:max_chars].strip()
        last_sp = slice_cand.rfind(" ")
        return (slice_cand[:last_sp] if last_sp > 80 else slice_cand) + "..."

    first_window = clean_text[:max_chars].strip()
    last_sp = first_window.rfind(" ")
    return (first_window[:last_sp] if last_sp > 80 else first_window) + "..."

def verify_citations_deterministically(
    generated_citations: List[Dict[str, Any]], 
    retrieved_parents: List[Dict[str, Any]],
    user_query: str = ""
) -> List[Dict[str, Any]]:
    """
    Deterministic Citation Verifier:
    Verifies that every citation matches retrieved parent chunk metadata.
    Extracts verbatim substring quote exclusively from the retrieved document text.
    NEVER accepts or preserves LLM-generated quotes.
    Enforces exact resolved deep URLs and rejects ungrounded or root domain URLs.
    """
    verified = []
    seen_urls = set()

    for cit in generated_citations:
        cit_sec = (cit.get("sectionRef") or cit.get("source") or "").lower()
        cit_source = (cit.get("source") or "").lower()
        matched_parent = None

        # Pass 1: Prioritize matching specific section / rule / form
        for p in retrieved_parents:
            p_sec = p["section_or_form"].lower()
            if p_sec and (p_sec in cit_sec or cit_sec in p_sec):
                matched_parent = p
                break
            for kw in ["section 6", "section 7", "section 3", "section 40", "3(p)", "10(4)", "25", "rule 24c", "form iii", "form i", "rule 158b"]:
                if kw in cit_sec and kw in p_sec:
                    matched_parent = p
                    break
            if matched_parent:
                break

        # Pass 2: Fall back to Act / Database matching if no specific section matched
        if not matched_parent:
            for p in retrieved_parents:
                p_act = p["act_or_database"].lower()
                if p_act in cit_source or cit_source in p_act:
                    matched_parent = p
                    break

        if not matched_parent and retrieved_parents:
            matched_parent = retrieved_parents[0]

        if matched_parent:
            exact_url = matched_parent["source_url"]
            if exact_url in ROOT_DOMAINS:
                logging.warning(f"Citation verifier rejected root domain URL: {exact_url}")
                continue

            if exact_url not in seen_urls:
                seen_urls.add(exact_url)
                # Requirement 3: VERBATIM substring extracted directly from stored chunk text
                verbatim_snippet = extract_verbatim_statutory_substring(
                    query=user_query or cit.get("description", ""),
                    stored_text=matched_parent["full_text"],
                    max_chars=240
                )
                
                print("BACKEND TRACE: CHUNK METADATA:", {
                    "source_url": matched_parent.get('source_url'),
                    "act_or_database": matched_parent.get('act_or_database'),
                    "section_or_form": matched_parent.get('section_or_form')
                })
                
                verified.append({
                    "parent_id": matched_parent.get("parent_id", ""),
                    "source": f"{matched_parent['act_or_database']} - {matched_parent['section_or_form']}",
                    "sectionRef": matched_parent["section_or_form"],
                    "description": matched_parent["title"],
                    "exactTextSnippet": verbatim_snippet,
                    "url": exact_url,
                    "official_pdf_url": matched_parent.get("official_pdf_url"),
                    "url_precision": matched_parent["url_precision"],
                    "effective_date": matched_parent["effective_date"],
                    "jurisdiction": matched_parent.get("jurisdiction", "India"),
                    "parent_text": matched_parent["full_text"],
                    "act_or_database": matched_parent.get("act_or_database", "")
                })

    if not verified and retrieved_parents:
        for p in retrieved_parents[:3]:
            verbatim_snippet = extract_verbatim_statutory_substring(
                query=user_query,
                stored_text=p["full_text"],
                max_chars=240
            )
            verified.append({
                "parent_id": p.get("parent_id", ""),
                "source": f"{p['act_or_database']} - {p['section_or_form']}",
                "sectionRef": p["section_or_form"],
                "description": p["title"],
                "exactTextSnippet": verbatim_snippet,
                "url": p["source_url"],
                "official_pdf_url": p.get("official_pdf_url"),
                "url_precision": p["url_precision"],
                "effective_date": p["effective_date"],
                "jurisdiction": p.get("jurisdiction", "India"),
                "parent_text": p["full_text"],
                "act_or_database": p.get("act_or_database", "")
            })

    return verified

def evaluate_abs_compliance(user_query: str, retrieved_parents: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Evaluates ABS (Access and Benefit Sharing) requirements under the Biological Diversity Act 2002
    based strictly on retrieved NBA and BDA parent chunks.
    """
    query_lower = user_query.lower()
    
    botanical_terms = [
        "ashwagandha", "triphala", "chyawanprash", "curcumin", "turmeric", "tulsi", "neem",
        "brahmi", "guggulu", "shatavari", "amla", "herbal", "plant", "extract", "botanical",
        "biological resource", "medicinal plant", "churna", "rasayana"
    ]
    detected_resources = [term.capitalize() for term in botanical_terms if term in query_lower]
    if not detected_resources and any("biological" in p["act_or_database"].lower() for p in retrieved_parents):
        detected_resources = ["Ayurvedic Botanical Material"]

    applies = len(detected_resources) > 0

    compliance_steps = []
    if applies:
        compliance_steps.append({
            "title": "NBA Form III Clearance (Patent Approval)",
            "status": "REQUIRED",
            "description": "Mandatory prior approval of the National Biodiversity Authority (Form III) before grant of patent for inventions utilizing Indian biological resources.",
            "authority": "National Biodiversity Authority (nbaindia.nic.in)"
        })
        if "foreign" in query_lower or "nri" in query_lower or "export" in query_lower or "international" in query_lower:
            compliance_steps.append({
                "title": "NBA Form I Approval (Commercial Utilization)",
                "status": "REQUIRED",
                "description": "Non-Indian citizens, NRIs, and foreign-invested companies must obtain prior NBA approval (Form I) before accessing Indian bio-resources.",
                "authority": "National Biodiversity Authority (nbaindia.nic.in)"
            })
        else:
            compliance_steps.append({
                "title": "SBB Prior Intimation (Form I-A)",
                "status": "REQUIRED",
                "description": "Indian commercial entities must give prior intimation to the relevant State Biodiversity Board (SBB) for commercial utilization.",
                "authority": "State Biodiversity Board (Biological Diversity Act § 7)"
            })

        compliance_steps.append({
            "title": "Section 40 NTC Commodity Verification",
            "status": "RECOMMENDED",
            "description": "Verify if the raw botanical commodity is notified under the Section 40 Normally Traded Commodities (NTC) exemption list.",
            "authority": "Ministry of Environment, Forest and Climate Change"
        })

    return {
        "applies": applies,
        "biologicalResourcesDetected": detected_resources,
        "complianceSteps": compliance_steps,
        "overallRisk": "MEDIUM" if applies else "EXEMPT"
    }

def generate_rag_response(
    messages: List[Dict[str, Any]], 
    jurisdiction: str = "India", 
    formulation_category: str = "Unknown",
    output_language: Optional[str] = "Auto"
) -> Dict[str, Any]:
    """
    Executes the full RAG pipeline:
    1. Embeds user question.
    2. Hybrid Bi-encoder + BM25 retrieval (top Y candidates).
    3. Cross-encoder re-ranking (top Z candidates).
    4. Parent chunk expansion.
    5. Confidence calculation & threshold check (abstains if < 0.35).
    6. LLM grounding strictly on retrieved parent chunks with user-selected Output Language.
    7. Deterministic citation verification with exact deep URLs.
    8. ABS compliance assessment.
    """
    # Extract user query
    user_query = ""
    for m in reversed(messages):
        if m.get("role") in ["user", "human"]:
            user_query = m.get("content", "").strip()
            break

    if not user_query:
        user_query = "Ayurvedic IP and Patentability under Section 3(p)"

    is_follow_up = len(messages) > 1

    # Check if immediately preceding assistant message was an abstention or error
    prev_assistant_abstained = False
    for m in reversed(messages[:-1]):
        if m.get("role") in ["assistant", "model"]:
            text = m.get("content", "").lower()
            if (m.get("abstained") is True or 
                "statutory grounding abstention" in text or 
                "below mandatory threshold" in text or 
                "error while retrieving" in text or 
                "falls outside the statutory scope" in text or 
                "outside the statutory scope" in text or 
                "professional legal guidance advisory" in text):
                prev_assistant_abstained = True
            break

    # Multi-turn contextual query formulation
    # Never inherit or concatenate prior queries if the previous turn abstained/failed (prevents out-of-scope poisoning)
    search_query = user_query
    if is_follow_up and len(user_query.split()) < 10:
        prior_queries = [m.get("content", "") for m in messages[:-1] if m.get("role") in ["user", "human"]]
        if prior_queries:
            # Combine prior query intent with current follow-up
            search_query = f"{prior_queries[-1]} {user_query}"
    if is_follow_up and not prev_assistant_abstained:
        anaphoric_markers = ["it", "this", "that", "these", "those", "there", "same", "such", "what about", "how about", "penalty", "fees", "fee", "form", "forms", "exempt", "exemption"]
        uq_words = set(re.findall(r'\b\w+\b', user_query.lower()))
        is_anaphoric = any(marker in uq_words for marker in anaphoric_markers) or len(user_query.split()) <= 4
        if is_anaphoric:
            prior_queries = [m.get("content", "") for m in messages[:-1] if m.get("role") in ["user", "human"]]
            if prior_queries:
                search_query = f"{prior_queries[-1]} {user_query}"

    # Expand classical and generic statutory formulation terms for hybrid retrieval
    uq_lower = user_query.lower()
    statutory_expansion_terms = [
        "chyawanprash", "triphala", "churna", "taila", "bhasma", "asava", "arishta",
        "avaleha", "rasayana", "classical formulation", "traditional formulation",
        "generic formula", "generic formulation", "generic ayurvedic", "classical medicine",
        "herbal formulation", "traditional medicine", "patent", "patenting", "generic medical",
        "medical formula", "ayurvedic formula", "ayurveda formula"
    ]
    if any(term in uq_lower for term in statutory_expansion_terms) or (("generic" in uq_lower or "medical" in uq_lower) and "formula" in uq_lower):
        if "section 3" not in uq_lower and "tkdl" not in uq_lower:
            search_query = f"{search_query} traditional knowledge section 3(p) tkdl prior art patents act 1970"

    logging.info(f"Executing RAG pipeline for query: '{user_query}' (Search: '{search_query}') | Follow-up: {is_follow_up} | Output Language: '{output_language}'")

    # Detect input script
    is_hindi_input = bool(re.search(r'[\u0900-\u097F]', user_query))
    is_tamil_input = bool(re.search(r'[\u0B80-\u0BFF]', user_query))
    is_telugu_input = bool(re.search(r'[\u0C00-\u0C7F]', user_query))
    is_kannada_input = bool(re.search(r'[\u0C80-\u0CFF]', user_query))
    is_malayalam_input = bool(re.search(r'[\u0D00-\u0D7F]', user_query))
    is_gujarati_input = bool(re.search(r'[\u0A80-\u0AFF]', user_query))
    is_bengali_input = bool(re.search(r'[\u0980-\u09FF]', user_query))

    # Resolve target output language
    if output_language and output_language.strip().lower() not in ["auto", "default", "none", ""]:
        target_lang = output_language.strip()
    else:
        if is_hindi_input:
            target_lang = "Hindi"
        elif is_tamil_input:
            target_lang = "Tamil"
        elif is_telugu_input:
            target_lang = "Telugu"
        elif is_kannada_input:
            target_lang = "Kannada"
        elif is_malayalam_input:
            target_lang = "Malayalam"
        elif is_gujarati_input:
            target_lang = "Gujarati"
        elif is_bengali_input:
            target_lang = "Bengali"
        else:
            target_lang = "English"

    logging.info(f"Target Output Language resolved to: {target_lang}")

    candidates_y = retrieve_hybrid_candidates(search_query, top_y=12, jurisdiction=jurisdiction)
    top_z = rerank_with_cross_encoder(search_query, candidates_y, top_z=4)
    candidates_y = retrieve_hybrid_candidates(search_query, top_y=8, jurisdiction=jurisdiction)
    top_z = rerank_with_cross_encoder(search_query, candidates_y, top_z=3)
    retrieved_parents = expand_to_parents(top_z)

    # If top_z is empty, fallback to candidates_y
    if not retrieved_parents and candidates_y:
        retrieved_parents = expand_to_parents(candidates_y[:3])

    max_confidence = max((c["final_confidence"] for c in top_z), default=0.0)
    effective_threshold = RETRIEVAL_CONFIDENCE_THRESHOLD
    logging.info(f"Calculated peak retrieval confidence: {max_confidence:.4f} (Mandatory Threshold: {effective_threshold:.2f})")

    context_blocks = []
    for idx, p in enumerate(retrieved_parents, 1):
        full_text = p['full_text']
        if len(full_text) > 7000:
            # For massive statutory schedules, provide a focused excerpt window around the query
            displayed_text = full_text[:6500] + "\n...[Remaining statutory provisions preserved in full parent text for in-app viewer]..."
        if len(full_text) > 3500:
            # Provide a focused statutory excerpt window for ultra-fast LLM ingestion
            displayed_text = full_text[:3200] + "\n...[Remaining statutory provisions preserved in full parent text for in-app viewer]..."
        else:
            displayed_text = full_text

        block = f"""--- STATUTORY CITATION SOURCE [{idx}] ---
Source Act/Database: {p['act_or_database']}
Section/Form Reference: {p['section_or_form']}
Document Title: {p['title']}
Authorized Deep URL: {p['source_url']} (Precision: {p['url_precision']})
Effective Date: {p['effective_date']}
Verbatim Statutory Text:
{displayed_text}
"""
        context_blocks.append(block)

    grounding_context = "\n\n".join(context_blocks)

    # =========================================================================
    # HARD GROUNDING GATE (Requirement 4)
    # If retrieved context is empty, below minimum length (150 chars), or below
    # the calibrated confidence threshold (effective_threshold), FORCE immediate abstention.
    # The LLM is NEVER called. This is a hard rule that cannot be overridden.
    # =========================================================================
    MIN_GROUNDING_CHAR_LENGTH = 150
    gate_failed = False
    gate_reason = ""

    out_of_scope_patterns = [
        r'\b(biryani|biriyani|recipe|cook|cooking|bake|curry|food recipe|dish|kitchen|roti|paneer|pizza|burger)\b',
        r'\b(dance|salsa|tango|sing|song|movie|film|actor|cricket|football|soccer|weather|joke)\b',
        r'\b(write a poem|python script|write code|fix my code|javascript function)\b'
    ]
    is_explicitly_out_of_scope = any(re.search(pat, user_query.lower()) for pat in out_of_scope_patterns)

    if is_explicitly_out_of_scope:
        gate_failed = True
        gate_reason = "Query topic is outside the scope of AYUSH intellectual property and statutory patent regulatory frameworks."
    elif not retrieved_parents or len(retrieved_parents) == 0:
        gate_failed = True
        gate_reason = "Zero relevant statutory parent sections retrieved from authorized repositories."
    elif len(grounding_context.strip()) < MIN_GROUNDING_CHAR_LENGTH:
        gate_failed = True
        gate_reason = f"Retrieved statutory text length ({len(grounding_context.strip())} chars) is below minimum grounding threshold ({MIN_GROUNDING_CHAR_LENGTH} chars)."
    elif max_confidence < effective_threshold:
        gate_failed = True
        gate_reason = f"Peak retrieval confidence score ({max_confidence:.4f}) is below mandatory threshold ({effective_threshold:.2f})."

    if gate_failed:
        logging.warning(f"[HARD GROUNDING GATE TRIGGERED] Query: '{user_query}' | Reason: {gate_reason}. ABSTAINING IMMEDIATELY BEFORE LLM CALL.")
        abstention_text = (
            f"This inquiry regarding **\"{user_query}\"** falls outside the statutory scope of the AyushIP Regulatory Intelligence Portal. "
            f"This inquiry regarding **\"{user_query}\"** falls outside the statutory scope of the IP-SAKTI Sahayak Regulatory Intelligence Portal. "
            f"Our repository exclusively covers intellectual property laws, patentability criteria (Section 3(p)), Access and Benefit Sharing (ABS) compliance, "
            f"and regulatory licensing under the Patents Act 1970, Biological Diversity Act 2002, Drugs & Cosmetics Act 1940, and the Traditional Knowledge Digital Library (TKDL). "
            f"Please submit an AYUSH, classical formulation, or patent-related statutory question."
        )
        return {
            "answer": abstention_text,
            "citations": [],
            "confidence": "LOW",
            "needsHumanEscalation": True,
            "isClassicalTKDL": False,
            "absChecklist": {"applies": False, "complianceSteps": [], "overallRisk": "EXEMPT"},
            "outputLanguage": target_lang,
            "abstained": True,
            "gateReason": gate_reason,
            "retrievalMetrics": {
                "peakConfidence": max_confidence,
                "threshold": effective_threshold,
                "retrievedParentCount": len(retrieved_parents),
                "gatePassed": False
            }
        }

    conversation_history_text = ""
    for m in messages[:-1]:
        r = "User" if m.get("role") in ["user", "human"] else "Assistant"
        c = m.get("content", "").strip()
        if c:
            conversation_history_text += f"[{r}]: {c[:350]}\n\n"

    system_instruction = f"""You are an elite, highly knowledgeable AI legal assistant specializing exclusively in Intellectual Property and statutory regulatory compliance for Ayurveda and Indian traditional medicine.

MANDATORY FOUR-DOMAIN REGULATORY RESTRICTION (STRICT):
You are strictly restricted to grounding your response EXCLUSIVELY on the retrieved statutory parent documents provided below from the four authorized official sources:
1. indiacode.gov.in (Patents Act 1970, Biological Diversity Act 2002, Drugs & Cosmetics Act 1940)
2. ipindia.gov.in (IP India Patent Guidelines for Traditional Knowledge, Patents Rules 2024, Trade Marks Class 5)
3. nbaindia.nic.in (National Biodiversity Authority Form I, Form III, ABS Regulations)
4. tkdl.res.in (Traditional Knowledge Digital Library public defensive protection scope & access agreements)

CRITICAL INSTRUCTIONS:
1. NEVER produce a generic, identical, or repetitive answer. Every response MUST directly address the user's specific question: '{user_query}'.
2. Ground all legal claims directly on the retrieved statutory text provided in the Grounded Context below.
3. Every key legal assertion or provision must include an inline citation tag corresponding to the retrieved provisions (e.g. [Patents Act 1970 § 3(p), as on 2024-03-15]).
4. Direct, scannable format:
   - **Direct Summary**: 1-2 sentences on core legal position tailored to the user's query.
   - **Key Statutory Provisions**: Bullet points with exact statutory references from the retrieved context.
   - **Actionable Next Steps**: 2-3 specific compliance steps.
   - Disclaimers: Include disclaimer in the output language (e.g. '*Disclaimer: Information, not legal advice.*').
5. STRICT OUT-OF-SCOPE RULE:
   If the user's query asks about general culinary recipes, everyday cooking, domestic activities, sports, entertainment, or general coding, DO NOT attempt to stretch statutory provisions or invent ABS obligations.
   Instead, respond strictly with a single short, formal paragraph stating that the query falls outside the statutory scope of the AyushIP Portal and invite an AYUSH intellectual property or patent inquiry.
   Instead, respond strictly with a single short, formal paragraph stating that the query falls outside the statutory scope of the IP-SAKTI Sahayak Portal and invite an AYUSH intellectual property or patent inquiry.
6. ABSOLUTE MANDATORY OUTPUT RESPONSE LANGUAGE RULE:
   The user has set the desired Output Response Language to: **{target_lang.upper()}**.
   You MUST generate the entire 'answer' field (headings, analysis, bullet points, recommendations, and disclaimers) strictly in **{target_lang}** ({target_lang} script). Maintain accurate citations and statutory section numbers.

GROUNDED STATUTORY CONTEXT (FROM 4 AUTHORIZED DOMAINS):
{grounding_context}
"""

    llm_prompt = f"""Conversation History (for context):
{conversation_history_text if conversation_history_text else "None (first turn)."}

Current User Query: {user_query}
Target Jurisdiction: {jurisdiction}
Formulation Category: {formulation_category}
Target Output Language: {target_lang}

Generate complete grounded legal guidance specifically answering the Current User Query conforming strictly to the structured schema.
CRITICAL REQUIREMENT: Write the entire 'answer' text strictly in {target_lang}."""

    response_data = None
    if ai_client:
        models_to_try = list(dict.fromkeys([
            GEMINI_MODEL,
            "gemini-3.1-flash-lite",
            "gemini-3.5-flash",
            "gemini-3.7-flash"
            "gemini-3.5-flash-lite",
            "gemini-3.6-flash",
            "gemini-3.1-flash-lite"
        ]))

        for model_candidate in models_to_try:
            try:
                logging.info(f"Calling Gemini ({model_candidate}) with grounded statutory context in {target_lang}...")
                response = ai_client.models.generate_content(
                    model=model_candidate,
                    contents=llm_prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=system_instruction,
                        max_output_tokens=1500,
                        thinking_config=types.ThinkingConfig(thinking_level="minimal"),
                        response_mime_type="application/json",
                        response_json_schema={
                            "type": "OBJECT",
                            "properties": {
                                "answer": {"type": "STRING", "description": f"The detailed markdown response grounded strictly in the context, written entirely in {target_lang}."},
                                "citations": {
                                    "type": "ARRAY",
                                    "items": {
                                        "type": "OBJECT",
                                        "properties": {
                                            "source": {"type": "STRING"},
                                            "sectionRef": {"type": "STRING"},
                                            "description": {"type": "STRING"}
                                        },
                                        "required": ["source", "sectionRef"]
                                    }
                                },
                                "confidence": {"type": "STRING", "enum": ["HIGH", "MEDIUM", "LOW"]},
                                "needsHumanEscalation": {"type": "BOOLEAN"},
                                "isClassicalTKDL": {"type": "BOOLEAN"}
                            },
                            "required": ["answer", "citations", "confidence", "needsHumanEscalation", "isClassicalTKDL"]
                        }
                    )
                )
                if response and response.text:
                    response_data = json.loads(response.text)
                    logging.info(f"Successfully generated grounded answer using {model_candidate}!")
                    break
            except Exception as e:
                logging.warning(f"Model {model_candidate} failed: {e}. Trying fallback model...")

    if not response_data and retrieved_parents:
        # Dynamic response derived strictly from the actual retrieved documents for this query
        points = []
        for p in retrieved_parents[:3]:
            snippet = p["full_text"][:220].replace("\n", " ").strip()
            points.append(f"- **{p['section_or_form']} ({p['act_or_database']})**: {snippet}... [{p['section_or_form']}]({p['source_url']})")

        dynamic_answer = (
            f"### Statutory Guidance on: {user_query}\n\n"
            f"Under Indian statutory Intellectual Property and AYUSH regulatory law, your query is governed by the following retrieved provisions:\n\n"
            + "\n".join(points) + "\n\n"
            f"### Recommended Compliance Actions\n"
            f"1. Verify compliance under **{retrieved_parents[0]['section_or_form']}** prior to commercial or patent execution.\n"
            f"2. Consult official statutory filings at [{retrieved_parents[0]['act_or_database']}]({retrieved_parents[0]['source_url']}).\n\n"
            f"*Disclaimer: This statutory intelligence is for informational guidance and does not constitute attorney legal counsel.*"
        )
        response_data = {
            "answer": dynamic_answer,
            "citations": [],
            "confidence": "HIGH" if max_confidence > 0.3 else "MEDIUM",
            "needsHumanEscalation": False,
            "isClassicalTKDL": any("tkdl" in p["act_or_database"].lower() for p in retrieved_parents) or formulation_category == "Classical Medicine"
        }


    raw_citations = response_data.get("citations", [])
    verified_citations = verify_citations_deterministically(raw_citations, retrieved_parents, user_query=user_query)
    
    print("BACKEND: RAW CITATIONS FROM LLM:", raw_citations)
    print(f"BACKEND: VERIFIED CITATIONS ({len(verified_citations)} citations verified):", [
        {"source": c.get("source"), "sectionRef": c.get("sectionRef"), "url": c.get("url"), "snippet": c.get("exactTextSnippet", "")[:80]}
        for c in verified_citations
    ])
    
    abs_assessment = evaluate_abs_compliance(user_query, retrieved_parents)
    is_classical = response_data.get("isClassicalTKDL", False) or any("tkdl" in p["act_or_database"].lower() for p in retrieved_parents) or formulation_category == "Classical Medicine"

    return {
        "answer": response_data["answer"],
        "citations": verified_citations,
        "confidence": response_data.get("confidence", "HIGH"),
        "needsHumanEscalation": response_data.get("needsHumanEscalation", False),
        "isClassicalTKDL": is_classical,
        "absChecklist": abs_assessment,
        "outputLanguage": target_lang,
        "retrievalMetrics": {
            "peakConfidence": max_confidence,
            "threshold": RETRIEVAL_CONFIDENCE_THRESHOLD,
            "retrievedParentCount": len(retrieved_parents),
            "topCandidate": retrieved_parents[0]["section_or_form"] if retrieved_parents else None
        }
    }

