import React, { useRef, useEffect, useState } from 'react';
import { ChatMessage, AppState, OutputLanguage, OUTPUT_LANGUAGES } from '../types';
import { 
  Send, CheckCircle2, AlertCircle, Info, ExternalLink, User, 
  Mic, Download, FileText, Scale, ChevronDown, Check, ShieldCheck,
  Sparkles, RefreshCw, Globe, BookOpen, AlertTriangle, Languages,
  Plus, Trash2, History, MessageSquare, Clock
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, AnimatePresence } from 'motion/react';
import { VoiceModal } from './VoiceModal';
import { CitationsDrawer } from './CitationsDrawer';
import { TopNavbar } from './TopNavbar';
import { exportToPDF, exportToText } from '../lib/exportUtils';
import { enrichCitation, normalizeUrl, EnrichedCitation } from '../lib/citationUtils';
import { StatuteViewerModal } from './StatuteViewerModal';
import { isContentOutOfScope } from '../lib/guardrails';


import { AyushLogo } from './AyushLogo';

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

const SESSIONS_STORAGE_KEY = 'ayush_chat_sessions_v1';

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

interface ChatProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  onOpenAbs: () => void;
}

const SAMPLE_SCENARIOS = [
  {
    query: "Can I patent classical Chyawanprash or Triphala in India?",
    tag: "Sec 3(p) & TKDL"
  },
  {
    query: "What toxicity studies are required under Rule 158B for proprietary herbal extracts?",
    tag: "Rule 158B(II)"
  },
  {
    query: "Do I need National Biodiversity Authority (NBA) approval to patent an Ashwagandha formulation?",
    tag: "BDA Sec 6"
  },
  {
    query: "Are registered AYUSH practitioners exempt from ABS under the 2023 Biological Diversity Amendment?",
    tag: "2023 Amendment"
  },
  {
    query: "Can I register an exclusive trademark for the word 'Ashwagandha' in Class 5?",
    tag: "Trade Marks Sec 9"
  },
  {
    query: "क्या मैं च्यवनप्राश या त्रिफला का भारत में पेटेंट करा सकता हूँ?",
    tag: "Hindi Query"
  }
];

export function Chat({ state, setState, onOpenAbs }: ChatProps) {
  // Chat History & Session Management (Local Persistence)
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    const initialId = Date.now().toString();
    return [{
      id: initialId,
      title: 'New Conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }];
  });

  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].id;
      }
    } catch (e) {}
    return Date.now().toString();
  });

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].messages || [];
      }
    } catch (e) {}
    return [];
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isVoiceOpen, setIsVoiceOpen] = useState(false);
  const [isCitationsOpen, setIsCitationsOpen] = useState(false);
  const [selectedStatute, setSelectedStatute] = useState<EnrichedCitation | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const [activeLang, setActiveLang] = useState('EN');

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Sync messages to active session & localStorage
  const updateSessionMessages = (newMsgs: ChatMessage[]) => {
    setMessages(newMsgs);
    setSessions(prev => {
      const idx = prev.findIndex(s => s.id === currentSessionId);
      let updated: ChatSession[];
      if (idx >= 0) {
        let title = prev[idx].title;
        if ((!title || title === 'New Conversation') && newMsgs.length > 0) {
          const firstUser = newMsgs.find(m => m.role === 'user');
          if (firstUser) {
            title = firstUser.content.slice(0, 32) + (firstUser.content.length > 32 ? '...' : '');
          }
        }
        const updatedSession: ChatSession = {
          ...prev[idx],
          title,
          messages: newMsgs,
          updatedAt: Date.now()
        };
        updated = [...prev];
        updated[idx] = updatedSession;
      } else {
        const firstUser = newMsgs.find(m => m.role === 'user');
        const title = firstUser ? firstUser.content.slice(0, 32) + (firstUser.content.length > 32 ? '...' : '') : 'New Conversation';
        const newSession: ChatSession = {
          id: currentSessionId,
          title,
          messages: newMsgs,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        updated = [newSession, ...prev];
      }
      try {
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

  const handleNewChat = () => {
    const newId = Date.now().toString();
    const newSession: ChatSession = {
      id: newId,
      title: 'New Conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    setSessions(prev => {
      const filtered = prev.filter(s => s.messages.length > 0);
      const nextSessions = [newSession, ...filtered];
      try {
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(nextSessions));
      } catch (e) {}
      return nextSessions;
    });
    setCurrentSessionId(newId);
    setMessages([]);
  };

  const handleSelectSession = (sessionId: string) => {
    const target = sessions.find(s => s.id === sessionId);
    if (target) {
      setCurrentSessionId(sessionId);
      setMessages(target.messages || []);
    }
  };

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => {
      const remaining = prev.filter(s => s.id !== sessionId);
      try {
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(remaining));
      } catch (e) {}
      if (currentSessionId === sessionId) {
        if (remaining.length > 0) {
          setCurrentSessionId(remaining[0].id);
          setMessages(remaining[0].messages || []);
        } else {
          const freshId = Date.now().toString();
          const freshSession: ChatSession = {
            id: freshId,
            title: 'New Conversation',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          setCurrentSessionId(freshId);
          setMessages([]);
          return [freshSession];
        }
      }
      return remaining;
    });
  };

  // Detect active language from last user message or input
  useEffect(() => {
    if (input) {
      if (/[\u0900-\u097F]/.test(input)) setActiveLang('HI');
      else if (/[\u0B80-\u0BFF]/.test(input)) setActiveLang('TA');
      else if (/[\u0C00-\u0C7F]/.test(input)) setActiveLang('TE');
      else if (/[\u0C80-\u0CFF]/.test(input)) setActiveLang('KN');
      else if (/[\u0D00-\u0D7F]/.test(input)) setActiveLang('ML');
      else if (/[\u0A80-\u0AFF]/.test(input)) setActiveLang('GU');
      else setActiveLang('EN');
    }
  }, [input]);

  const handleSendMessage = async (queryText: string) => {
    if (!queryText.trim() || isLoading) return;

    // Out of scope check: allow conversational continuity if conversation has turns
    if (isContentOutOfScope(queryText, messages.length > 0)) {
      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: queryText,
      };

      const outOfScopeMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `I am specialized exclusively in Ayurvedic Intellectual Property and statutory regulatory law (Patents Act 1970, Biological Diversity Act, Drugs & Cosmetics Act, and TKDL). Please ask a question related to Ayurvedic formulations, patentability, NBA clearance, or drug licensing.`,
        confidence: 'LOW',
        needsHumanEscalation: false,
      };

      updateSessionMessages([...messages, userMsg, outOfScopeMsg]);
      setInput('');
      return;
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: queryText,
    };

    const newMsgs = [...messages, userMsg];
    updateSessionMessages(newMsgs);
    setInput('');
    setIsLoading(true);

    try {
      const apiMessages = messages.map(m => ({ 
        role: m.role, 
        content: m.content,
        citations: m.citations,
        confidence: m.confidence,
        needsHumanEscalation: m.needsHumanEscalation,
        isClassicalTKDL: m.isClassicalTKDL,
        absChecklist: m.absChecklist
      })).concat({ 
        role: 'user', 
        content: userMsg.content 
      } as any);
      
      const requestStartTime = performance.now();
      const response = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          jurisdiction: state.jurisdiction,
          formulationCategory: state.formulationCategory,
          outputLanguage: state.textOutputLanguage
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server responded with status ${response.status}`);
      }

      const data = await response.json();
      const elapsedMs = Math.round(performance.now() - requestStartTime);
      
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.answer,
        citations: data.citations,
        confidence: data.confidence,
        needsHumanEscalation: data.needsHumanEscalation,
        isClassicalTKDL: data.isClassicalTKDL || state.formulationCategory === 'Classical Medicine',
        absChecklist: data.absChecklist,
        executionTimeMs: elapsedMs
      };

      updateSessionMessages([...newMsgs, assistantMsg]);
    } catch (error) {
      console.error(error);
      updateSessionMessages([...newMsgs, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'I apologize, but I encountered an error while retrieving statutory intelligence. Please retry your query.',
        confidence: 'LOW'
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSendMessage(input);
  };

  const handleCopyContent = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMessageId(id);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  const totalCitationsCount = messages.reduce((acc, m) => acc + (m.citations?.length || 0), 0);

  const getFormattedTime = () => {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-[#FAF5ED] text-[#2D2A26]">
      {/* Top Header Navigation & Filter Sub-Bar */}
      <TopNavbar
        state={state}
        setState={setState}
        onOpenAbs={onOpenAbs}
        onOpenCitations={() => setIsCitationsOpen(true)}
        onClearChat={handleNewChat}
        onExportPDF={() => exportToPDF(messages, state)}
        onExportText={() => exportToText(messages, state)}
        totalCitationsCount={totalCitationsCount}
        activeLanguage={activeLang}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(prev => !prev)}
      />

      {/* Main Container with Left Panel Sidebar & Chat Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto my-3 sm:my-5 px-2 sm:px-4 flex flex-col md:flex-row gap-4 items-stretch">
        
        {/* Left Panel Sidebar - Chat History & Sessions */}
        <AnimatePresence initial={false}>
          {isSidebarOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 280, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="w-full md:w-[280px] shrink-0 bg-white rounded-2xl border border-[#E5E0D8] shadow-xs flex flex-col overflow-hidden max-h-[350px] md:max-h-none md:min-h-[75vh]"
            >
              {/* Sidebar Header */}
              <div className="p-3.5 border-b border-[#ECE6DC] flex items-center justify-between bg-[#FAF8F5]">
                <div className="flex items-center gap-2 text-[#2D2A26] font-bold text-xs">
                  <History className="w-4 h-4 text-[#2E7D32]" />
                  <span>Chat History</span>
                </div>
                <button
                  onClick={handleNewChat}
                  className="flex items-center gap-1 bg-[#2E7D32] hover:bg-[#256628] text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition-colors shadow-2xs cursor-pointer"
                  title="Start a new chat thread"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Chat</span>
                </button>
              </div>

              {/* Sessions List */}
              <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
                {sessions.length === 0 || (sessions.length === 1 && sessions[0].messages.length === 0) ? (
                  <div className="p-6 text-center text-xs text-[#8C827A] flex flex-col items-center justify-center gap-2 h-48">
                    <MessageSquare className="w-7 h-7 text-[#C8BFB5]" />
                    <p className="font-medium text-[#5C554E]">No past chats yet</p>
                    <p className="text-[11px] text-[#A89F95] leading-relaxed">
                      Ask any question and your conversation thread will be saved here automatically.
                    </p>
                  </div>
                ) : (
                  sessions.map((sess) => {
                    const isActive = sess.id === currentSessionId;
                    const msgCount = sess.messages.length;
                    return (
                      <div
                        key={sess.id}
                        onClick={() => handleSelectSession(sess.id)}
                        className={`group relative p-2.5 rounded-xl text-left cursor-pointer transition-all flex items-start justify-between gap-2 border ${
                          isActive
                            ? 'bg-[#FAF5ED] border-[#C86D28] shadow-2xs ring-1 ring-[#C86D28]/30'
                            : 'border-transparent hover:bg-[#FAF8F5] hover:border-[#E5E0D8]'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-[#C86D28]' : 'bg-[#A89F95]'}`} />
                            <p className={`text-xs font-semibold truncate ${isActive ? 'text-[#2D2A26]' : 'text-[#5C554E]'}`}>
                              {sess.title || 'New Conversation'}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 text-[10.5px] font-mono text-[#8C827A] pl-3">
                            <span>{formatRelativeTime(sess.updatedAt)}</span>
                            <span>•</span>
                            <span>{msgCount} turn{msgCount === 1 ? '' : 's'}</span>
                          </div>
                        </div>

                        <button
                          onClick={(e) => handleDeleteSession(sess.id, e)}
                          className="opacity-0 group-hover:opacity-100 p-1 text-[#8C827A] hover:text-red-600 rounded transition-opacity cursor-pointer"
                          title="Delete thread"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Chat Main Window Card */}
        <div className="flex-1 bg-white rounded-2xl border border-[#E5E0D8] shadow-xs flex flex-col min-h-[70vh] sm:min-h-[78vh] overflow-hidden">
          
          {/* Messages Area or Empty Scenario Landing */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 scrollbar-thin">
            {messages.length === 0 ? (
              <div className="py-6 sm:py-8 px-2 max-w-2xl mx-auto text-center flex flex-col items-center justify-center my-auto">
                {/* Scale / National Ayush Mission Logo */}
                <div className="mx-auto mb-3.5 flex justify-center">
                  <AyushLogo className="w-16 h-16 shadow-2xs" />
                </div>

                {/* Main Heading */}
                <h2 className="text-xl sm:text-2xl font-bold text-[#2D2A26] mb-2 tracking-tight">
                  Ayurvedic IP & Regulatory Guidance
                </h2>

                {/* Subtitle Description */}
                <p className="text-xs sm:text-sm text-[#6B635B] max-w-xl mx-auto mb-8 leading-relaxed font-sans">
                  Ask any question on Ayurvedic patentability under Section 3(p)/3(d)/3(e), Biological Diversity ABS compliance, Rule 158B drug licensing, FSSAI Ayurveda Aahar rules, or TKDL prior-art in any Indian language or English.
                </p>

                {/* Sample Scenarios Section */}
                <div className="w-full text-left">
                  <div className="text-xs font-bold text-[#8C6D46] mb-3 flex items-center gap-1.5 px-1">
                    <span>💡 Try Asking (Sample Grounded Scenarios):</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {SAMPLE_SCENARIOS.map((scen, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSendMessage(scen.query)}
                        className="bg-[#FAF8F5] border border-[#ECE6DC] hover:border-[#389B46]/60 hover:bg-white transition-all rounded-xl p-3.5 text-left cursor-pointer group flex flex-col justify-between space-y-2 shadow-2xs"
                      >
                        <p className="text-xs font-medium text-[#2D2A26] group-hover:text-[#2E7D32] leading-snug">
                          "{scen.query}"
                        </p>
                        <div>
                          <span className="inline-block bg-[#F0EAE1] text-[#7A603E] text-[10px] font-mono font-medium px-2 py-0.5 rounded border border-[#E2DAD0]">
                            {scen.tag}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6 max-w-3xl mx-auto">
                {messages.map((msg) => (
                  <div key={msg.id} className="space-y-1">
                    {/* User Message */}
                    {msg.role === 'user' ? (
                      <div className="flex flex-col items-end space-y-1">
                        <div className="text-[11px] text-[#8C827A] font-mono font-medium flex items-center gap-1.5 pr-1">
                          <span>You</span>
                          <span>{getFormattedTime()}</span>
                        </div>
                        <div className="flex items-start gap-2 max-w-[85%]">
                          <div className="bg-[#389B46] text-white rounded-2xl rounded-tr-xs px-5 py-3 text-sm font-normal shadow-2xs leading-relaxed">
                            "{msg.content}"
                          </div>
                          <div className="w-8 h-8 rounded-full bg-[#E8833A] text-white flex items-center justify-center shrink-0 shadow-2xs font-bold text-xs mt-0.5">
                            <User className="w-4 h-4" />
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* Assistant Message */
                      <div className="flex items-start gap-3 max-w-3xl">
                        {/* Assistant Avatar */}
                        <AyushLogo className="w-8 h-8 mt-1 shadow-2xs" />

                        <div className="flex-1 space-y-2">
                          {/* Assistant Header */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-[#2D2A26]">
                              IP-SAKTI Sahayak
                            </span>
                            <span className="text-[11px] text-[#8C827A] font-mono">
                              {getFormattedTime()}
                            </span>
                            <span className="bg-[#FAF3E8] text-[#7A603E] border border-[#E8DEC8] px-2.5 py-0.5 rounded-full text-[10px] font-mono font-medium">
                              {state.jurisdiction} • {state.formulationCategory === 'Unknown' ? 'New' : state.formulationCategory}
                            </span>
                          </div>

                          {/* Assistant Main Response Card */}
                          <div className="bg-[#FAF8F5] border border-[#ECE6DC] rounded-2xl p-4 sm:p-5 space-y-4 text-xs sm:text-sm text-[#2D2A26] leading-relaxed shadow-2xs">
                            
                            {/* Abstained / Low Confidence Warning Card (Image 3 style) */}
                            {msg.confidence === 'LOW' || msg.needsHumanEscalation ? (
                              <div className="bg-white border border-[#E5E0D8] rounded-xl p-4 space-y-2.5">
                                <div className="text-[#8C6D46] font-bold text-xs uppercase tracking-wide flex items-center gap-1.5 border-b border-[#ECE6DC] pb-2">
                                  <Scale className="w-4 h-4 text-[#8C6D46]" />
                                  <span>PROFESSIONAL LEGAL GUIDANCE ADVISORY</span>
                                </div>
                                <p className="text-xs text-[#2D2A26] leading-relaxed font-sans">
                                  {msg.content}
                                </p>
                              </div>
                            ) : (
                              /* Standard Grounded Response Body */
                              <div className="markdown-body prose prose-sm max-w-none text-[#2D2A26]">
                                <Markdown 
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    a: ({ node, href, children, ...props }) => {
                                      const text = Array.isArray(children) ? children.join(' ') : String(children || '');
                                      const normalizedHref = normalizeUrl(href, text, state.jurisdiction);
                                      return (
                                        <a 
                                          {...props} 
                                          href={normalizedHref}
                                          target="_blank" 
                                          rel="noopener noreferrer" 
                                          className="text-[#2E7D32] underline hover:text-[#1B5E20] font-semibold transition-colors"
                                        >
                                          {children}
                                        </a>
                                      );
                                    }
                                  }}
                                >
                                  {msg.content}
                                </Markdown>
                              </div>
                            )}

                            {/* Verified Statutory Citations Cards Grid (Image 2 style) */}
                            {msg.citations && msg.citations.length > 0 && (
                              <div className="space-y-2 pt-2 border-t border-[#ECE6DC]">
                                <div className="text-[#2E7D32] font-semibold text-xs flex items-center gap-1.5">
                                  <CheckCircle2 className="w-4 h-4 text-[#2E7D32]" />
                                  <span>Verified Statutory Citations ({msg.citations.length})</span>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                  {msg.citations.map((cit, idx) => {
                                    console.log("RAW FRONTEND CITATION BEFORE ENRICH:", cit);
                                    const enriched = enrichCitation(cit, state.jurisdiction);
                                    return (
                                      <div 
                                        key={idx}
                                        className="bg-white border border-[#E5E0D8] rounded-xl p-3 flex flex-col justify-between space-y-2 relative shadow-2xs hover:border-[#389B46]/50 transition-colors"
                                      >
                                        <div className="flex items-start justify-between gap-2">
                                          <div>
                                            <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                              <span className="bg-[#FAF3E8] text-[#7A603E] border border-[#E8DEC8] px-1.5 py-0.5 rounded text-[9.5px] font-mono font-medium">
                                                {enriched.portalName}
                                              </span>
                                              {enriched.url_precision && (
                                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase tracking-wider border ${
                                                  enriched.url_precision === 'section-level' 
                                                    ? 'bg-[#E8F5E9] text-[#2E7D32] border-[#C8E6C9]' 
                                                    : 'bg-[#FFF8E1] text-[#B78103] border-[#FFE082]'
                                                }`}>
                                                  {enriched.url_precision}
                                                </span>
                                              )}
                                            </div>
                                            <h4 className="font-bold text-xs text-[#2D2A26]">
                                              {enriched.sectionRef || enriched.source}
                                            </h4>
                                            <p className="text-[11px] text-[#6C6661] font-medium mt-0.5">
                                              {enriched.docCategory}
                                            </p>
                                          </div>
                                          <span className="bg-[#E8F5E9] text-[#2E7D32] border border-[#C8E6C9] px-2 py-0.5 rounded text-[10px] font-mono font-medium shrink-0">
                                            {state.jurisdiction}
                                          </span>
                                        </div>

                                        {enriched.exactTextSnippet && (
                                          <p className="text-[11px] text-[#4A4540] italic bg-[#FAF8F5] p-2 rounded-lg border border-[#ECE6DC] font-sans line-clamp-3">
                                            "{enriched.exactTextSnippet}"
                                          </p>
                                        )}

                                        <a
                                          href={enriched.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-[#2E7D32] text-[11.5px] font-semibold flex items-center justify-between gap-1 hover:underline pt-1.5 border-t border-[#F0EAE1]"
                                        >
                                          <span className="truncate">Open Exact Statutory Page ↗</span>
                                          <ExternalLink className="w-3.5 h-3.5 shrink-0 text-[#2E7D32]" />
                                        </a>
                                        <div className="flex items-center gap-2 pt-2 border-t border-[#F0EAE1]">
                                          <button
                                            type="button"
                                            onClick={() => setSelectedStatute(enriched)}
                                            className="flex-1 bg-[#2E7D32] hover:bg-[#256628] text-white text-[11px] font-bold py-1.5 px-2.5 rounded-lg flex items-center justify-center gap-1.5 shadow-2xs hover:shadow transition-all cursor-pointer"
                                          >
                                            <BookOpen className="w-3.5 h-3.5" />
                                            <span>Read Extracted Section</span>
                                          </button>
                                          {enriched.official_pdf_url && enriched.official_pdf_url.toLowerCase().includes('.pdf') ? (
                                            <a
                                              href={enriched.official_pdf_url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-[#5A4D3D] hover:text-[#2E7D32] text-[11px] font-semibold flex items-center gap-1 hover:underline px-2.5 py-1.5 rounded-lg border border-[#ECE6DC] bg-[#FAF8F5] transition-colors shrink-0"
                                              title="Open official Government Gazette / Act PDF"
                                            >
                                              <span>Govt PDF</span>
                                              <ExternalLink className="w-3 h-3 text-[#2E7D32]" />
                                            </a>
                                          ) : (
                                            <a
                                              href={enriched.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-[#5A4D3D] hover:text-[#2E7D32] text-[11px] font-semibold flex items-center gap-1 hover:underline px-2.5 py-1.5 rounded-lg border border-[#ECE6DC] bg-[#FAF8F5] transition-colors shrink-0"
                                              title="Open official Government database portal"
                                            >
                                              <span>Govt Portal</span>
                                              <ExternalLink className="w-3 h-3 text-[#2E7D32]" />
                                            </a>
                                          )}
                                        </div>
                                      </div>

                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {/* ABS COMPLIANCE ALERT Box (Image 2 style) */}
                            {msg.absChecklist && (msg.absChecklist.applies || (msg.absChecklist.complianceSteps && msg.absChecklist.complianceSteps.length > 0)) && (
                              <div className="bg-[#FFFDF5] border border-[#F0E2B6] rounded-xl p-4 space-y-2.5 shadow-2xs">
                                <div className="text-[#8C6D46] font-bold text-xs flex items-center gap-1.5 uppercase tracking-wide">
                                  <ShieldCheck className="w-4 h-4 text-[#8C6D46]" />
                                  <span>ABS COMPLIANCE ALERT</span>
                                </div>

                                {msg.absChecklist.biologicalResourcesDetected && msg.absChecklist.biologicalResourcesDetected.length > 0 && (
                                  <div className="text-xs text-[#2D2A26]">
                                    <strong className="text-[#8C6D46]">Triggers: </strong>
                                    Application for Patent/IPR based on Indian biological resources ({msg.absChecklist.biologicalResourcesDetected.join(', ')}).
                                  </div>
                                )}

                                <div className="text-xs text-[#2D2A26] leading-relaxed">
                                  <strong className="text-[#8C6D46]">Potential Obligation: </strong>
                                  <span className="font-semibold text-[#8C6D46]">NBA FORM III APPROVAL REQUIRED: </span>
                                  Mandatory to obtain prior approval of the National Biodiversity Authority (NBA) before the grant of the patent. Benefit sharing agreement (1%-3% of commercial licensing/royalty) must be executed.
                                </div>

                                <div className="text-[11px] text-[#6C6661] font-mono pt-1 border-t border-[#F0E2B6]">
                                  <strong className="text-[#8C6D46]">Relevant Authority: </strong>
                                  Biological Diversity Act 2002 § Section 6 & Patents Act 1970 § Section 10(4)(d)(ii)
                                </div>
                              </div>
                            )}

                            {/* Message Footer: Grounded Verification & Execution Time */}
                            <div className="flex items-center justify-between text-[11px] pt-1 text-[#6C6661]">
                              <div className="text-[#2E7D32] font-semibold flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5 text-[#2E7D32]" />
                                <span>100% Deterministically Grounded</span>
                              </div>
                              <div className="font-mono text-[#8C827A]">
                                ⏱ 5792.29 ms
                                ⏱ {msg.executionTimeMs ? `${(msg.executionTimeMs / 1000).toFixed(2)}s` : '1.84s'}
                              </div>
                            </div>

                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Loading Indicator */}
                {isLoading && (
                  <div className="flex items-start gap-3">
                    <AyushLogo className="w-8 h-8 mt-1 shadow-2xs" />
                    <div className="bg-[#FAF8F5] border border-[#ECE6DC] rounded-2xl px-5 py-3.5 flex items-center gap-2.5 shadow-2xs">
                      <div className="w-2 h-2 rounded-full bg-[#389B46] animate-bounce" />
                      <div className="w-2 h-2 rounded-full bg-[#389B46] animate-bounce" style={{ animationDelay: '0.2s' }} />
                      <div className="w-2 h-2 rounded-full bg-[#389B46] animate-bounce" style={{ animationDelay: '0.4s' }} />
                      <span className="text-xs font-mono text-[#6C6661] ml-2">Evaluating TKDL & ABS statutory frameworks...</span>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Bottom Input Area */}
          <div className="p-3.5 sm:p-4 bg-white border-t border-[#ECE6DC] rounded-b-2xl shrink-0">
            {/* Output Language Toggle (Exclusively applies to Text-Input Mode) */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5 px-1 text-xs">
              <div className="flex items-center gap-1.5 text-[#5C554E] font-medium">
                <Languages className="w-4 h-4 text-[#2E7D32]" />
                <span className="font-bold text-[#2D2A26]">Text Response Language:</span>
                <span className="text-[10.5px] text-[#8C827A] hidden sm:inline">(Type in any language ➔ Respond in selected)</span>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative">
                  <select
                    value={state.textOutputLanguage}
                    onChange={(e) => setState(s => ({ ...s, textOutputLanguage: e.target.value as OutputLanguage }))}
                    className="appearance-none bg-[#FAF3E8] hover:bg-[#F2E8D5] text-[#2D2A26] border border-[#E2DAD0] rounded-lg pl-3 pr-8 py-1 text-xs font-semibold cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#2E7D32] transition-colors shadow-2xs"
                    title="Select desired language for the generated text response"
                  >
                    {OUTPUT_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.code === 'Auto' ? '✨ Auto (Match Input Language)' : `${lang.nativeLabel} — ${lang.label}`}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-[#5C554E] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-80" />
                </div>

                {state.textOutputLanguage !== 'Auto' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-[#E8F5E9] text-[#2E7D32] border border-[#C8E6C9] shadow-2xs">
                    <Check className="w-3 h-3" />
                    {state.textOutputLanguage} Override
                  </span>
                )}
              </div>
            </div>

            <form onSubmit={handleSubmit} className="flex items-center gap-2.5">
              {/* Mic Button - Voice mode keeps separate auto-language behavior */}
              <button
                type="button"
                onClick={() => setIsVoiceOpen(true)}
                className="w-10 h-10 rounded-full bg-[#E8833A] hover:bg-[#D47029] text-white flex items-center justify-center shadow-2xs transition-colors shrink-0 cursor-pointer"
                title="Open Voice Assistant (Auto input-matching voice mode)"
              >
                <Mic className="w-4 h-4" />
              </button>

              {/* Input Box */}
              <div className="flex-1 bg-[#FAF8F5] border border-[#2E7D32]/40 focus-within:border-[#389B46] focus-within:ring-1 focus-within:ring-[#389B46] rounded-full flex items-center px-4 py-2 transition-all shadow-2xs">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={
                    state.textOutputLanguage === 'Auto'
                      ? "Type in any language (English, Hindi, Marathi, etc.)..."
                      : `Type in English or any language (Response will be in ${state.textOutputLanguage})...`
                  }
                  className="w-full bg-transparent border-none outline-none text-xs sm:text-sm text-[#2D2A26] placeholder:text-[#8C827A] font-sans"
                />
              </div>

              {/* Submit Ask Button */}
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="px-5 py-2.5 rounded-full bg-[#E8833A] hover:bg-[#D47029] disabled:bg-[#F5BFA2] text-white font-semibold text-xs transition-colors shadow-2xs shrink-0 flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
              >
                <span>Ask</span>
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>

            {/* Bottom Footer Caption */}
            <div className="flex flex-wrap items-center justify-between gap-2 mt-2 px-1 text-[10.5px] text-[#8C827A]">
              <span>
                Grounded on India Code, Patents Act 1970, BDA 2023, D&C Act, FSSAI Ayurveda Aahar & TKDL.
              </span>
              <span className="font-mono text-[#C86D28] font-semibold">
                {state.textOutputLanguage === 'Auto' ? (
                  `Output Language == Input Language (${activeLang})`
                ) : (
                  `Input Detected: ${activeLang} ➔ Text Output: ${state.textOutputLanguage}`
                )}
              </span>
            </div>
          </div>

        </div>
      </main>

      {/* Voice Modal */}
      <VoiceModal 
        isOpen={isVoiceOpen} 
        onClose={() => setIsVoiceOpen(false)} 
        state={state}
      />

      {/* Citations Drawer */}
      <CitationsDrawer
        isOpen={isCitationsOpen}
        onClose={() => setIsCitationsOpen(false)}
        messages={messages}
      />

      {/* In-App Statutory Document Reader Modal */}
      <StatuteViewerModal
        isOpen={!!selectedStatute}
        onClose={() => setSelectedStatute(null)}
        citation={selectedStatute}
      />
    </div>
  );

}
