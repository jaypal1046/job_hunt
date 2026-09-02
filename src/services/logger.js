/**
 * Persistent State & Logger Service
 * Manages rich, date-wise structured state tracking with job title, company, match score, and timestamps.
 * Supports permanent cross-day history for LinkedIn, Naukri, and Wellfound to prevent re-applying to duplicate jobs.
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('../../config');

const logsDir = CONFIG.paths.logs;
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const profilesDir = CONFIG.paths.profiles;
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir, { recursive: true });
}

const SYSTEM_LOG = path.join(logsDir, 'system.log');
const CSV_FILE = CONFIG.paths.csv;
const NAUKRI_HISTORY_FILE = path.join(logsDir, 'naukri_history.json');
const LINKEDIN_HISTORY_FILE = path.join(logsDir, 'linkedin_history.json');

function log(moduleName, message) {
  const timestamp = new Date().toLocaleString();
  const line = `[${timestamp}] [${moduleName.toUpperCase()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(SYSTEM_LOG, line + '\n');
  } catch (e) {}
}

/**
 * Helper to extract unique numeric Naukri Job ID from URL or key string
 * Example: ...-flutter-developer-zensar-260826012624 -> "260826012624"
 */
function extractNaukriJobId(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.match(/[-_](\d{8,15})(?:\?|$)/) || str.match(/(\d{10,15})/);
  return match ? match[1] : null;
}

/**
 * Reads applications.csv and extracts all applied URLs and Naukri Job IDs across days
 */
let csvCache = null;
function loadCsvHistory() {
  if (csvCache) return csvCache;
  const urls = new Set();
  const jobIds = new Set();

  try {
    if (fs.existsSync(CSV_FILE)) {
      const content = fs.readFileSync(CSV_FILE, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const matches = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
        if (matches && matches.length >= 8) {
          const rawLink = matches[7].replace(/^"|"$/g, '').trim();
          if (rawLink && rawLink.startsWith('http')) {
            urls.add(rawLink);
            const jId = extractNaukriJobId(rawLink);
            if (jId) jobIds.add(jId);
          }
        }
      }
    }
  } catch (e) {}

  csvCache = { urls, jobIds };
  return csvCache;
}

function addLinkToCsvCache(link) {
  if (!link) return;
  const cache = loadCsvHistory();
  cache.urls.add(link);
  const jId = extractNaukriJobId(link);
  if (jId) cache.jobIds.add(jId);
}

/**
 * Gets or initializes rich date-wise state object for a platform
 */
function getDayState(site) {
  const stateFile = path.join(logsDir, `state-${site}.json`);
  const todayKey = new Date().toDateString();

  const defaultState = {
    date: todayKey,
    count: 0,
    lastRunTimestamp: 0,
    processed: [],
  };

  try {
    if (fs.existsSync(stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed && parsed.date === todayKey) {
        return {
          date: todayKey,
          count: parsed.count || 0,
          lastRunTimestamp: parsed.lastRunTimestamp || 0,
          processed: Array.isArray(parsed.processed) ? parsed.processed : Array.isArray(parsed.seen) ? parsed.seen.map(s => ({ key: s })) : [],
        };
      }
    }
  } catch (e) {}

  return defaultState;
}

/**
 * Save updated state object atomically to disk
 */
function saveDayState(site, stateObj) {
  const stateFile = path.join(logsDir, `state-${site}.json`);
  try {
    stateObj.date = new Date().toDateString();
    stateObj.lastRunTimestamp = Date.now();
    if (Array.isArray(stateObj.processed) && stateObj.processed.length > 2000) {
      stateObj.processed = stateObj.processed.slice(-2000);
    }
    fs.writeFileSync(stateFile, JSON.stringify(stateObj, null, 2));
  } catch (err) {
    log(site, `Failed to save persistent state: ${err.message}`);
  }
}

/**
 * Cross-day permanent history for Naukri
 */
function loadNaukriHistory() {
  try {
    if (fs.existsSync(NAUKRI_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(NAUKRI_HISTORY_FILE, 'utf8'));
    }
  } catch (e) {}

  // Seed from CSV on first run
  const seeded = { jobs: [] };
  const csv = loadCsvHistory();
  for (const url of csv.urls) {
    if (url.includes('naukri.com')) {
      seeded.jobs.push({
        key: url,
        jobId: extractNaukriJobId(url),
        link: url,
        date: 'Imported from applications.csv',
      });
    }
  }
  return seeded;
}

function saveNaukriHistory(history) {
  try {
    if (history.jobs.length > 5000) {
      history.jobs = history.jobs.slice(-5000);
    }
    fs.writeFileSync(NAUKRI_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {}
}

function recordNaukriPermanent(entry) {
  const history = loadNaukriHistory();
  const key = entry.link || entry.key || `${entry.title}_${entry.company}`;
  const jobId = extractNaukriJobId(key);

  const exists = history.jobs.some(
    (j) => j.key === key || j.link === key || (jobId && j.jobId === jobId)
  );

  if (!exists) {
    history.jobs.push({
      key,
      jobId: jobId || null,
      title: entry.title || '',
      company: entry.company || '',
      link: entry.link || key,
      date: new Date().toLocaleString(),
    });
    saveNaukriHistory(history);
  }
}

/**
 * Record a rich processed job/connection entry date-wise in state
 */
function recordAction(site, itemData, shouldIncrement = true) {
  const state = getDayState(site);
  const timestamp = new Date().toLocaleString();

  let entry = {};
  if (typeof itemData === 'string') {
    entry = { key: itemData, timestamp };
  } else if (itemData && typeof itemData === 'object') {
    entry = {
      timestamp,
      title: itemData.title || itemData.name || 'Role',
      company: itemData.company || itemData.title || 'Company',
      type: itemData.type || 'Applied',
      link: itemData.link || itemData.key || '',
      matchScore: itemData.matchScore || 'N/A',
      key: itemData.link || itemData.key || `${itemData.title}_${itemData.company}`,
    };
  }

  const exists = state.processed.some((p) => p.key === entry.key || (p.link && entry.link && p.link === entry.link));
  if (!exists) {
    state.processed.push(entry);
    if (shouldIncrement) {
      state.count++;
    }
  }

  saveDayState(site, state);

  if (entry.link) {
    addLinkToCsvCache(entry.link);
  }

  if (site === 'naukri') {
    recordNaukriPermanent(entry);
  }

  return state;
}

/**
 * Check if a job link, key, or profile URL has already been processed today OR in permanent cross-day history
 */
function hasBeenSeen(site, keyOrLink) {
  if (!keyOrLink) return false;

  // 1. Check CSV cross-day history
  const csv = loadCsvHistory();
  if (csv.urls.has(keyOrLink)) return true;
  const inputJobId = extractNaukriJobId(keyOrLink);
  if (inputJobId && csv.jobIds.has(inputJobId)) return true;

  // 2. Check site permanent cross-day history
  if (site === 'naukri') {
    const naukriHist = loadNaukriHistory();
    if (
      naukriHist.jobs.some(
        (j) => j.key === keyOrLink || j.link === keyOrLink || (inputJobId && j.jobId === inputJobId)
      )
    ) {
      return true;
    }
  } else if (site === 'linkedin') {
    if (isPermanentlySeen(keyOrLink)) return true;
  }

  // 3. Check daily state
  const state = getDayState(site);
  return state.processed.some((p) => {
    if (p.key === keyOrLink || p.link === keyOrLink) return true;
    if (inputJobId && p.key) {
      const pJobId = extractNaukriJobId(p.key);
      if (pJobId && pJobId === inputJobId) return true;
    }
    return false;
  });
}

function csvRow(vals) {
  return vals.map((v) => '"' + String(v || '').replace(/"/g, '""').replace(/\s+/g, ' ').trim() + '"').join(',') + '\n';
}

function logApplication(site, job) {
  try {
    if (!fs.existsSync(CSV_FILE)) {
      fs.writeFileSync(
        CSV_FILE,
        '\uFEFF' + csvRow(['Date', 'Site', 'Role', 'Company', 'CTC/Salary', 'Match Score', 'Skills', 'Job Link', 'Job Description'])
      );
    }
    fs.appendFileSync(
      CSV_FILE,
      csvRow([
        new Date().toLocaleString(),
        site,
        job.title || 'Unknown Title',
        job.company || 'Unknown Company',
        job.salary || 'Not Specified',
        job.matchScore || 'N/A',
        job.skills || '',
        job.link || '',
        (job.jd || '').slice(0, 1000)
      ])
    );
    if (job.link) {
      addLinkToCsvCache(job.link);
    }
  } catch (err) {
    log(site, `Failed to write application to CSV: ${err.message}`);
  }
}

/**
 * Bump daily count for a site without adding a processed entry
 */
function bumpDayCount(site) {
  const state = getDayState(site);
  state.count++;
  saveDayState(site, state);
  return state;
}

/**
 * Persistent cross-day history for LinkedIn (never re-attempt same person)
 * Stored in logs/linkedin_history.json — survives across days
 */
function loadPermanentHistory() {
  try {
    if (fs.existsSync(LINKEDIN_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(LINKEDIN_HISTORY_FILE, 'utf8'));
    }
  } catch (e) {}
  return { profiles: [] };
}

function savePermanentHistory(history) {
  try {
    if (history.profiles.length > 5000) {
      history.profiles = history.profiles.slice(-5000);
    }
    fs.writeFileSync(LINKEDIN_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {}
}

/**
 * Check if a profile URL/key has ever been processed (cross-day)
 */
function isPermanentlySeen(key) {
  if (!key) return false;
  const history = loadPermanentHistory();
  return history.profiles.some((p) => p.key === key || p.link === key);
}

/**
 * Record a profile to permanent history (cross-day dedup)
 */
function recordPermanent(entry) {
  const history = loadPermanentHistory();
  const key = entry.key || entry.link || `${entry.name}_${entry.title}`;
  if (!history.profiles.some((p) => p.key === key)) {
    history.profiles.push({
      key,
      name: entry.name || '',
      title: entry.title || '',
      link: entry.link || '',
      type: entry.type || 'connection',
      date: new Date().toLocaleString(),
    });
    savePermanentHistory(history);
  }
}

module.exports = {
  log,
  logApplication,
  getDayState,
  saveDayState,
  bumpDayCount,
  recordAction,
  hasBeenSeen,
  isPermanentlySeen,
  recordPermanent,
  extractNaukriJobId,
  SYSTEM_LOG,
};

