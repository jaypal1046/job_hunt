const path = require('path');
const fs = require('fs');
const BaseAdapter = require('./base-adapter');
const CONFIG = require('../../config');
const { log, logApplication, getDayState, bumpDayCount, recordAction } = require('../services/logger');
const gemini = require('../services/gemini');
const notifier = require('../services/notifier');
const externalApply = require('../services/external-apply-service');

const LocalJobRepository = require('../repositories/local-job-repository');
const ScanStateRepository = require('../repositories/scan-state-repository');
const NaukriJobSource = require('../sources/naukri-job-source');
const JobNormalizer = require('../core/pipeline/job-normalizer');
const JobFilter = require('../core/pipeline/job-filter');
const DuplicateChecker = require('../core/pipeline/duplicate-checker');
const SessionManager = require('../core/pipeline/session-manager');
const ApplicationProcessor = require('../core/pipeline/application-processor');
const { SessionStatus } = require('../core/state/status-enum');

let chromium;
try {
  const { addExtra } = require('playwright-extra');
  chromium = addExtra(require('playwright-core').chromium);
  chromium.use(require('puppeteer-extra-plugin-stealth')());
} catch (e) {
  ({ chromium } = require('playwright-core'));
}

class NaukriAdapter extends BaseAdapter {
  constructor() {
    super('naukri');
    this.profileDir = path.join(CONFIG.paths.profiles, '.naukri-chrome-profile');
    this.profileUrl = CONFIG.creds.naukriProfileUrl;
    this.loginUrl = `https://www.naukri.com/nlogin/login?URL=${this.profileUrl}`;
    this.dailyCap = CONFIG.pacing.naukriDailyCap;

    // 3-Stage Architecture Repositories & Pipeline Managers
    this.localDb = new LocalJobRepository();
    this.scanStateRepo = new ScanStateRepository();
    this.jobSource = new NaukriJobSource();
    this.sessionMgr = new SessionManager();
    this.duplicateChecker = new DuplicateChecker(this.localDb, this.sessionMgr);
    this.appProcessor = new ApplicationProcessor(this.localDb, this.sessionMgr);
  }

  getNaukriPageUrl(baseUrl, pageNum) {
    return this.jobSource.getNaukriPageUrl(baseUrl, pageNum);
  }

  onProfile(urlStr) {
    try {
      const url = new URL(urlStr);
      return url.pathname.startsWith('/mnjuser');
    } catch {
      return false;
    }
  }

  async googleLogin(ctx, page) {
    log('naukri', 'Session expired — attempting Google auto-login...');
    await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const googleBtn = page.locator('.socialbtn.google, [class*="socialbtn"][class*="google"]').first();
    await googleBtn.waitFor({ timeout: 20000 });
    await googleBtn.click();

    let g = null;
    for (let i = 0; i < 30 && !g; i++) {
      await page.waitForTimeout(1000);
      g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
    }
    if (!g) throw new Error('Google sign-in page never appeared');
    await g.waitForLoadState('domcontentloaded');

    const knownAccount = g.locator(`[data-email="${CONFIG.creds.googleEmail}"]`).first();
    if (await knownAccount.isVisible().catch(() => false)) {
      await knownAccount.click();
    } else {
      const emailBox = g.locator('input#identifierId, input[type="email"], input[name="identifier"]').first();
      await emailBox.waitFor({ state: 'visible', timeout: 60000 });
      await emailBox.fill(CONFIG.creds.googleEmail);
      await g.locator('#identifierNext, button:has-text("Next")').first().click();

      const passBox = g.locator('input[type="password"], input[name="Passwd"]').first();
      await passBox.waitFor({ state: 'visible', timeout: 60000 });
      await passBox.fill(CONFIG.creds.googlePassword);
      await g.locator('#passwordNext, button:has-text("Next")').first().click();
    }

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (!g.isClosed()) {
        await g.locator('button:has-text("Continue")').first().click({ timeout: 500 }).catch(() => {});
      }
      const done = ctx.pages().find((p) => this.onProfile(p.url()));
      if (done) {
        log('naukri', 'Google login succeeded.');
        return done;
      }
      if (g.isClosed() || /naukri\.com/.test(g.url())) {
        await page.goto(this.profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        if (this.onProfile(page.url())) {
          log('naukri', 'Google login succeeded.');
          return page;
        }
      }
      await page.waitForTimeout(2000);
    }

    throw new Error('Google login did not complete — likely requires 2FA approval. Run "node main.js login naukri".');
  }

  async login() {
    log('naukri', 'Opening visible Chrome browser for manual Naukri login...');
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log('naukri', 'Please log in to Naukri in the browser window, then close the browser when done.');

    await new Promise((res) => ctx.on('close', res));
    log('naukri', 'Login session saved to profile directory.');
  }

  async dismissOverlays(page) {
    try {
      await page.evaluate(() => {
        const selectors = [
          '.md__backdrop',
          '#ni-desktop-nps-profile',
          '.nps-dialog',
          '[data-section-name="ni-desktop-nps-profile"]',
          '.drawer-wrapper .cross',
          '.crossIcon',
          '[class*="nps-modal"]',
          '.cross',
          '#drawer-cq .cross',
          'div.rating',
          '.chat-wrapper',
        ];
        selectors.forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });
      });
    } catch (e) {}
  }

  async clickWithFallback(page, locator, jsQuery) {
    await this.dismissOverlays(page);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await this.dismissOverlays(page);
    try {
      await locator.click({ timeout: 5000 });
    } catch (e) {
      log('naukri', 'Standard click intercepted/blocked, using force & JS click fallback...');
      await this.dismissOverlays(page);
      await locator.click({ force: true }).catch(async () => {
        await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (el) el.click();
        }, jsQuery);
      });
    }
  }

  async refreshProfile(ctx, page) {
    log('naukri', 'Executing profile refresh (headline dot update)...');
    await page.goto(this.profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (!this.onProfile(page.url())) {
      page = await this.googleLogin(ctx, page);
    }

    if (!/\/mnjuser\/profile/.test(page.url())) {
      await page.goto(this.profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await page.waitForTimeout(2000);
    const editSelector = '#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit';
    const editIcon = page.locator(editSelector);
    await editIcon.first().waitFor({ timeout: 30000 });

    await this.clickWithFallback(page, editIcon.first(), editSelector);

    const textarea = page.locator('#resumeHeadlineTxt');
    await textarea.waitFor({ timeout: 15000 });
    const current = (await textarea.inputValue()).trimEnd();
    const updated = current.endsWith('.') ? current.slice(0, -1) : current + '.';

    await textarea.fill(updated);

    const saveBtn = page.getByRole('button', { name: /^save$/i }).first();
    await this.clickWithFallback(page, saveBtn, 'button[type="button"]');
    await page.waitForTimeout(3000);

    // Verification reload
    await page.goto(this.profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await editIcon.first().waitFor({ timeout: 30000 });
    await this.clickWithFallback(page, editIcon.first(), editSelector);

    await textarea.waitFor({ timeout: 15000 });
    const saved = (await textarea.inputValue()).trimEnd();

    if (saved !== updated) {
      throw new Error(`Headline save verification failed. Found: "${saved.slice(0, 40)}"`);
    }

    const successMsg = `Headline updated (${current.endsWith('.') ? 'dot removed' : 'dot added'}) -> "${updated.slice(0, 60)}"`;
    log('naukri', `SUCCESS: ${successMsg}`);
    return { success: true, message: successMsg };
  }

  async applyDirectOnNaukri(ctx, job, isLive) {
    if (!isLive) {
      log('naukri', `  🔍 DRY_RUN — would click Apply on "${job.jobTitle || job.title}" @ "${job.companyName || job.company}"`);
      return true;
    }

    let jobPage = null;
    try {
      jobPage = await ctx.newPage();
      const targetLink = job.url || job.link;
      await jobPage.goto(targetLink, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await jobPage.waitForTimeout(2500);

      await this.dismissOverlays(jobPage);

      const pageText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');
      if (/already applied/i.test(pageText)) {
        log('naukri', `  ⏭ Already applied on Naukri: "${job.jobTitle || job.title}" @ "${job.companyName || job.company}"`);
        return false;
      }

      const applySelectors = [
        'button#apply-button',
        'button.apply-button',
        'button:has-text("Apply on website")',
        'button:has-text("Apply")',
        '[class*="apply-button"]',
        'button[title*="Apply"]',
      ];

      let applyBtn = null;
      for (const sel of applySelectors) {
        const loc = jobPage.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          applyBtn = loc;
          break;
        }
      }

      if (applyBtn) {
        await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
        await applyBtn.click().catch(async () => {
          await jobPage.evaluate(() => {
            const btn = document.querySelector('button#apply-button, button.apply-button, button[class*="apply"]');
            if (btn) btn.click();
          });
        });

        await jobPage.waitForTimeout(3000);

        try {
          const submitChatbot = jobPage.locator('button:has-text("Submit"), button:has-text("Save & Apply"), button:has-text("Continue")').first();
          if (await submitChatbot.isVisible().catch(() => false)) {
            await submitChatbot.click().catch(() => {});
            await jobPage.waitForTimeout(2000);
          }
        } catch (e) {}

        log('naukri', `  ✅ Real 1-Click Apply submitted on Naukri for: "${job.jobTitle || job.title}" @ "${job.companyName || job.company}"`);
        return true;
      } else {
        log('naukri', `  ⚠ Apply button not visible on job page for "${job.jobTitle || job.title}" @ "${job.companyName || job.company}"`);
        return false;
      }
    } catch (err) {
      log('naukri', `  ⚠ Failed to click Apply on "${job.jobTitle || job.title}": ${err.message}`);
      return false;
    } finally {
      if (jobPage && !jobPage.isClosed()) {
        await jobPage.close().catch(() => {});
      }
    }
  }

  async autoApplyJobs(ctx, page, isLive) {
    const dayState = getDayState('naukri');
    const targetCount = this.dailyCap - dayState.count;

    if (targetCount <= 0) {
      log('naukri', `Naukri daily cap of ${this.dailyCap} reached (${dayState.count} today). Skipping auto-apply.`);
      return 0;
    }

    // Initialize Stage 2 Session
    this.sessionMgr.reset();
    const historicalScanCompleted = this.scanStateRepo.isHistoricalScanCompleted();

    log('naukri', `================================================================`);
    log('naukri', `🚀 Starting 3-Stage Naukri Pipeline Execution (Target: ${targetCount} jobs, Mode: ${isLive ? 'LIVE' : 'DRY RUN'})`);
    log('naukri', `📌 Stage 1 Local DB Loaded (${this.localDb.getRecordCount()} records, 30-day retention active)`);
    log('naukri', `📌 Historical Scan State: ${historicalScanCompleted ? 'COMPLETED (Processing Day 1 Only)' : 'INITIAL RUN (Processing Day 1, Day 2 & Day 3)'}`);
    log('naukri', `================================================================`);

    const feedsToScan = [];
    feedsToScan.push(...this.jobSource.searchUrls1Day.map((url) => ({ url, label: 'Day 1 (24h Freshness)' })));

    if (!historicalScanCompleted) {
      feedsToScan.push(...this.jobSource.searchUrls3Days.map((url) => ({ url, label: 'Day 2/3 Historical Scan' })));
    }

    let totalApplied = 0;
    const maxPages = CONFIG.naukri?.searchPages || 3;

    for (const feed of feedsToScan) {
      if (totalApplied >= targetCount) break;

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        if (totalApplied >= targetCount) break;

        // Stage 3: Fetch jobs from Naukri Source
        const rawCards = await this.jobSource.fetchRawCardsFromPage(page, feed.url, pageNum);
        if (rawCards.length === 0) break;

        for (const rawCard of rawCards) {
          if (totalApplied >= targetCount) break;

          // Step 5: Normalize into common Job model & add to Stage 2 Session (Status: FOUND)
          const job = JobNormalizer.normalize(rawCard);
          const sessionJob = this.sessionMgr.addJob(job, SessionStatus.FOUND);

          // Step 7 & 8: Filter by Flutter & Freshness
          const filterResult = JobFilter.evaluate(sessionJob, historicalScanCompleted);
          if (!filterResult.passed) {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.FILTERED, filterResult.reason);
            this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: false, applicationStatus: 'FILTERED' });
            log('naukri', `  ⏭ [FILTERED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${filterResult.reason}`);
            continue;
          }

          // Step 9 & 10: Check Session & Local DB for duplicates
          const dupResult = this.duplicateChecker.checkDuplicate(sessionJob);
          if (dupResult.isDuplicate) {
            const reason = `Already processed/applied in ${dupResult.source} (matched by ${dupResult.matchedBy})`;
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.ALREADY_APPLIED, reason);
            log('naukri', `  ⏭ [ALREADY_APPLIED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${reason}`);
            continue;
          }

          if (rawCard.isAlreadyAppliedInDom) {
            const reason = 'Already applied on Naukri (DOM badge detected)';
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.ALREADY_APPLIED, reason);
            this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: true, applicationStatus: 'ALREADY_APPLIED' });
            log('naukri', `  ⏭ [ALREADY_APPLIED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${reason}`);
            continue;
          }

          // Mark READY_TO_APPLY
          this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.READY_TO_APPLY);

          // Step 13-16: Application Processor (Direct or Company Page)
          const success = await this.appProcessor.processApplication(ctx, sessionJob, {
            live: isLive,
            naukriAdapter: this,
          });

          if (success) {
            totalApplied++;
            recordAction(
              'naukri',
              {
                key: sessionJob.uniqueKey,
                title: sessionJob.jobTitle,
                company: sessionJob.companyName,
                link: sessionJob.url,
                type: sessionJob.applicationType,
              },
              true
            );
          }

          await page.waitForTimeout(2000);
        }
      }
    }

    // Persist historical scan state after initial setup run completes
    if (!historicalScanCompleted) {
      this.scanStateRepo.markHistoricalScanCompleted();
      log('naukri', `✅ Initial Day 2 & Day 3 historical scan completed and state persisted.`);
    }

    const sessionReport = this.sessionMgr.getExecutionReport();
    log('naukri', `================================================================`);
    log('naukri', `📊 Session Execution Report Summary:`);
    log('naukri', `   - Total Jobs Processed in Session: ${sessionReport.totalJobsProcessed}`);
    log('naukri', `   - Filtered out: ${sessionReport.counts.FILTERED}`);
    log('naukri', `   - Already Applied (Skipped): ${sessionReport.counts.ALREADY_APPLIED}`);
    log('naukri', `   - Successfully Applied: ${sessionReport.counts.APPLIED}`);
    log('naukri', `   - Failed: ${sessionReport.counts.FAILED}`);
    log('naukri', `================================================================`);

    return totalApplied;
  }

  async run(options = {}) {
    const isLive = options.live === true;
    const isLogin = options.login === true;
    const refreshOnly = options.refreshOnly === true;

    if (isLogin) {
      return await this.login();
    }

    log('naukri', 'Starting Naukri module execution...');
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
      ],
    });

    let page = ctx.pages()[0] || (await ctx.newPage());

    try {
      const refreshResult = await this.refreshProfile(ctx, page);

      let applyCount = 0;
      if (!refreshOnly) {
        applyCount = await this.autoApplyJobs(ctx, page, isLive);
      }

      return {
        success: true,
        refreshed: refreshResult.success,
        applyCount,
        message: refreshResult.message,
      };
    } catch (err) {
      const screenshotPath = path.join(CONFIG.paths.logs, `naukri-error-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      log('naukri', `ERROR: ${err.message}`);

      if (err.message.includes('2FA') || err.message.includes('Google login')) {
        await notifier.alertHumanIntervention('Naukri', err.message, screenshotPath);
      }
      return { success: false, error: err.message };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  getStats() {
    return getDayState('naukri');
  }
}

module.exports = new NaukriAdapter();

