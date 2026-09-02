/**
 * RemoteJobSource — Stage 3 Scraper for Remote & Startup Platforms:
 * 1. Startup.jobs (https://startup.jobs/?q=Flutter&since=30d)
 * 2. RemoteOK (https://remoteok.com/remote-flutter-jobs)
 * 3. We Work Remotely (https://weworkremotely.com/remote-jobs/search?term=Flutter)
 * 4. Himalayas (https://himalayas.app/jobs/countries/india?q=Flutter&sort=recent)
 */
const CONFIG = require('../../config');
const { log } = require('../services/logger');

class RemoteJobSource {
  constructor() {
    this.sources = [
      {
        name: 'Startup.jobs',
        url: 'https://startup.jobs/?q=Flutter&since=30d',
        evaluateDomCards: () => {
          const cards = [];
          const links = document.querySelectorAll('a[href*="/jobs/"], a[href*="startup.jobs/"]');
          for (const a of links) {
            const href = a.href ? a.href.split('?')[0] : '';
            if (!href || href === window.location.href || cards.some((c) => c.link === href)) continue;

            let row = a.closest('.job-card, [class*="job"], [class*="card"], tr, li') || a.parentElement;
            const titleText = a.textContent.trim();
            if (!titleText || titleText.length <= 2 || /apply|view|more/i.test(titleText)) continue;

            const compEl = row ? row.querySelector('[class*="company"], [class*="employer"], span, strong') : null;
            const desc = row ? row.textContent : '';

            cards.push({
              title: titleText.split('\n')[0].trim(),
              company: compEl ? compEl.textContent.trim() : 'Startup.jobs Employer',
              location: 'Remote / Startup',
              salary: 'Not Disclosed',
              link: href,
              description: desc,
              textContent: desc,
              isCompanySite: true,
            });
          }
          return cards;
        },
      },
      {
        name: 'RemoteOK',
        url: 'https://remoteok.com/remote-flutter-jobs',
        evaluateDomCards: () => {
          const cards = [];
          const rows = document.querySelectorAll('tr.job, [data-id], .job');
          for (const row of rows) {
            const titleEl = row.querySelector('h2[itemprop="title"], h2, td.company h2, [class*="title"]');
            const compEl = row.querySelector('h3[itemprop="name"], h3, td.company h3');
            const salEl = row.querySelector('.salary, [class*="salary"]');
            const tagsEls = row.querySelectorAll('.tag, [class*="tag"]');
            const tagsText = Array.from(tagsEls).map((el) => el.textContent.trim()).join(', ');
            const linkEl = row.querySelector('a.preventLink, a[href*="/remote-jobs/"], a[href*="/l/"]');

            if (!linkEl || !linkEl.href) continue;
            let href = linkEl.href;
            if (href.startsWith('/')) href = `https://remoteok.com${href}`;

            if (cards.some((c) => c.link === href)) continue;

            const titleText = titleEl ? titleEl.textContent.trim() : '';
            if (!titleText || titleText.length <= 2) continue;

            const compText = compEl ? compEl.textContent.trim() : 'RemoteOK Employer';
            const desc = row.textContent || '';

            cards.push({
              title: titleText,
              company: compText,
              salary: salEl ? salEl.textContent.trim() : 'Worldwide Remote',
              skills: tagsText,
              location: 'Worldwide Remote',
              link: href,
              description: desc,
              textContent: desc,
              isCompanySite: true,
            });
          }
          return cards;
        },
      },
      {
        name: 'We Work Remotely',
        url: 'https://weworkremotely.com/remote-jobs/search?term=Flutter',
        evaluateDomCards: () => {
          const cards = [];
          const links = document.querySelectorAll('a[href*="/remote-jobs/"]');
          for (const a of links) {
            const href = a.href ? a.href.split('?')[0] : '';
            if (!href || /\/(categories|search|post|categories\/)/.test(href) || cards.some((c) => c.link === href)) continue;

            let row = a.closest('li') || a.closest('article') || a.parentElement;
            const titleEl = row ? row.querySelector('.title, h2, h3, span.title') || a : a;
            const compEl = row ? row.querySelector('.company, span.company') : null;
            const regionEl = row ? row.querySelector('.region') : null;

            const titleText = titleEl ? titleEl.textContent.trim() : '';
            if (!titleText || titleText.length <= 2 || /view all|post a job/i.test(titleText)) continue;

            const desc = row ? row.textContent : '';

            cards.push({
              title: titleText.split('\n')[0].trim(),
              company: compEl ? compEl.textContent.trim() : 'WWR Employer',
              location: regionEl ? regionEl.textContent.trim() : 'Worldwide Remote',
              salary: 'Not Disclosed',
              link: href,
              description: desc,
              textContent: desc,
              isCompanySite: true,
            });
          }
          return cards;
        },
      },
      {
        name: 'Himalayas',
        url: 'https://himalayas.app/jobs/countries/india?q=Flutter&sort=recent',
        evaluateDomCards: () => {
          const cards = [];
          const links = document.querySelectorAll('a[href*="/jobs/"]');
          for (const a of links) {
            const href = a.href ? a.href.split('?')[0] : '';
            if (!href || !/\/jobs\//.test(href) || /\/(countries|skills|tools|salaries|post)\//.test(href) || cards.some((c) => c.link === href)) continue;

            let row = a.closest('[data-testid="job-card"]') || a.closest('article') || a.closest('li') || a.parentElement;
            const titleEl = row ? row.querySelector('h2, h3, [class*="title"]') || a : a;
            const titleText = titleEl ? titleEl.textContent.trim() : '';
            if (!titleText || titleText.length <= 2 || /browse|search|view/i.test(titleText)) continue;

            const compEl = row ? row.querySelector('[class*="company"], a[href*="/companies/"]') : null;
            const locEl = row ? row.querySelector('[class*="location"], [class*="country"]') : null;
            const desc = row ? row.textContent : '';

            cards.push({
              title: titleText.split('\n')[0].trim(),
              company: compEl ? compEl.textContent.trim() : 'Himalayas Employer',
              location: locEl ? locEl.textContent.trim() : 'India / Remote',
              salary: 'Competitive',
              link: href,
              description: desc,
              textContent: desc,
              isCompanySite: true,
            });
          }
          return cards;
        },
      },
    ];
  }

  /**
   * Fetches raw job cards for a given remote source
   */
  async fetchRawCardsFromSource(page, src) {
    log('remote', `[RemoteJobSource] Navigating to ${src.name}: ${src.url}`);
    try {
      await page.goto(src.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);

      const rawCards = await page.evaluate(src.evaluateDomCards).catch((err) => {
        log('remote', `[RemoteJobSource] Error evaluating DOM cards on ${src.name}: ${err.message}`);
        return [];
      });

      log('remote', `[RemoteJobSource] Extracted ${rawCards.length} rich job cards from ${src.name}.`);
      return rawCards;
    } catch (err) {
      log('remote', `[RemoteJobSource] Failed to fetch ${src.name} (${src.url}): ${err.message}`);
      return [];
    }
  }
}

module.exports = RemoteJobSource;
