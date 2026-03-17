import {
  fetchAgencyList,
  resolveAgencyWebsite,
  findInternationalContacts,
  saveResults,
  loadResults,
  clearResults,
  exportCSV
} from './crawler.js';

// --------------- DOM Elements ---------------

const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const exportBtn = document.getElementById('exportBtn');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const statusLog = document.getElementById('statusLog');
const resultsSection = document.getElementById('resultsSection');
const resultsBody = document.getElementById('resultsBody');
const resultCount = document.getElementById('resultCount');

// --------------- State ---------------

let agencies = [];
let abortController = null;
let isPaused = false;
let crawlPhase = 'idle'; // idle | list | websites | contacts | done

// --------------- Logging ---------------

function log(message) {
  const p = document.createElement('p');
  p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  statusLog.prepend(p);
  // Keep only last 50 log entries
  while (statusLog.children.length > 50) {
    statusLog.removeChild(statusLog.lastChild);
  }
}

function updateProgress(current, total, label) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressText.textContent = `${label}: ${current}/${total} (${pct}%)`;
}

// --------------- Render Results ---------------

function renderResults() {
  resultsBody.innerHTML = '';
  let count = 0;

  for (const agency of agencies) {
    if (agency.contacts.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(agency.name)}</td>
        <td><em>No contact found</em></td>
        <td></td>
        <td></td>
        <td>${agency.website ? `<a href="${esc(agency.website)}" target="_blank">website</a>` : ''}</td>
      `;
      resultsBody.appendChild(tr);
    } else {
      for (const contact of agency.contacts) {
        count++;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${esc(agency.name)}</td>
          <td>${esc(contact.person || (contact.isIntlPage ? 'International page' : 'Contact page'))}</td>
          <td>${contact.emails.map(e => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('<br>')}</td>
          <td>${contact.phones.map(p => esc(p)).join('<br>')}</td>
          <td><a href="${esc(contact.sourceUrl)}" target="_blank">source</a></td>
        `;
        resultsBody.appendChild(tr);
      }
    }
  }

  resultCount.textContent = count;
  resultsSection.classList.remove('hidden');
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// --------------- Crawl Logic ---------------

async function startCrawl() {
  abortController = new AbortController();
  isPaused = false;

  startBtn.disabled = true;
  pauseBtn.disabled = false;
  exportBtn.disabled = true;
  progressSection.classList.remove('hidden');

  const signal = abortController.signal;

  try {
    // Step 1: Fetch agency list
    crawlPhase = 'list';
    log('Step 1: Fetching agency list from government.se...');
    agencies = await fetchAgencyList(msg => log(msg), signal);
    log(`Found ${agencies.length} agencies.`);
    await saveResults(agencies);

    // Step 2: Resolve websites
    crawlPhase = 'websites';
    log('Step 2: Resolving agency websites...');
    for (let i = 0; i < agencies.length; i++) {
      if (signal.aborted) break;
      while (isPaused) {
        await new Promise(r => setTimeout(r, 500));
        if (signal.aborted) break;
      }

      updateProgress(i + 1, agencies.length, 'Resolving websites');
      await resolveAgencyWebsite(agencies[i], signal);
      log(`${agencies[i].name}: ${agencies[i].website || 'no website found'}`);

      // Save periodically
      if (i % 10 === 0) await saveResults(agencies);
      await new Promise(r => setTimeout(r, 1000));
    }

    const withWebsite = agencies.filter(a => a.website).length;
    log(`Resolved ${withWebsite}/${agencies.length} agency websites.`);
    await saveResults(agencies);

    // Step 3: Find international contacts
    crawlPhase = 'contacts';
    log('Step 3: Searching for international cooperation contacts...');
    const agenciesWithSites = agencies.filter(a => a.website);
    for (let i = 0; i < agenciesWithSites.length; i++) {
      if (signal.aborted) break;
      while (isPaused) {
        await new Promise(r => setTimeout(r, 500));
        if (signal.aborted) break;
      }

      updateProgress(i + 1, agenciesWithSites.length, 'Finding contacts');
      await findInternationalContacts(agenciesWithSites[i], msg => log(msg), signal);

      const c = agenciesWithSites[i].contacts;
      if (c.length > 0) {
        log(`  -> Found ${c.length} contact(s) for ${agenciesWithSites[i].name}`);
      }

      // Save periodically
      if (i % 5 === 0) {
        await saveResults(agencies);
        renderResults();
      }
    }

    await saveResults(agencies);
    crawlPhase = 'done';
    log('Crawl complete!');
  } catch (err) {
    if (err.name !== 'AbortError') {
      log(`Error: ${err.message}`);
    }
  } finally {
    renderResults();
    startBtn.disabled = false;
    startBtn.textContent = crawlPhase === 'done' ? 'Re-run Crawl' : 'Resume Crawl';
    pauseBtn.disabled = true;
    exportBtn.disabled = agencies.length === 0;
  }
}

function pauseCrawl() {
  if (isPaused) {
    isPaused = false;
    pauseBtn.textContent = 'Pause';
    log('Resumed.');
  } else {
    isPaused = true;
    pauseBtn.textContent = 'Resume';
    log('Paused.');
  }
}

function stopCrawl() {
  if (abortController) {
    abortController.abort();
    log('Crawl stopped.');
  }
}

// --------------- Event Listeners ---------------

startBtn.addEventListener('click', startCrawl);
pauseBtn.addEventListener('click', pauseCrawl);
exportBtn.addEventListener('click', () => exportCSV(agencies));

// --------------- Load Previous Results on Open ---------------

(async () => {
  const saved = await loadResults();
  if (saved.agencies && saved.agencies.length > 0) {
    agencies = saved.agencies;
    log(`Loaded ${agencies.length} agencies from previous crawl (${saved.lastUpdated}).`);
    renderResults();
    exportBtn.disabled = false;
    startBtn.textContent = 'Re-run Crawl';
  }
})();
