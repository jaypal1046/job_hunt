/**
 * NaukriJobSource — Stage 3 Naukri Job Source.
 * Interacts with Naukri pages via Playwright to fetch raw job cards.
 */
const CONFIG = require('../../config');
const { log } = require('../services/logger');

class NaukriJobSource {
  constructor() {
    this.searchUrls1Day = [
      'https://www.naukri.com/flutter-developer-jobs?experience=4&sort=f&jobAge=1',
      'https://www.naukri.com/react-native-developer-jobs?experience=4&sort=f&jobAge=1',
      'https://www.naukri.com/mobile-application-developer-jobs?experience=4&sort=f&jobAge=1',
      'https://www.naukri.com/full-stack-developer-jobs?experience=4&sort=f&jobAge=1',
      'https://www.naukri.com/node-js-developer-jobs?experience=4&sort=f&jobAge=1',
    ];

    this.searchUrls3Days = [
      'https://www.naukri.com/flutter-developer-jobs?experience=4&sort=f&jobAge=3',
      'https://www.naukri.com/react-native-developer-jobs?experience=4&sort=f&jobAge=3',
      'https://www.naukri.com/mobile-application-developer-jobs?experience=4&sort=f&jobAge=3',
    ];
  }

  getNaukriPageUrl(baseUrl, pageNum) {
    if (pageNum <= 1) return baseUrl;
    try {
      const url = new URL(baseUrl);
      let pathname = url.pathname;
      pathname = pathname.replace(/-\d+$/, '');
      url.pathname = `${pathname}-${pageNum}`;
      url.searchParams.set('pageNo', pageNum);
      return url.toString();
    } catch {
      return baseUrl;
    }
  }

  /**
   * Fetches raw job cards from a specific search feed page
   */
  async fetchRawCardsFromPage(page, searchUrl, pageNum = 1) {
    const pageUrl = this.getNaukriPageUrl(searchUrl, pageNum);
    log('naukri', `[NaukriJobSource] Navigating to page ${pageNum}: ${pageUrl}`);

    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);

      const rawCards = await page.evaluate(() => {
        const cards = [];
        const wrappers = document.querySelectorAll('.srp-jobtuple-wrapper, [class*="jobTuple"], [class*="srp-job-tuple"]');
        for (const card of wrappers) {
          const titleEl = card.querySelector('a.title, [class*="title"]');
          const compEl = card.querySelector('a.comp-name, [class*="company"]');
          const salEl = card.querySelector('.sal-wrap, [class*="salary"]');
          const expEl = card.querySelector('.exp-wrap, [class*="exp"]');
          const locEl = card.querySelector('.loc-wrap, [class*="loc"]');

          const descEl = card.querySelector('.job-desc, [class*="job-description"], [class*="desc"], .row6, .job-post-day');
          const tagsEls = card.querySelectorAll('.tag-li, [class*="tag"], ul.tags-gt li');
          const tagsText = Array.from(tagsEls).map((el) => el.textContent.trim()).join(', ');

          const textContent = card.textContent || '';
          const isCompanySite = /apply on company site/i.test(textContent);
          const isEasyApply = /apply/i.test(textContent) && !isCompanySite;
          const isAlreadyAppliedInDom = /applied/i.test(textContent) && !isEasyApply;

          if (titleEl && titleEl.href) {
            cards.push({
              title: titleEl.textContent.trim(),
              company: compEl ? compEl.textContent.trim() : 'Naukri Employer',
              salary: salEl ? salEl.textContent.trim() : 'Not Disclosed',
              experience: expEl ? expEl.textContent.trim() : '',
              location: locEl ? locEl.textContent.trim() : '',
              description: descEl ? descEl.textContent.trim() : textContent,
              skills: tagsText,
              textContent,
              link: titleEl.href,
              isCompanySite,
              isEasyApply,
              isAlreadyAppliedInDom,
            });
          }
        }
        return cards;
      });

      log('naukri', `[NaukriJobSource] Retried ${rawCards.length} job cards from feed.`);
      return rawCards;
    } catch (err) {
      log('naukri', `[NaukriJobSource] Failed to fetch page ${pageUrl}: ${err.message}`);
      return [];
    }
  }
}

module.exports = NaukriJobSource;
