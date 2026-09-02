/**
 * YCJobSource — Stage 3 Y Combinator (Work at a Startup) Scraper.
 * Interacts with workatastartup.com pages via Playwright to fetch rich startup job cards.
 */
const CONFIG = require('../../config');
const { log } = require('../services/logger');

class YCJobSource {
  constructor() {
    this.searchUrls = [
      'https://www.workatastartup.com/jobs?q=flutter',
      'https://www.workatastartup.com/jobs?q=react+native',
      'https://www.workatastartup.com/jobs?q=mobile',
      'https://www.workatastartup.com/jobs',
    ];
  }

  /**
   * Fetches raw job cards with rich startup metadata from YC Work at a Startup page
   */
  async fetchRawCards(page, searchUrl) {
    log('yc', `[YCJobSource] Navigating to ${searchUrl}`);
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);

      const rawCards = await page.evaluate(() => {
        const items = [];
        const jobLinks = [...document.querySelectorAll('a[href*="/jobs/"]')];
        for (const a of jobLinks) {
          const href = a.href ? a.href.split('?')[0] : '';
          if (!/\/jobs\/\d+/i.test(href) && !/\/companies\/.*\/jobs\//i.test(href)) continue;

          const titleText = a.textContent.trim();
          if (!titleText || titleText.length < 3) continue;

          let row = a.closest('div[class*="job"]') || a.closest('div[class*="company"]') || a.closest('tr') || a.closest('div');
          for (let i = 0; i < 4 && row && row.textContent.trim().length < 30; i++) row = row.parentElement;

          const rowText = row ? row.textContent : '';
          if (/applied/i.test(rowText)) continue;

          const compEl = row ? row.querySelector('[class*="company"], [class*="startup"], h4, h3, strong') : null;
          const salEl = row ? row.querySelector('[class*="salary"], [class*="compensation"]') : null;
          const locEl = row ? row.querySelector('[class*="location"]') : null;
          const tagsEls = row ? row.querySelectorAll('[class*="pill"], [class*="tag"], [class*="badge"]') : [];
          const tagsText = Array.from(tagsEls).map((el) => el.textContent.trim()).join(', ');

          const company = compEl ? compEl.textContent.trim() : 'YC Startup';
          const salary = salEl ? salEl.textContent.trim() : 'Not Specified';
          const location = locEl ? locEl.textContent.trim() : 'Remote / YC Funded';

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

      log('yc', `[YCJobSource] Extracted ${rawCards.length} rich YC job cards.`);
      return rawCards;
    } catch (err) {
      log('yc', `[YCJobSource] Failed to fetch ${searchUrl}: ${err.message}`);
      return [];
    }
  }
}

module.exports = YCJobSource;
