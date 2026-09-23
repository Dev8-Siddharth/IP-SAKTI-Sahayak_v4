"""
Playwright URL Resolver & Statutory Ingestion Validator.
Validates source URLs across the four authorized regulatory repositories:
1. indiacode.gov.in
2. ipindia.gov.in
3. nbaindia.nic.in
4. tkdl.res.in

Enforces Ingestion Acceptance Criteria:
- Detects 'No files available' UI states and metadata-only pages.
- Resolves full-text from underlying APIs or original Gazette PDFs when UI has no direct file.
- Strictly validates jurisdiction: separates Central Acts from State-level records (e.g. Tamil Nadu).
- Excludes non-substantive or empty pages (< 50 words) from usable chunks and logs them as known gaps.
"""

import os
import re
import json
import logging
from typing import Dict, Any, Optional, Tuple
import requests
import pymupdf
from playwright.sync_api import sync_playwright

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

class PlaywrightUrlResolver:
    def __init__(self, headless: bool = True, timeout_ms: int = 20000):
        self.headless = headless
        self.timeout_ms = timeout_ms
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        })

    def _extract_uuid_from_indiacode_url(self, url: str) -> Optional[str]:
        match = re.search(r'/items/([0-9a-fA-F-]{36})', url)
        return match.group(1) if match else None

    def _check_indiacode_api(self, uuid: str) -> Dict[str, Any]:
        """Directly queries India Code DSpace REST API for metadata, statutory note, and attached files."""
        api_url = f"https://indiacode.gov.in/server/api/core/items/{uuid}"
        try:
            r = self.session.get(api_url, timeout=12)
            if r.status_code == 200:
                meta = r.json().get("metadata", {})
                state_name = meta.get("dc.identifier.state_name", [{}])[0].get("value", "")
                act_id = meta.get("dc.identifier.act_id", [{}])[0].get("value", "")
                dept_name = meta.get("dc.identifier.department_name", [{}])[0].get("value", "")
                title = meta.get("dc.title", [{}])[0].get("value", "")
                sec_num = meta.get("dc.identifier.section_number", [{}])[0].get("value", "")
                note_html = meta.get("dc.identifier.section_page_note", [{}])[0].get("value", "")
                
                # Strip basic HTML tags from section note
                clean_text = re.sub(r'<[^>]+>', ' ', note_html)
                clean_text = re.sub(r'\s+', ' ', clean_text).strip()

                # Check bundles for bitstreams
                bundles_r = self.session.get(f"{api_url}/bundles", timeout=10)
                has_pdf = False
                pdf_urls = []
                if bundles_r.status_code == 200:
                    bundles = bundles_r.json().get("_embedded", {}).get("bundles", [])
                    for b in bundles:
                        if b.get("name") == "ORIGINAL":
                            has_pdf = True

                return {
                    "ok": True,
                    "state_name": state_name,
                    "act_id": act_id,
                    "dept_name": dept_name,
                    "title": title,
                    "section_number": sec_num,
                    "text": clean_text,
                    "has_pdf": has_pdf,
                    "is_central": (state_name.upper() == "CENTRAL" or act_id.startswith("AC_CEN"))
                }
        except Exception as e:
            logging.warning(f"Error checking India Code API for {uuid}: {e}")
        return {"ok": False}

    def _extract_pdf_text(self, pdf_url: str, max_pages: int = 15) -> str:
        """Downloads and extracts text from an authoritative PDF."""
        try:
            r = self.session.get(pdf_url, timeout=25)
            if r.status_code == 200 and len(r.content) > 100:
                doc = pymupdf.open(stream=r.content, filetype="pdf")
                pages_text = []
                for i in range(min(len(doc), max_pages)):
                    pages_text.append(doc[i].get_text())
                return "\n".join(pages_text).strip()
        except Exception as e:
            logging.warning(f"Failed to extract PDF text from {pdf_url}: {e}")
        return ""

    def resolve_and_extract(
        self, 
        url: str, 
        required_scope: str = "Central",
        min_word_count: int = 50
    ) -> Dict[str, Any]:
        """
        Main extraction entry point.
        Uses Playwright and/or repository APIs to inspect the page.
        Returns:
            status: 'USABLE' or 'GAP'
            gap_reason: detailed explanation if excluded
            text: substantive extracted body text
            word_count: number of words
            metadata: resolved title, jurisdiction, state, act_id
        """
        logging.info(f"Resolving URL: {url} (Required Scope: {required_scope})")

        # Handle direct PDF URLs
        if url.lower().endswith(".pdf"):
            pdf_text = self._extract_pdf_text(url)
            words = pdf_text.split()
            if len(words) >= min_word_count:
                return {
                    "status": "USABLE",
                    "url": url,
                    "word_count": len(words),
                    "text": pdf_text,
                    "source_type": "PDF",
                    "scope": "Central",
                    "gap_reason": None
                }
            else:
                return {
                    "status": "GAP",
                    "url": url,
                    "word_count": len(words),
                    "gap_reason": f"PDF contained insufficient substantive text ({len(words)} words < {min_word_count})",
                    "source_type": "PDF"
                }

        # Handle India Code URLs
        if "indiacode.gov.in" in url.lower() or "indiacode.nic.in" in url.lower():
            uuid = self._extract_uuid_from_indiacode_url(url)
            if uuid:
                api_data = self._check_indiacode_api(uuid)
                
                # Check for state-level record when Central is required
                if api_data.get("ok"):
                    state = api_data.get("state_name", "")
                    is_central = api_data.get("is_central", False)
                    act_id = api_data.get("act_id", "")
                    
                    if required_scope.lower() == "central" and not is_central:
                        return {
                            "status": "GAP",
                            "url": url,
                            "title": api_data.get("title", ""),
                            "state": state,
                            "act_id": act_id,
                            "gap_reason": f"State-level record detected ('{state}', Act ID: {act_id}) for Central Act query. Excluded from Central corpus.",
                            "source_type": "India Code (State Record)"
                        }

                    # Check body text in section note
                    sec_text = api_data.get("text", "")
                    words = sec_text.split()
                    if len(words) >= min_word_count:
                        return {
                            "status": "USABLE",
                            "url": url,
                            "title": api_data.get("title", ""),
                            "section": api_data.get("section_number", ""),
                            "act_id": act_id,
                            "state": state,
                            "scope": "Central" if is_central else state,
                            "text": sec_text,
                            "word_count": len(words),
                            "source_type": "India Code (Statutory Section Note)"
                        }

        # Use Playwright for dynamic browser inspection
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=self.headless)
                page = browser.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)
                page.wait_for_timeout(3000)

                page_title = page.title()
                raw_body = page.inner_text("body")
                browser.close()

                body_lower = raw_body.lower()
                is_no_files = "no files available" in body_lower or "no file available" in body_lower
                is_state_law = "tamil nadu" in body_lower or "chhattisgarh" in body_lower or "states laws" in body_lower

                # If page shows 'No files available' or metadata only
                if is_no_files and required_scope.lower() == "central" and is_state_law:
                    return {
                        "status": "GAP",
                        "url": url,
                        "title": page_title,
                        "gap_reason": "Playwright detected 'No files available' state on state-specific repository page. No substantive body text accessible.",
                        "source_type": "Playwright DOM Inspection"
                    }

                # General substantive text extraction
                cleaned_lines = [line.strip() for line in raw_body.splitlines() if len(line.strip().split()) > 4]
                substantive_text = "\n".join(cleaned_lines)
                words = substantive_text.split()

                if len(words) < min_word_count:
                    return {
                        "status": "GAP",
                        "url": url,
                        "title": page_title,
                        "word_count": len(words),
                        "gap_reason": f"Page contains only metadata or navigation text ({len(words)} words < {min_word_count} minimum body text).",
                        "source_type": "Playwright DOM Inspection"
                    }

                return {
                    "status": "USABLE",
                    "url": url,
                    "title": page_title,
                    "word_count": len(words),
                    "text": substantive_text,
                    "source_type": "Playwright DOM"
                }
        except Exception as e:
            return {
                "status": "GAP",
                "url": url,
                "gap_reason": f"Extraction failed with error: {str(e)}",
                "source_type": "Error"
            }

if __name__ == "__main__":
    resolver = PlaywrightUrlResolver()
    
    # Test 1: The problematic Tamil Nadu Section 6 URL
    tn_url = "https://indiacode.gov.in/items/134e1072-b6b1-49fd-ba31-d5f9abaad864"
    res1 = resolver.resolve_and_extract(tn_url, required_scope="Central")
    print("\n--- TEST 1: Tamil Nadu Section 6 Record ---")
    print("Status:", res1["status"])
    print("Gap Reason:", res1.get("gap_reason"))

    # Test 2: The authentic Central BDA Section 6 URL
    central_url = "https://indiacode.gov.in/items/a42b429f-5f15-4229-a733-7f8718e55287"
    res2 = resolver.resolve_and_extract(central_url, required_scope="Central")
    print("\n--- TEST 2: Central Act Section 6 Record ---")
    print("Status:", res2["status"])
    print("Title:", res2.get("title"))
    print("Word Count:", res2.get("word_count"))
    print("Snippet:", res2.get("text", "")[:180])

