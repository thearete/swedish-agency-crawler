/**
 * Swedish Government Agency Crawler
 *
 * 3-step crawl:
 * 1. Fetch the list of all agencies from government.se
 * 2. Resolve each agency's own website
 * 3. Search each agency site for international cooperation contacts
 */

const AGENCY_LIST_URL = 'https://www.government.se/government-agencies/';
const DELAY_MS = 1000; // 1 second between requests to be polite

// --------------- Helpers ---------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseHTML(html) {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}

async function fetchPage(url, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return await resp.text();
}

function extractEmails(text) {
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(re) || [];
  // Filter out common false positives
  return [...new Set(matches)].filter(e =>
    !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.gif') &&
    !e.endsWith('.css') && !e.endsWith('.js')
  );
}

function extractPhones(text) {
  // Swedish phone patterns: +46, 0XX-XXX XX XX, etc.
  const re = /(?:\+46|0)\s*[\d\s\-()]{6,15}/g;
  const matches = text.match(re) || [];
  return [...new Set(matches.map(p => p.trim()))];
}

// --------------- Step 1: Get Agency List ---------------

export async function fetchAgencyList(onProgress, signal) {
  const agencies = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${AGENCY_LIST_URL}?p=${page}#result`;
    onProgress(`Fetching agency list page ${page}...`);

    const html = await fetchPage(url, signal);
    const doc = parseHTML(html);

    // Find agency links — they point to /government-agencies/SLUG/
    const links = doc.querySelectorAll('a[href*="/government-agencies/"]');
    let foundOnPage = 0;

    for (const link of links) {
      const href = link.getAttribute('href');
      // Skip the main listing page itself and pagination links
      if (href === '/government-agencies/' || href.includes('?p=')) continue;

      const name = link.textContent.trim();
      if (!name) continue;

      const fullUrl = new URL(href, 'https://www.government.se').href;

      // Avoid duplicates
      if (!agencies.some(a => a.detailUrl === fullUrl)) {
        agencies.push({ name, detailUrl: fullUrl, website: null, contacts: [] });
        foundOnPage++;
      }
    }

    // If no new agencies found on this page, we've reached the end
    if (foundOnPage === 0) {
      hasMore = false;
    } else {
      page++;
      await sleep(DELAY_MS);
    }
  }

  onProgress(`Found ${agencies.length} agencies.`);
  return agencies;
}

// --------------- Step 2: Resolve Agency Websites ---------------

export async function resolveAgencyWebsite(agency, signal) {
  try {
    const html = await fetchPage(agency.detailUrl, signal);
    const doc = parseHTML(html);

    // Look for external links to .se domains (the agency's own site)
    const allLinks = doc.querySelectorAll('a[href]');
    for (const link of allLinks) {
      const href = link.getAttribute('href');
      if (!href) continue;

      // Agency websites are typically linked as external URLs ending in .se
      // Skip government.se links
      if (
        href.startsWith('http') &&
        !href.includes('government.se') &&
        !href.includes('regeringen.se') &&
        (href.includes('.se') || href.includes('.nu') || href.includes('.org'))
      ) {
        try {
          const url = new URL(href);
          agency.website = url.origin;
          return;
        } catch { /* invalid URL, skip */ }
      }
    }

    // Fallback: look for "Website:" or "Webbplats:" text patterns
    const text = doc.body.innerText || doc.body.textContent;
    const urlMatch = text.match(/(?:website|webbplats)[:\s]*(https?:\/\/[^\s]+)/i);
    if (urlMatch) {
      try {
        const url = new URL(urlMatch[1]);
        agency.website = url.origin;
      } catch { /* invalid URL */ }
    }
  } catch (err) {
    agency.websiteError = err.message;
  }
}

// --------------- Step 3: Find International Cooperation Contacts ---------------

const INTL_KEYWORDS = [
  'internationellt samarbete',
  'international cooperation',
  'internationell',
  'international',
  'eu-samarbete',
  'eu cooperation',
  'globalt',
  'global'
];

const CONTACT_PAGE_KEYWORDS = [
  'kontakt', 'contact', 'om oss', 'about us', 'organisation', 'organization'
];

async function findRelevantPages(baseUrl, signal) {
  const pages = new Set();

  try {
    const html = await fetchPage(baseUrl, signal);
    const doc = parseHTML(html);
    const links = doc.querySelectorAll('a[href]');

    for (const link of links) {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').toLowerCase();

      if (!href) continue;

      let fullUrl;
      try {
        fullUrl = new URL(href, baseUrl).href;
      } catch { continue; }

      // Only follow links on the same domain
      if (!fullUrl.startsWith(baseUrl)) continue;

      // Check if link text or URL contains relevant keywords
      const allKeywords = [...INTL_KEYWORDS, ...CONTACT_PAGE_KEYWORDS];
      const isRelevant = allKeywords.some(kw =>
        text.includes(kw) || fullUrl.toLowerCase().includes(kw.replace(/\s+/g, '-'))
      );

      if (isRelevant) {
        pages.add(fullUrl);
      }
    }
  } catch { /* homepage fetch failed */ }

  return [...pages];
}

function extractContactInfo(doc, url) {
  const text = (doc.body.innerText || doc.body.textContent || '').toLowerCase();
  const fullText = doc.body.innerText || doc.body.textContent || '';

  // Check if this page is relevant to international cooperation
  const isIntlPage = INTL_KEYWORDS.some(kw => text.includes(kw));

  const emails = extractEmails(fullText);
  const phones = extractPhones(fullText);

  // Try to find person names near international keywords
  let contactPerson = '';
  for (const kw of INTL_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx !== -1) {
      // Grab surrounding text to look for names
      const surrounding = fullText.substring(Math.max(0, idx - 200), idx + 300);
      // Look for common Swedish name patterns near the keyword
      const nameMatch = surrounding.match(/(?:chef|ansvarig|samordnare|coordinator|director|head)[:\s]*([A-ZÅÄÖ][a-zåäö]+\s+[A-ZÅÄÖ][a-zåäö]+)/);
      if (nameMatch) {
        contactPerson = nameMatch[1];
        break;
      }
    }
  }

  return {
    isIntlPage,
    contactPerson,
    emails,
    phones,
    sourceUrl: url
  };
}

export async function findInternationalContacts(agency, onProgress, signal) {
  if (!agency.website) return;

  onProgress(`Searching ${agency.name}...`);

  try {
    // Find relevant pages on the agency's site
    const pages = await findRelevantPages(agency.website, signal);
    await sleep(DELAY_MS);

    // Also check common URL patterns directly
    const commonPaths = [
      '/kontakt', '/contact', '/om-oss', '/about',
      '/internationellt', '/international',
      '/internationellt-samarbete', '/international-cooperation'
    ];

    for (const path of commonPaths) {
      const url = agency.website + path;
      if (!pages.includes(url)) {
        pages.push(url);
      }
    }

    // Visit each relevant page
    for (const pageUrl of pages.slice(0, 10)) { // Limit to 10 pages per agency
      try {
        const html = await fetchPage(pageUrl, signal);
        const doc = parseHTML(html);
        const info = extractContactInfo(doc, pageUrl);

        if (info.emails.length > 0 || info.phones.length > 0 || info.contactPerson) {
          agency.contacts.push({
            person: info.contactPerson,
            emails: info.emails,
            phones: info.phones,
            sourceUrl: pageUrl,
            isIntlPage: info.isIntlPage
          });
        }

        await sleep(DELAY_MS);
      } catch { /* page not found or error, continue */ }
    }

    // Deduplicate contacts
    if (agency.contacts.length > 0) {
      // Prioritize contacts from international-related pages
      agency.contacts.sort((a, b) => (b.isIntlPage ? 1 : 0) - (a.isIntlPage ? 1 : 0));
    }
  } catch (err) {
    agency.crawlError = err.message;
  }
}

// --------------- Storage ---------------

export async function saveResults(agencies) {
  await chrome.storage.local.set({ agencies, lastUpdated: new Date().toISOString() });
}

export async function loadResults() {
  const data = await chrome.storage.local.get(['agencies', 'lastUpdated']);
  return data;
}

export async function clearResults() {
  await chrome.storage.local.remove(['agencies', 'lastUpdated']);
}

// --------------- CSV Export ---------------

export function exportCSV(agencies) {
  const rows = [['Agency', 'Website', 'Contact Person', 'Email', 'Phone', 'Source URL']];

  for (const agency of agencies) {
    if (agency.contacts.length === 0) {
      rows.push([agency.name, agency.website || '', '', '', '', '']);
    } else {
      for (const contact of agency.contacts) {
        rows.push([
          agency.name,
          agency.website || '',
          contact.person || '',
          contact.emails.join('; '),
          contact.phones.join('; '),
          contact.sourceUrl || ''
        ]);
      }
    }
  }

  const csv = rows.map(row =>
    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  const BOM = '\uFEFF'; // For proper Swedish character encoding in Excel
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `swedish-agencies-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();

  URL.revokeObjectURL(url);
}
