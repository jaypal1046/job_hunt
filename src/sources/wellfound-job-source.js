/**
 * WellfoundJobSource — Stage 3 Wellfound (AngelList Jobs) Scraper.
 * Interacts with Wellfound pages via Playwright to fetch rich job cards with full metadata.
 */
const CONFIG = require('../../config');
const { log } = require('../services/logger');

class WellfoundJobSource {
  constructor() {
    this.searchUrls = [
      'https://wellfound.com/jobs?q=flutter',
      'https://wellfound.com/jobs?q=react+native',
      'https://wellfound.com/jobs',
    ];
  }

  /**
   * Fetches raw job cards with rich metadata from Wellfound page
   */
  async fetchRawCards(page, searchUrl) {
    log('wellfound', `[WellfoundJobSource] Navigating to ${searchUrl}`);
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);

      const rawCards = await page.evaluate(() => {
        const items = [];
        const links = [...document.querySelectorAll('a[href*="/jobs/"]')];
        for (const a of links) {
          const href = a.href ? a.href.split('?')[0] : '';
          if (!/\/jobs\/\d+/i.test(href)) continue;

          const titleText = a.textContent.trim();
          if (!titleText || titleText.length < 3) continue;

          let row = a.closest('div[class*="styles_component"]') || a.closest('div[class*="job"]') || a.closest('div');
          for (let i = 0; i < 5 && row && row.textContent.trim().length < 40; i++) row = row.parentElement;

          const rowText = row ? row.textContent : '';
          if (/applied/i.test(rowText)) continue;

          const compEl = row ? row.querySelector('[class*="company"], [class*="startup"], h2, h3') : null;
          const salEl = row ? row.querySelector('[class*="salary"], [class*="compensation"]') : null;
          const locEl = row ? row.querySelector('[class*="location"]') : null;
          const tagsEls = row ? row.querySelectorAll('[class*="tag"], [class*="badge"]') : [];
          const tagsText = Array.from(tagsEls).map((el) => el.textContent.trim()).join(', ');

          const company = compEl ? compEl.textContent.trim() : 'Wellfound Employer';
          const salary = salEl ? salEl.textContent.trim() : 'Not Specified';
          const location = locEl ? locEl.textContent.trim() : 'Remote / Flexible';

          if (!items.some((j) => j.link === href)) {
            items.push({
              title: titleText.split('\n')[0].trim(),
              company,
              salary,
              location,
              skills: tagsText,
              link: href,
              description: rowText,
              textContent: rowText,
              isCompanySite: false,
              isEasyApply: true,
            });
          }
        }
        return items;
      });

      log('wellfound', `[WellfoundJobSource] Extracted ${rawCards.length} rich job cards.`);
      return rawCards;
    } catch (err) {
      log('wellfound', `[WellfoundJobSource] Failed to fetch ${searchUrl}: ${err.message}`);
      return [];
    }
  }
}

module.exports = WellfoundJobSource;
