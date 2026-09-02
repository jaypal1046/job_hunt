/**
 * External Company Site Apply & Tracker Service
 * Handles jobs that redirect to external ATS platforms (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, etc.).
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('../../config');
const { log } = require('./logger');

const EXTERNAL_CSV = path.join(CONFIG.paths.logs, 'external_company_jobs.csv');

class ExternalApplyService {
  constructor() {
    this.initCsv();
  }

  initCsv() {
    if (!fs.existsSync(EXTERNAL_CSV)) {
      try {
        const header = '"Date","Site","Role","Company","External Job Link","Status"\n';
        fs.writeFileSync(EXTERNAL_CSV, '\uFEFF' + header);
      } catch (e) {}
    }
  }

  functionCsvRow(vals) {
    return vals.map((v) => '"' + String(v || '').replace(/"/g, '""').replace(/\s+/g, ' ').trim() + '"').join(',') + '\n';
  }

  /**
   * Log an external company job that requires external application
   */
  logExternalJob(site, jobTitle, company, externalUrl, status = 'Pending External Apply') {
    try {
      const row = this.functionCsvRow([
        new Date().toLocaleString(),
        site,
        jobTitle || 'Unknown Role',
        company || 'Company',
        externalUrl || '',
        status,
      ]);
      fs.appendFileSync(EXTERNAL_CSV, row);
      log('external-apply', `Logged external company job to CSV: "${jobTitle}" @ "${company}" -> ${externalUrl}`);
    } catch (err) {
      log('external-apply', `Failed to log external job: ${err.message}`);
    }
  }

  /**
   * Detects if an external URL is a known ATS platform (Greenhouse, Lever, Ashby, etc.)
   */
  detectAtsType(url) {
    if (!url) return 'custom';
    const lower = url.toLowerCase();
    if (lower.includes('greenhouse.io') || lower.includes('boards.greenhouse.io')) return 'greenhouse';
    if (lower.includes('lever.co') || lower.includes('jobs.lever.co')) return 'lever';
    if (lower.includes('ashbyhq.com')) return 'ashby';
    if (lower.includes('smartrecruiters.com')) return 'smartrecruiters';
    if (lower.includes('workday.com')) return 'workday';
    return 'custom';
  }

  /**
   * Auto-fill Lever / Greenhouse forms using candidate CV data
   */
  async fillAtsForm(page, url) {
    const ats = this.detectAtsType(url);
    log('external-apply', `Attempting auto-fill on external ATS platform (${ats}): ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);

      const cv = CONFIG.cv;

      // Common input field auto-filling
      await page.evaluate(([cvData]) => {
        function fillField(selectors, value) {
          if (!value) return;
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && !el.value) {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }

        // Name fields
        fillField(['input[name*="name" i]', '#first_name', '#name', 'input[autocomplete="name"]'], cvData.name);
        fillField(['#last_name'], cvData.name.split(' ').slice(1).join(' '));

        // Contact info
        fillField(['input[type="email"]', 'input[name*="email" i]', '#email'], cvData.email);
        fillField(['input[type="tel"]', 'input[name*="phone" i]', '#phone'], cvData.phone);
        fillField(['input[name*="location" i]', 'input[name*="city" i]'], cvData.location);

        // Social / Portfolio Links
        fillField(['input[name*="linkedin" i]', 'input[placeholder*="linkedin" i]'], cvData.linkedin);
        fillField(['input[name*="github" i]', 'input[placeholder*="github" i]'], cvData.github);
        fillField(['input[name*="portfolio" i]', 'input[name*="website" i]'], cvData.portfolio);
      }, [cv]);

      log('external-apply', `Completed ATS form auto-fill for ${url}`);
      return true;
    } catch (err) {
      log('external-apply', `ATS auto-fill incomplete for ${url}: ${err.message}`);
      return false;
    }
  }
}

module.exports = new ExternalApplyService();
