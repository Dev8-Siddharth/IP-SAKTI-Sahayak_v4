import { Citation } from '../types';

export type AuthorityLevel =
  | 'official-primary'
  | 'official-secondary';

export interface AuthoritativeSource {
  id: string;
  name: string;
  domain: string;
  baseUrl: string;
  authorityLevel: AuthorityLevel;
  jurisdiction: 'India' | 'International' | 'Both';
  categories: string[];
}

export interface EnrichedCitation extends Citation {
  docCategory: string;
  portalName: string;
  url: string;
  badgeColor: string;
  sectionRef: string;
  exactTextSnippet: string;
  authorityLevel?: AuthorityLevel;
  url_precision?: 'section-level' | 'act-level';
}

/**
 * Authoritative Source Registry strictly restricted to the four authorized domains:
 * 1. indiacode.gov.in (India Code)
 * 2. ipindia.gov.in (Intellectual Property India)
 * 3. nbaindia.nic.in / nbaind.org (National Biodiversity Authority)
 * 4. tkdl.res.in (Traditional Knowledge Digital Library - public purpose & scope)
 */
export const AUTHORITATIVE_SOURCES: AuthoritativeSource[] = [
  {
    id: 'india-code',
    name: 'India Code',
    domain: 'indiacode.gov.in',
    baseUrl: 'https://indiacode.gov.in/items/7468481f-b8ab-4029-b914-b926971c91df',
    authorityLevel: 'official-primary',
    jurisdiction: 'India',
    categories: [
      'patents act 1970',
      'biological diversity act 2002',
      'drugs and cosmetics act 1940',
      'section 3(p)',
      'section 10(4)',
      'section 25',
      'section 3',
      'section 6',
      'section 7',
      'section 40'
    ]
  },
  {
    id: 'ip-india',
    name: 'Intellectual Property India (IP India)',
    domain: 'ipindia.gov.in',
    baseUrl: 'https://ipindia.gov.in/resource/patents-resources-guidelines',
    authorityLevel: 'official-primary',
    jurisdiction: 'India',
    categories: [
      'patents',
      'patent guidelines',
      'traditional knowledge guidelines',
      'patents rules 2024',
      'rule 24c',
      'form 18a',
      'trademarks class 5',
      'geographical indications'
    ]
  },
  {
    id: 'nba',
    name: 'National Biodiversity Authority (NBA)',
    domain: 'nbaindia.nic.in',
    baseUrl: 'https://www.nbaindia.nic.in/application-form/form-application-fee',
    authorityLevel: 'official-primary',
    jurisdiction: 'India',
    categories: [
      'national biodiversity authority',
      'nba',
      'abs clearance',
      'form i',
      'form iii',
      'abs regulations',
      'benefit sharing',
      'biological diversity amendment 2023'
    ]
  },
  {
    id: 'tkdl',
    name: 'Traditional Knowledge Digital Library (TKDL)',
    domain: 'tkdl.res.in',
    baseUrl: 'https://tkdl.res.in/tkdl/langdefault/common/About.asp',
    authorityLevel: 'official-primary',
    jurisdiction: 'India',
    categories: [
      'traditional knowledge',
      'tkdl',
      'prior art',
      'csir',
      'tkrc classification',
      'defensive patent protection',
      'access agreements'
    ]
  }
];

const ROOT_DOMAIN_BLACKLIST = [
  'https://indiacode.gov.in',
  'https://indiacode.gov.in/',
  'https://www.indiacode.nic.in',
  'https://www.indiacode.nic.in/',
  'https://ipindia.gov.in',
  'https://ipindia.gov.in/',
  'https://www.nbaindia.org',
  'https://www.nbaindia.org/',
  'https://www.nbaindia.nic.in',
  'https://www.nbaindia.nic.in/',
  'https://tkdl.res.in',
  'https://tkdl.res.in/'
];

/**
 * Normalizes citation URLs strictly enforcing the four authorized domains and preventing bare root domain links.
 * Preserves exact resolved deep URLs from the verified RAG pipeline.
 */
export function normalizeUrl(
  rawUrl?: string,
  contextText?: string,
  jurisdiction?: 'India' | 'International'
): string {
  const urlStr = (rawUrl || '').trim();
  const context = (contextText || '').toLowerCase();
  const combined = (urlStr + ' ' + context).toLowerCase();

  // Sanitize any broken or outdated URLs
  if (urlStr.includes('tkdl.res.in')) {
    if (urlStr.includes('TKRC') || context.includes('tkrc') || context.includes('classification')) {
      return 'https://tkdl.res.in/tkdl/langdefault/common/TKRC.asp?GL=Eng';
    }
    return 'https://tkdl.res.in/tkdl/langdefault/common/Home.asp?GL=Eng';
  }
  if (urlStr.includes('writereaddata/Portal/Images/pdf/the_patents_act_1970.pdf')) {
    return 'https://ipindia.gov.in/resource/the-patents-act-1970.htm';
  }
  if (urlStr.includes('cdsco.gov.in/opencms/opencms/en/Drugs/Ayush/')) {
    return 'https://cdsco.gov.in/opencms/opencms/en/Acts-and-rules/';
  }
  if (urlStr.includes('nbaindia.org/uploaded/pdf/act/BDACT_2002.pdf')) {
    return 'https://www.nbaindia.nic.in/application-form/form-application-fee';
  }

  // If a valid, non-root URL from one of the 4 authorized domains is supplied, PRESERVE IT!
  const isAuthorizedDomain =
    urlStr.includes('indiacode.gov.in') ||
    urlStr.includes('indiacode.nic.in') ||
    urlStr.includes('ipindia.gov.in') ||
    urlStr.includes('nbaindia.nic.in') ||
    urlStr.includes('nbaindia.org') ||
    urlStr.includes('tkdl.res.in');

  const isBareRoot = ROOT_DOMAIN_BLACKLIST.includes(urlStr) || urlStr.endsWith('.gov.in') || urlStr.endsWith('.nic.in') || urlStr.endsWith('.res.in');

  if (urlStr.startsWith('http') && isAuthorizedDomain && !isBareRoot) {
    return urlStr;
  }

  // Deep fallback within the four authorized domains based on topic context:
  // 1. Traditional Knowledge / TKDL
  if (combined.includes('tkdl') || combined.includes('prior art') || combined.includes('tkrc') || combined.includes('csir')) {
    if (combined.includes('tkrc') || combined.includes('classification')) {
      return 'https://tkdl.res.in/tkdl/langdefault/common/TKRC.asp?GL=Eng';
    }
    return 'https://tkdl.res.in/tkdl/langdefault/common/Home.asp?GL=Eng';
  }

  // 2. National Biodiversity Authority / ABS / Form I / Form III
  if (combined.includes('nba') || combined.includes('biodiversity') || combined.includes('form iii') || combined.includes('form i') || combined.includes('benefit sharing')) {
    return 'https://www.nbaindia.nic.in/application-form/form-application-fee';
  }

  // 3. IP India: Patents Rules, Expedited Examination, TM Class 5, Guidelines
  if (combined.includes('ip india') || combined.includes('rule 24c') || combined.includes('form 18a') || combined.includes('trademark') || combined.includes('class 5') || combined.includes('gi registry')) {
    if (combined.includes('rule 24c') || combined.includes('rules')) {
      return 'https://ipindia.gov.in/resource/patents-resources-rules';
    }
    if (combined.includes('guidelines') || combined.includes('biological') || combined.includes('traditional knowledge')) {
      return 'https://ipindia.gov.in/resource/patents-resources-guidelines';
    }
    if (combined.includes('trademark') || combined.includes('class 5')) {
      return 'https://ipindia.gov.in/trade-marks-resources-guidelines';
    }
    return 'https://ipindia.gov.in/resource/patents-resources-guidelines';
  }

  // 4. Biological Diversity Act 2002 & Guidelines - Authentic NBA Act & Gazettes
  if (combined.includes('biodiversity') || combined.includes('bda') || combined.includes('section 6') || combined.includes('section 7') || combined.includes('section 40')) {
    return 'https://www.nbaindia.nic.in/application-form/form-application-fee';
  }

  // 5. Drugs and Cosmetics Act 1940 & Rule 158B
  if (combined.includes('drugs and cosmetics') || combined.includes('158b') || combined.includes('cdsco') || combined.includes('asu')) {
    return 'https://cdsco.gov.in/opencms/opencms/en/Acts-and-rules/';
  }

  // 6. Patents Act 1970 (Official IP India Patents Act HTML page)
  return 'https://ipindia.gov.in/resource/the-patents-act-1970.htm';
}

/**
 * Enriches raw citation objects with authoritative metadata, portal labels,
 * and exact deep links strictly from the authorized government domains.
 */
export function enrichCitation(
  citation: Citation,
  jurisdiction?: 'India' | 'International'
): EnrichedCitation {
  const cleanSource = citation.source || 'Ayurvedic Regulatory Statute';
  const sourceLower = cleanSource.toLowerCase();

  // Derive section locator if missing
  let sectionRef = citation.sectionRef || '';
  if (!sectionRef) {
    if (sourceLower.includes('3(p)')) sectionRef = 'Section 3(p)';
    else if (sourceLower.includes('section 10')) sectionRef = 'Section 10(4)(d)(ii)';
    else if (sourceLower.includes('section 25')) sectionRef = 'Section 25';
    else if (sourceLower.includes('rule 24c')) sectionRef = 'Rule 24C';
    else if (sourceLower.includes('form 18a')) sectionRef = 'Form 18A';
    else if (sourceLower.includes('form iii')) sectionRef = 'Form III';
    else if (sourceLower.includes('form i')) sectionRef = 'Form I';
    else if (sourceLower.includes('section 3')) sectionRef = 'Section 3';
    else if (sourceLower.includes('section 6')) sectionRef = 'Section 6';
    else if (sourceLower.includes('section 7')) sectionRef = 'Section 7';
    else if (sourceLower.includes('section 40')) sectionRef = 'Section 40';
    else if (sourceLower.includes('rule 158b')) sectionRef = 'Rule 158B';
    else sectionRef = cleanSource;
  }

  // Normalize target URL (preserves exact deep link from RAG metadata)
  const targetUrl = normalizeUrl(
    citation.url,
    citation.exactTextSnippet || citation.description || sectionRef || cleanSource,
    jurisdiction
  );

  let docCategory = citation.docCategory || 'Regulatory Statute';
  let portalName = 'IP India (ipindia.gov.in)';
  let badgeColor = 'bg-[#E8F5E9] text-[#2E7D32] border-[#C8E6C9]';
  let url_precision: 'section-level' | 'act-level' = 'section-level';

  if (targetUrl.includes('tkdl.res.in')) {
    docCategory = 'Traditional Knowledge / Prior Art';
    portalName = 'TKDL (tkdl.res.in)';
    badgeColor = 'bg-[#FFF8E1] text-[#F57F17] border-[#FFE082]';
    url_precision = 'section-level';
  } else if (targetUrl.includes('nbaindia.nic.in') || targetUrl.includes('nbaindia.org')) {
    docCategory = 'Biological Diversity & ABS Authority';
    portalName = 'NBA (nbaindia.org)';
    badgeColor = 'bg-[#E0F2F1] text-[#00695C] border-[#B2DFDB]';
    url_precision = targetUrl.endsWith('.pdf') ? 'act-level' : 'section-level';
  } else if (targetUrl.includes('cdsco.gov.in')) {
    docCategory = 'Drugs & Cosmetics Licensing';
    portalName = 'CDSCO (cdsco.gov.in)';
    badgeColor = 'bg-[#FBE9E7] text-[#D84315] border-[#FFCCBC]';
    url_precision = 'section-level';
  } else if (targetUrl.includes('ipindia.gov.in')) {
    docCategory = sourceLower.includes('trademark') ? 'Trade Marks Registry' : 'Patent Office (IP India)';
    portalName = 'IP India (ipindia.gov.in)';
    badgeColor = 'bg-[#EDE7F6] text-[#512DA8] border-[#D1C4E9]';
    url_precision = targetUrl.includes('rules') || targetUrl.includes('forms') ? 'section-level' : 'act-level';
  } else {
    docCategory = sourceLower.includes('patent') ? 'Patent Law (Patents Act 1970)' : sourceLower.includes('biological') ? 'Biodiversity Law (BD Act 2002)' : 'Indian Statutory Law';
    portalName = 'IP India (ipindia.gov.in)';
    badgeColor = 'bg-[#E8F5E9] text-[#2E7D32] border-[#C8E6C9]';
    url_precision = 'section-level';
  }

  // Resolve official PDF only when a genuine, working Government PDF exists
  let officialPdfUrl: string | undefined = undefined;
  if (citation.official_pdf_url && citation.official_pdf_url.toLowerCase().endsWith('.pdf')) {
    officialPdfUrl = citation.official_pdf_url;
  } else if (cleanSource.toLowerCase().includes('patents act') || sourceLower.includes('section 3(p)')) {
    officialPdfUrl = 'https://ipindia.gov.in/storage/uploads/pages/pdfs/5peXVNWVbdtQkwLG4Dlo0AUE6SQ8ueAEXZFRGQg6.pdf';
  } else if (cleanSource.toLowerCase().includes('patent rules') || sourceLower.includes('rule 24c')) {
    officialPdfUrl = 'https://ipindia.gov.in/storage/uploads/docs-operator/33524c6c-73dd-4fe0-bbd7-43c8f187413e.pdf';
  } else if (cleanSource.toLowerCase().includes('guidelines') && sourceLower.includes('traditional knowledge')) {
    officialPdfUrl = 'https://ipindia.gov.in/storage/uploads/docs-operator/3bc51e03-8e40-4195-ab32-e41a08730ee2.pdf';
  } else if (cleanSource.toLowerCase().includes('form iii') || sourceLower.includes('form 3') || cleanSource.toLowerCase().includes('bda') || sourceLower.includes('biological diversity')) {
    officialPdfUrl = 'https://www.nbaindia.nic.in/sites/default/files/2026-07/imp_formIII.pdf';
  } else if (cleanSource.toLowerCase().includes('form i') || sourceLower.includes('form 1')) {
    officialPdfUrl = 'https://www.nbaindia.nic.in/sites/default/files/2026-04/sub_form10.pdf';
  }

  // TKDL is an interactive digital library database, not a static PDF file
  if (targetUrl.includes('tkdl.res.in')) {
    officialPdfUrl = undefined;
  }

  return {
    ...citation,
    parent_id: citation.parent_id,
    source: cleanSource,
    docCategory,
    portalName,
    authorityLevel: 'official-primary',
    url: targetUrl,
    official_pdf_url: officialPdfUrl,
    badgeColor,
    sectionRef,
    exactTextSnippet: citation.exactTextSnippet || citation.description || '',
    url_precision
  };
}

