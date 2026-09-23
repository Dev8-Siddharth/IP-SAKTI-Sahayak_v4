/**
 * Guardrail Utility for IP-SAKTI Sahayak Regulatory Intelligence & Prior-Art Portal.
 * Enforces mandatory domain boundaries across the application:
 * Only queries related to Ayurveda, Intellectual Property (IP), or Indian Regulatory Standards are permitted.
 */

// Explicitly blocked out-of-scope topics & patterns
const OUT_OF_SCOPE_PATTERNS = [
  // Software / Code Development
  /\b(javascript|typescript|python|c\+\+|java|react|angular|vue|html|css|sql|database|docker|git|github|coding|programmer|npm|node\.js|frontend|backend|algorithm)\b/i,
  // Sports & Entertainment
  /\b(cricket|football|soccer|basketball|baseball|tennis|ipl|nba|nfl|fifa|olympics|sports? score|who won)\b/i,
  /\b(movie|cinema|actor|actress|celebrity|hollywood|bollywood|netflix|song|music album|tv show)\b/i,
  // Financial / Crypto / Trading
  /\b(bitcoin|crypto|cryptocurrency|ethereum|stock market|forex|trading strategy|invest in stocks)\b/i,
  // Weather & Non-Ayurvedic Recipes
  /\b(weather forecast|rain tomorrow|temperature today|recipe for (pizza|burger|pasta|cake|lasagna|french fries))\b/i,
  // General Trivia & Unrelated Academics
  /\b(capital of|president of|prime minister of|quantum physics|calculus|trigonometry|algebra|nasa|spacex)\b/i,
];

// In-scope keywords (Ayurveda, IP, Indian regulatory standards, or Portal meta-queries)
const IN_SCOPE_KEYWORDS = [
  // Ayurveda, Traditional Knowledge, Herbs & Formulations
  'ayurveda', 'ayurvedic', 'ayush', 'siddha', 'unani', 'homoeopathy', 'homeopathy',
  'tkdl', 'traditional knowledge', 'prior art', 'prior-art', 'priorart',
  'charaka', 'sushruta', 'ashtanga', 'samhita', 'rasashastra', 'bhasma', 'churna', 'taila',
  'kwatha', 'lehya', 'asava', 'arishta', 'vati', 'gutika', 'kashayam', 'leham', 'dravya',
  'herb', 'herbal', 'botanical', 'plant', 'extract', 'phytochemical', 'formulation', 'preparation', 'composition',
  'turmeric', 'curcumin', 'neem', 'ashwagandha', 'tulsi', 'triphala', 'brahmi', 'amla', 'guggulu', 'shatavari', 'giloy', 'haldi',
  'ginger', 'clove', 'cardamom', 'piperine', 'terminalia', 'withania', 'azadirachta', 'ocimum',
  'pharmacopoeia', 'api', 'afi', 'pcim', 'pcimvh', 'first schedule', 'classical formulation', 'proprietary medicine',

  // Intellectual Property (IP)
  'ip', 'intellectual property', 'patent', 'patents', 'patentability', 'patentable', 'patentee',
  'section 3(p)', 'section 3', 'section 3p', 'novelty', 'inventive step', 'non-obviousness', 'industrial application',
  'trademark', 'trade mark', 'trade secret', 'geographical indication', 'gi tag', 'gi registry', 'design', 'copyright', 'inpass', 'ipo', 'patent office',
  'infringement', 'exclusive rights', 'licensing', 'compulsory license', 'wipo', 'trips',

  // Indian Regulatory Standards & Statutory Authorities
  'india code', 'indiacode', 'ip india', 'ipindia', 'cdsco', 'fssai', 'ayurveda-aahar', 'ayurveda aahar',
  'biological diversity', 'biodiversity', 'nba', 'national biodiversity authority', 'sbb', 'state biodiversity board',
  'abs', 'access and benefit sharing', 'abs clearance', 'form i', 'form iii', 'section 7', 'section 40', 'ntc', 'normally traded commodities',
  'drugs and cosmetics', 'drugs & cosmetics', 'rule 158b', 'rule 158', 'schedule t', 'gmp', 'good manufacturing practice',
  'compliance', 'regulatory', 'statute', 'statutory', 'act', 'jurisdiction', 'legal', 'law', 'gazette', 'guidelines', 'standards',
  'आयुष', 'आयुर्वेद', 'पेटेंट',

  // Portal meta & greeting queries
  'hi', 'hello', 'hey', 'greetings', 'namaste', 'help', 'guide', 'capabilities', 'who are you', 'what can you do', 'portal'
];

// Conversational follow-up & inquiry patterns
const CONVERSATIONAL_FOLLOW_UP_KEYWORDS = [
  'why', 'how', 'what', 'when', 'who', 'which', 'where',
  'explain', 'elaborate', 'details', 'tell me more', 'more information',
  'fee', 'fees', 'cost', 'timeline', 'time', 'process', 'procedure', 'steps',
  'documents', 'requirement', 'requirements', 'exempt', 'exemption', 'penalty',
  'eligibility', 'eligible', 'guidelines', 'rules', 'difference', 'compare',
  'example', 'sample', 'can you', 'could you', 'what if', 'next', 'first',
  'second', 'third', 'point', 'clarify', 'summary', 'summarize'
];

/**
 * Checks if a topic/query is out of scope (i.e. strictly NOT related to Ayurveda, IP, or Indian regulatory standards).
 *
 * @param query The user prompt or topic string
 * @param hasConversationHistory Whether this is a continuation of an ongoing chat
 * @returns boolean `true` if out of scope, `false` if in scope.
 */
export function isContentOutOfScope(query: string, hasConversationHistory: boolean = false): boolean {
  if (!query || !query.trim()) {
    return false;
  }

  const normalized = query.trim().toLowerCase();

  // Explicit forbidden topics (cricket, sports, movies, coding, crypto, etc.)
  const matchesExplicitOutOfScope = OUT_OF_SCOPE_PATTERNS.some(pattern => pattern.test(normalized));

  // If in an ongoing conversation, allow natural follow-up questions unless user specifically asks about banned topics
  if (hasConversationHistory) {
    if (matchesExplicitOutOfScope) {
      // Check if user is connecting it to IP (e.g. "patent for a sports device" or "software patent")
      const hasIpMention = ['patent', 'trademark', 'copyright', 'ip', 'protection', 'infringement', 'claim'].some(k => normalized.includes(k));
      return !hasIpMention;
    }
    // All conversational follow-ups in an existing thread are permitted!
    return false;
  }

  // Check in-scope domain terms
  const hasInScopeKeyword = IN_SCOPE_KEYWORDS.some(kw => normalized.includes(kw));
  if (hasInScopeKeyword) {
    return false;
  }

  // Check conversational inquiry terms
  const hasInquiryIntent = CONVERSATIONAL_FOLLOW_UP_KEYWORDS.some(kw => normalized.includes(kw));

  // If matches explicit out-of-scope without any IP/regulatory relevance
  if (matchesExplicitOutOfScope) {
    return true;
  }

  // If it's a general question or conversational inquiry, allow it to proceed to the RAG pipeline
  if (hasInquiryIntent) {
    return false;
  }

  // Only reject if it has zero domain terms, zero inquiry intent, and matches no patterns
  return false;
}
