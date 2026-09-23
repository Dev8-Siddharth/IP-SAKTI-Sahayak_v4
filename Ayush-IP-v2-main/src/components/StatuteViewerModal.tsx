import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, BookOpen, ExternalLink, Copy, Check, ShieldCheck, Scale, FileText, Download } from 'lucide-react';
import { EnrichedCitation } from '../lib/citationUtils';

interface StatuteViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  citation: EnrichedCitation | null;
}

export function StatuteViewerModal({ isOpen, onClose, citation }: StatuteViewerModalProps) {
  const [copied, setCopied] = useState(false);

  if (!citation) return null;

  const handleCopy = () => {
    const textToCopy = `[Official Statutory Citation]\nSource: ${citation.source}\nSection: ${citation.sectionRef || 'N/A'}\nAuthority: ${citation.portalName}\nOfficial URL: ${citation.official_pdf_url || citation.url}\n\n[Retrieved Excerpt]:\n"${citation.exactTextSnippet}"\n\n[Full Statutory Context]:\n${citation.parent_text || citation.exactTextSnippet}`;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fullText = citation.parent_text || citation.exactTextSnippet || "No extended statutory context available.";
  const snippet = citation.exactTextSnippet || "";

  // Render full text with retrieved snippet highlighted if it exists as substring
  const renderHighlightedText = () => {
    if (!snippet || !fullText.includes(snippet.trim())) {
      return (
        <div className="text-sm text-[#2D2A26] leading-relaxed whitespace-pre-wrap font-serif">
          {fullText}
        </div>
      );
    }

    const trimmedSnippet = snippet.trim();
    const parts = fullText.split(trimmedSnippet);

    return (
      <div className="text-sm text-[#2D2A26] leading-relaxed whitespace-pre-wrap font-serif">
        {parts.map((part, i) => (
          <React.Fragment key={i}>
            {part}
            {i < parts.length - 1 && (
              <mark className="bg-[#FEF08A] text-[#713F12] font-semibold px-1 py-0.5 rounded border border-[#FACC15] shadow-2xs">
                {trimmedSnippet}
              </mark>
            )}
          </React.Fragment>
        ))}
      </div>
    );
  };

  const isPdf = Boolean(
    citation.official_pdf_url &&
    citation.official_pdf_url.toLowerCase().includes('.pdf')
  );
  const portalUrl = citation.url || "https://ipindia.gov.in";
  const pdfUrl = isPdf ? citation.official_pdf_url : null;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-xs">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ duration: 0.2 }}
            className="w-full max-w-3xl bg-[#FAF8F5] border border-[#D5CEC5] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
          >
            {/* Header */}
            <div className="p-5 border-b border-[#E6E0D6] bg-white flex items-start justify-between gap-4 shrink-0">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#E8F5E9] border border-[#C8E6C9] flex items-center justify-center shrink-0 mt-0.5">
                  <Scale className="w-5 h-5 text-[#2E7D32]" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="bg-[#FAF3E8] text-[#7A603E] border border-[#E8DEC8] px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider">
                      {citation.portalName}
                    </span>
                    <span className="bg-[#E8F5E9] text-[#2E7D32] border border-[#C8E6C9] px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3" />
                      Statutory Primary Record
                    </span>
                  </div>
                  <h3 className="text-base sm:text-lg font-bold text-[#1F1D1A] leading-tight">
                    {citation.source}
                  </h3>
                  <p className="text-xs text-[#6C6661] mt-0.5 font-medium">
                    {citation.description || citation.docCategory}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-lg text-[#6C6661] hover:text-[#1F1D1A] hover:bg-[#F0EAE1] transition-colors shrink-0"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              {/* Highlighted Retreived Excerpt Box */}
              {snippet && (
                <div className="bg-[#FFFBEB] border-2 border-[#FDE68A] rounded-xl p-4 space-y-2 shadow-2xs">
                  <div className="flex items-center justify-between text-xs font-bold text-[#B45309]">
                    <div className="flex items-center gap-1.5 uppercase tracking-wide">
                      <FileText className="w-4 h-4 text-[#D97706]" />
                      <span>Verbatim Extracted Statutory Snippet</span>
                    </div>
                    <span className="text-[10px] bg-[#FEF3C7] text-[#92400E] px-2 py-0.5 rounded-full font-mono">
                      Grounded Answer Source
                    </span>
                  </div>
                  <blockquote className="text-xs sm:text-sm text-[#78350F] italic font-serif leading-relaxed border-l-3 border-[#F59E0B] pl-3 py-0.5">
                    "{snippet}"
                  </blockquote>
                </div>
              )}

              {/* Full Statutory Section Context */}
              <div className="bg-white border border-[#E5E0D8] rounded-xl p-5 space-y-3 shadow-2xs">
                <div className="flex items-center justify-between border-b border-[#F0EAE1] pb-2">
                  <h4 className="text-xs font-bold text-[#2D2A26] uppercase tracking-wider flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-[#2E7D32]" />
                    <span>Complete Statutory Text of Provision</span>
                  </h4>
                  <span className="text-[11px] font-mono text-[#6C6661]">
                    {citation.sectionRef || 'Section Record'}
                  </span>
                </div>
                <div className="max-h-[340px] overflow-y-auto pr-2 scrollbar-thin">
                  {renderHighlightedText()}
                </div>
              </div>

              {/* Legislative Authority & Verification Meta */}
              <div className="bg-[#FAF5ED] border border-[#E8DEC8] rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <div className="text-[11px] font-semibold text-[#5A4D3D]">Legislative Enactment Authority:</div>
                  <div className="text-[11.5px] font-medium text-[#2D2A26] mt-0.5">
                    {citation.portalName} • Central Act Jurisdiction (India)
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-[#7A603E] font-mono">Status: Legally In Force</div>
                  <div className="text-[10px] text-[#2E7D32] font-semibold">100% Verifiable Text</div>
                </div>
              </div>
            </div>

            {/* Footer with Actions */}
            <div className="p-4 border-t border-[#E6E0D6] bg-white flex flex-wrap items-center justify-between gap-3 shrink-0">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-[#5A4D3D] bg-[#FAF5ED] hover:bg-[#F3ECE0] border border-[#E8DEC8] transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[#2E7D32]" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "Copied Citation!" : "Copy Statutory Excerpt"}</span>
              </button>

              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={portalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-[#2D2A26] bg-[#FAF5ED] hover:bg-[#F0EAE1] border border-[#D5CEC5] transition-all"
                  title={`Open official portal source on ${citation.portalName}`}
                >
                  <span>Open Official Govt Source ↗</span>
                  <ExternalLink className="w-3.5 h-3.5 text-[#2E7D32]" />
                </a>

                {pdfUrl && (
                  <a
                    href={pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-[#2E7D32] hover:bg-[#256628] shadow-sm hover:shadow transition-all"
                    title="Open official Government Gazette / Act PDF"
                  >
                    <span>Official Govt PDF ↗</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}

                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-[#6C6661] hover:text-[#2D2A26] hover:bg-[#F0EAE1] transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

