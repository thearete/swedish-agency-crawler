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

function extractEmails(html) {
  const results = new Set();

  // Extract from mailto: links in raw HTML
  const mailtoRe = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  let m;
  while ((m = mailtoRe.exec(html)) !== null) {
    results.add(m[1].toLowerCase());
  }

  // Extract from visible text
  const textRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  while ((m = textRe.exec(html)) !== null) {
    const email = m[0].toLowerCase();
    // Filter out false positives
    if (
      !email.endsWith('.png') && !email.endsWith('.jpg') && !email.endsWith('.gif') &&
      !email.endsWith('.css') && !email.endsWith('.js') && !email.endsWith('.svg') &&
      !email.includes('example.') && !email.includes('sentry.')
    ) {
      results.add(email);
    }
  }

  return [...results];
}

function extractPhones(html) {
  const results = new Set();

  // Extract from tel: links in raw HTML
  const telRe = /href=["']tel:([^"']+)["']/gi;
  let m;
  while ((m = telRe.exec(html)) !== null) {
    const phone = m[1].replace(/\s+/g, ' ').trim();
    if (phone.length >= 6) results.add(phone);
  }

  // Extract from visible text — Swedish phone patterns
  const patterns = [
    /(?:\+46|0)\d{1,4}[\s\-]?\d{2,3}[\s\-]?\d{2,3}[\s\-]?\d{0,4}/g,  // +46 or 0-prefixed
    /0\d{2,3}-\d{2,3}\s?\d{2,3}\s?\d{0,2}/g,                           // 0XX-XXX XX XX
    /0\d{3}-\d{5,8}/g,                                                   // 0XXX-XXXXXXX
  ];

  for (const re of patterns) {
    while ((m = re.exec(html)) !== null) {
      const phone = m[0].replace(/\s+/g, ' ').trim();
      if (phone.length >= 8) results.add(phone);
    }
  }

  return [...results];
}

// --------------- Step 1: Get Agency List ---------------

export async function fetchAgencyList(onProgress, signal) {
  const agencies = [];

  // Fetch page 1 to find total page count from pagination links
  onProgress('Fetching agency list page 1...');
  const firstHtml = await fetchPage(`${AGENCY_LIST_URL}?p=1`, signal);
  const firstDoc = parseHTML(firstHtml);

  // Determine total pages from pagination links like ?p=2, ?p=3, etc.
  let totalPages = 1;
  const paginationLinks = firstDoc.querySelectorAll('a[href*="?p="]');
  for (const link of paginationLinks) {
    const href = link.getAttribute('href');
    const match = href.match(/[?&]p=(\d+)/);
    if (match) {
      const pageNum = parseInt(match[1], 10);
      if (pageNum > totalPages) totalPages = pageNum;
    }
  }

  // Also check the text content — sometimes it says "337 hits" or similar
  const bodyText = firstDoc.body.textContent || '';
  const hitsMatch = bodyText.match(/(\d+)\s*(?:hits|träffar|results)/i);
  if (hitsMatch) {
    const totalHits = parseInt(hitsMatch[1], 10);
    const calculatedPages = Math.ceil(totalHits / 20);
    if (calculatedPages > totalPages) totalPages = calculatedPages;
  }

  // Safety: if we couldn't detect pagination, assume at least 17 pages (337/20)
  if (totalPages <= 1) totalPages = 17;

  onProgress(`Detected ${totalPages} pages of agencies.`);

  // Parse agencies from each page
  for (let page = 1; page <= totalPages; page++) {
    if (signal.aborted) break;

    let html;
    if (page === 1) {
      html = firstHtml; // Already fetched
    } else {
      onProgress(`Fetching agency list page ${page}/${totalPages}...`);
      try {
        html = await fetchPage(`${AGENCY_LIST_URL}?p=${page}`, signal);
      } catch (err) {
        onProgress(`Warning: failed to fetch page ${page}: ${err.message}`);
        continue;
      }
      await sleep(DELAY_MS);
    }

    const doc = page === 1 ? firstDoc : parseHTML(html);

    // Find agency links — they point to /government-agencies/SLUG/
    const links = doc.querySelectorAll('a[href*="/government-agencies/"]');

    for (const link of links) {
      const href = link.getAttribute('href');
      // Skip the main listing page itself, pagination links, and anchors
      if (!href || href === '/government-agencies/' || href.includes('?p=') || href === '#') continue;
      // Must look like an agency detail page
      if (!href.match(/\/government-agencies\/[a-z]/i)) continue;

      const name = link.textContent.trim();
      if (!name || name.length < 2) continue;

      const fullUrl = new URL(href, 'https://www.government.se').href;

      // Avoid duplicates
      if (!agencies.some(a => a.detailUrl === fullUrl)) {
        agencies.push({ name, detailUrl: fullUrl, website: null, switchboard: null, contacts: [] });
      }
    }
  }

  onProgress(`Found ${agencies.length} agencies across ${totalPages} pages.`);
  return agencies;
}

// --------------- Step 2: Resolve Agency Websites ---------------

export async function resolveAgencyWebsite(agency, signal) {
  try {
    const html = await fetchPage(agency.detailUrl, signal);
    const doc = parseHTML(html);

    // Look for external links to agency's own site
    const allLinks = doc.querySelectorAll('a[href]');
    for (const link of allLinks) {
      const href = link.getAttribute('href');
      if (!href) continue;

      if (
        href.startsWith('http') &&
        !href.includes('government.se') &&
        !href.includes('regeringen.se') &&
        !href.includes('twitter.com') &&
        !href.includes('facebook.com') &&
        !href.includes('linkedin.com') &&
        !href.includes('youtube.com') &&
        !href.includes('instagram.com')
      ) {
        try {
          const url = new URL(href);
          agency.website = url.origin;
          return;
        } catch { /* invalid URL, skip */ }
      }
    }

    // Fallback: look for "Website:" or "Webbplats:" text patterns
    const text = doc.body.textContent || '';
    const urlMatch = text.match(/(?:website|webbplats|webb)[:\s]*(https?:\/\/[^\s,]+)/i);
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
  'globalt engagemang',
  'global'
];

const CONTACT_PAGE_KEYWORDS = [
  'kontakt', 'contact', 'om oss', 'about us', 'about',
  'organisation', 'organization', 'ledning', 'management',
  'medarbetare', 'personal', 'staff'
];

// Common URL paths for contact/about pages on Swedish agency websites
const COMMON_PATHS = [
  '/kontakt',
  '/kontakta-oss',
  '/kontaktcenter',
  '/contact',
  '/contact-us',
  '/om-oss',
  '/om-oss/kontakt',
  '/om-oss/organisation',
  '/om-oss/ledning',
  '/about',
  '/about-us',
  '/en/contact',
  '/en/about',
  '/internationellt',
  '/internationellt-samarbete',
  '/international',
  '/international-cooperation',
  '/verksamhet/internationellt',
  '/var-verksamhet/internationellt',
  '/samarbeten',
  '/eu',
  '/eu-samarbete',
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
      try {
        const base = new URL(baseUrl);
        const target = new URL(fullUrl);
        if (target.hostname !== base.hostname) continue;
      } catch { continue; }

      // Check if link text or URL contains relevant keywords
      const allKeywords = [...INTL_KEYWORDS, ...CONTACT_PAGE_KEYWORDS];
      const urlLower = fullUrl.toLowerCase();
      const isRelevant = allKeywords.some(kw =>
        text.includes(kw) ||
        urlLower.includes(kw.replace(/\s+/g, '-')) ||
        urlLower.includes(kw.replace(/\s+/g, ''))
      );

      if (isRelevant) {
        pages.add(fullUrl);
      }
    }
  } catch { /* homepage fetch failed */ }

  return [...pages];
}

function extractContactInfo(doc, html, url) {
  const text = (doc.body.textContent || '').toLowerCase();
  const fullText = doc.body.textContent || '';

  // Check if this page is relevant to international cooperation
  const isIntlPage = INTL_KEYWORDS.some(kw => text.includes(kw));

  // Extract from both visible text AND raw HTML (for tel: and mailto: links)
  const emails = extractEmails(html);
  const phones = extractPhones(html);

  // Try to find person names near international keywords
  let contactPerson = '';
  for (const kw of INTL_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx !== -1) {
      const surrounding = fullText.substring(Math.max(0, idx - 300), idx + 500);
      // Look for names near titles/roles
      const namePatterns = [
        /(?:chef|ansvarig|samordnare|coordinator|director|head|handläggare|avdelningschef|enhetschef)[:\s,.]*([A-ZÅÄÖ][a-zåäö]+\s+[A-ZÅÄÖ][a-zåäö]+)/,
        /([A-ZÅÄÖ][a-zåäö]+\s+[A-ZÅÄÖ][a-zåäö]+)\s*[,\-]\s*(?:chef|ansvarig|samordnare|coordinator|director|head)/,
      ];
      for (const pattern of namePatterns) {
        const nameMatch = surrounding.match(pattern);
        if (nameMatch) {
          contactPerson = nameMatch[1];
          break;
        }
      }
      if (contactPerson) break;
    }
  }

  return { isIntlPage, contactPerson, emails, phones, sourceUrl: url };
}

// Extract the switchboard/operator number from a page
function extractSwitchboard(html) {
  const text = html.toLowerCase();

  // Look for "växel" (switchboard) near a phone number
  const vaxelPatterns = [
    /växel[:\s]*(?:<[^>]*>)*\s*([\d\s\-+()]{8,20})/i,
    /switchboard[:\s]*(?:<[^>]*>)*\s*([\d\s\-+()]{8,20})/i,
    /telefon[:\s]*(?:<[^>]*>)*\s*([\d\s\-+()]{8,20})/i,
    /tel[:\s]*(?:<[^>]*>)*\s*([\d\s\-+()]{8,20})/i,
  ];

  for (const re of vaxelPatterns) {
    const m = html.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }

  // Fallback: first tel: link
  const telMatch = html.match(/href=["']tel:([^"']+)["']/i);
  if (telMatch) return telMatch[1].replace(/\s+/g, ' ').trim();

  return null;
}

export async function findInternationalContacts(agency, onProgress, signal) {
  if (!agency.website) return;

  onProgress(`Searching ${agency.name}...`);

  try {
    // Find relevant pages linked from the homepage
    const pages = await findRelevantPages(agency.website, signal);
    await sleep(DELAY_MS);

    // Add common URL paths
    for (const path of COMMON_PATHS) {
      const url = agency.website + path;
      if (!pages.includes(url)) {
        pages.push(url);
      }
    }

    // Also try the homepage itself for switchboard number
    try {
      const homeHtml = await fetchPage(agency.website, signal);
      const switchboard = extractSwitchboard(homeHtml);
      if (switchboard) agency.switchboard = switchboard;

      // Also check homepage for emails
      const homeDoc = parseHTML(homeHtml);
      const info = extractContactInfo(homeDoc, homeHtml, agency.website);
      if (info.emails.length > 0 || info.phones.length > 0) {
        agency.contacts.push({
          person: info.contactPerson,
          emails: info.emails,
          phones: info.phones,
          sourceUrl: agency.website,
          isIntlPage: info.isIntlPage,
          type: 'homepage'
        });
      }
      await sleep(DELAY_MS);
    } catch { /* homepage failed */ }

    // Visit each relevant page
    for (const pageUrl of pages.slice(0, 15)) { // Limit to 15 pages per agency
      if (signal.aborted) break;

      try {
        const html = await fetchPage(pageUrl, signal);
        const doc = parseHTML(html);

        // Try to get switchboard from contact pages
        if (!agency.switchboard) {
          const switchboard = extractSwitchboard(html);
          if (switchboard) agency.switchboard = switchboard;
        }

        const info = extractContactInfo(doc, html, pageUrl);

        if (info.emails.length > 0 || info.phones.length > 0 || info.contactPerson) {
          agency.contacts.push({
            person: info.contactPerson,
            emails: info.emails,
            phones: info.phones,
            sourceUrl: pageUrl,
            isIntlPage: info.isIntlPage,
            type: info.isIntlPage ? 'international' : 'contact'
          });
        }

        await sleep(DELAY_MS);
      } catch { /* page not found or error, continue */ }
    }

    // Deduplicate and prioritize contacts
    if (agency.contacts.length > 0) {
      // Prioritize: international pages first, then contact pages, then homepage
      agency.contacts.sort((a, b) => {
        if (a.isIntlPage && !b.isIntlPage) return -1;
        if (!a.isIntlPage && b.isIntlPage) return 1;
        if (a.type === 'contact' && b.type === 'homepage') return -1;
        if (a.type === 'homepage' && b.type === 'contact') return 1;
        return 0;
      });
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
  const rows = [['Agency', 'Website', 'Switchboard', 'Contact Person', 'Email', 'Phone', 'Page Type', 'Source URL']];

  for (const agency of agencies) {
    if (agency.contacts.length === 0) {
      rows.push([agency.name, agency.website || '', agency.switchboard || '', '', '', '', '', '']);
    } else {
      for (const contact of agency.contacts) {
        rows.push([
          agency.name,
          agency.website || '',
          agency.switchboard || '',
          contact.person || '',
          contact.emails.join('; '),
          contact.phones.join('; '),
          contact.type || '',
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
