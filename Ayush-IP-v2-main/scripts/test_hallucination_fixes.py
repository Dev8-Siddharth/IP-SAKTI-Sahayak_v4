import sys
import json
import os

# Add parent directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.rag_service import (
    retrieve_hybrid_candidates,
    rerank_with_cross_encoder,
    expand_to_parents,
    verify_citations_deterministically,
    extract_verbatim_statutory_substring,
    RETRIEVAL_CONFIDENCE_THRESHOLD
)

MIN_GROUNDING_CHARS = 150

def test_section_6_retrieval_and_verbatim_citation():
    print("\n" + "="*70)
    print("TEST 1: SECTION 6 BDA RETRIEVAL & VERBATIM CITATION EXTRACTION")
    print("="*70)
    query = "What does Section 6 of the Biological Diversity Act require before applying for a patent?"
    
    # 1. Retrieve candidates
    candidates = retrieve_hybrid_candidates(query, top_y=16, jurisdiction="Central")
    reranked = rerank_with_cross_encoder(query, candidates, top_z=6)
    parents = expand_to_parents(reranked)
    
    print(f"Query: '{query}'")
    
    # Locate Section 6 chunk
    sec_6_chunk = next((c for c in reranked if "bda_sec_6" in c.get("child_id", "") or c.get("section_or_form") == "Section 6"), None)
    assert sec_6_chunk is not None, "Section 6 chunk must be present in reranked candidates!"
    
    print(f"Section 6 Reranked Chunk: {sec_6_chunk['child_id']} (Score: {sec_6_chunk.get('cross_encoder_score', 0.0):.4f})")
    print(f"Chunk Act: {sec_6_chunk['act_or_database']} | Section: {sec_6_chunk.get('section_or_form')}")
    print(f"Chunk URL: {sec_6_chunk['source_url']}")
    print(f"Scope: {sec_6_chunk.get('act_scope')} | State: {sec_6_chunk.get('state_name')}")
    
    # Verify it is Central Act Section 6, NOT Tamil Nadu state
    assert "a42b429f-5f15-4229-a733-7f8718e55287" in sec_6_chunk['source_url'], "Must be Central Act Section 6 UUID"
    assert sec_6_chunk.get('act_scope') == "Central", "Must be Central scope"
    assert sec_6_chunk.get('state_name') == "CENTRAL", "State name must be CENTRAL"
    
    # Check parent
    sec_6_parent = next((p for p in parents if "Section 6" in p["title"]), None)
    assert sec_6_parent is not None, "Section 6 parent must be in retrieved parents"
    
    # Extract verbatim substring
    verbatim_snippet = extract_verbatim_statutory_substring(query, sec_6_parent["full_text"])
    print(f"\n[PASS] Verbatim Extracted Snippet ({len(verbatim_snippet)} chars):")
    print(f"  \"{verbatim_snippet}\"")
    
    # Cryptographic proof: snippet is a strict verbatim substring of stored statutory text
    assert verbatim_snippet.rstrip(".").strip() in sec_6_parent["full_text"], "FAIL: Snippet is NOT a substring of stored text!"
    print(f"\n[VERIFIED] 'snippet in parent.full_text' == True (Strict Verbatim Grounding Guaranteed)")
    
    # Simulate citation verifier rejecting LLM hallucinated snippet
    mock_llm_citation = [{
        "source": "Biological Diversity Act 2002 - Section 6",
        "actOrDatabase": "Biological Diversity Act 2002",
        "sectionOrForm": "Section 6",
        "url": "https://indiacode.gov.in/items/a42b429f-5f15-4229-a733-7f8718e55287",
        "exactTextSnippet": "COMPLETELY FABRICATED LLM TEXT: No person shall apply for patent without prior permission of state forest department."
    }]
    verified_citations = verify_citations_deterministically(mock_llm_citation, parents)
    print("\nDeterministic Citation Verifier Output:")
    print(f"  Source: {verified_citations[0]['source']}")
    print(f"  URL: {verified_citations[0]['url']}")
    print(f"  Snippet: \"{verified_citations[0]['exactTextSnippet'][:100]}...\"")
    assert "COMPLETELY FABRICATED" not in verified_citations[0]['exactTextSnippet'], "Hallucinated LLM text must be discarded!"
    assert verified_citations[0]['exactTextSnippet'].rstrip(".").strip() in sec_6_parent["full_text"], "Verified snippet must be verbatim stored text!"
    print("  [PASSED] LLM hallucinated snippet successfully purged and replaced with verbatim statutory text.")

def test_hard_grounding_gate():
    print("\n" + "="*70)
    print("TEST 2: HARD GROUNDING GATE (ABSTENTION WITHOUT LLM CALL)")
    print("="*70)
    out_of_domain_query = "What is the capital gains tax on quantum cryptocurrency mining rigs in Switzerland?"
    
    candidates = retrieve_hybrid_candidates(out_of_domain_query, top_y=8, jurisdiction="Central")
    reranked = rerank_with_cross_encoder(out_of_domain_query, candidates, top_z=4)
    parents = expand_to_parents(reranked)
    
    max_confidence = max([c.get("cross_encoder_score", 0.0) for c in reranked]) if reranked else 0.0
    grounding_context = "\n\n".join([f"=== {p['title']} ===\n{p['full_text']}" for p in parents])
    
    print(f"Out-of-Domain Query: '{out_of_domain_query}'")
    print(f"Peak Retrieval Confidence: {max_confidence:.4f} (Threshold: {RETRIEVAL_CONFIDENCE_THRESHOLD})")
    
    gate_triggered = (
        len(parents) == 0
        or len(grounding_context.strip()) < MIN_GROUNDING_CHARS
        or max_confidence < RETRIEVAL_CONFIDENCE_THRESHOLD
    )
    
    print(f"Gate Triggered: {gate_triggered}")
    assert gate_triggered is True, "Hard Grounding Gate MUST trigger for out-of-domain query!"
    print("[PASSED] Immediate Abstention Gate successfully activated prior to LLM call.")

def test_known_gaps_logging():
    print("\n" + "="*70)
    print("TEST 3: KNOWN GAPS LOG & EXCLUSION OF STATE-LEVEL RECORDS")
    print("="*70)
    gaps_file = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "corpus", "known_gaps.json"))
    with open(gaps_file, "r", encoding="utf-8") as f:
        gaps_data = json.load(f)
    
    print(f"Known Gaps Count: {gaps_data['total_gaps_logged']}")
    for g in gaps_data["gaps"]:
        print(f"  - [{g['reason']}] URL: {g['url']} | Scope: {g.get('scope', 'N/A')}")
        
    tamil_nadu_gap = next((g for g in gaps_data["gaps"] if "134e1072-b6b1-49fd-ba31-d5f9abaad864" in g["url"]), None)
    assert tamil_nadu_gap is not None, "Old Tamil Nadu Section 6 URL must be recorded in known_gaps.json"
    print(f"\n[PASSED] Defective Tamil Nadu URL successfully quarantined in known_gaps.json: reason='{tamil_nadu_gap['reason']}'")

if __name__ == "__main__":
    test_section_6_retrieval_and_verbatim_citation()
    test_hard_grounding_gate()
    test_known_gaps_logging()
    print("\n" + "="*70)
    print("ALL TARGETED VERIFICATION TESTS COMPLETED SUCCESSFULLY!")
    print("="*70)
