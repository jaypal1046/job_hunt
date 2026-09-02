/**
 * Wellfound Auto-Apply Module — Integrated with 3-Stage Tracking System
 * Automated job search & application submission on Wellfound (AngelList Jobs) using Playwright & Gemini AI.
 */
const path = require('path');
const fs = require('fs');
const BaseAdapter = require('./base-adapter');
const CONFIG = require('../../config');
const { log, logApplication, getDayState, recordAction } = require('../services/logger');
const gemini = require('../services/gemini');
const notifier = require('../services/notifier');
const externalApply = require('../services/external-apply-service');

const LocalJobRepository = require('../repositories/local-job-repository');
const WellfoundJobSource = require('../sources/wellfound-job-source');
const JobNormalizer = require('../core/pipeline/job-normalizer');
const JobFilter = require('../core/pipeline/job-filter');
const DuplicateChecker = require('../core/pipeline/duplicate-checker');
const SessionManager = require('../core/pipeline/session-manager');
const { SessionStatus, ApplicationType } = require('../core/state/status-enum');

let chromium;
try {
  const { addExtra } = require('playwright-extra');
  chromium = addExtra(require('playwright-core').chromium);
  chromium.use(require('puppeteer-extra-plugin-stealth')());
} catch (e) {
  ({ chromium } = require('playwright-core'));
}

class WellfoundAdapter extends BaseAdapter {
  constructor() {
    super('wellfound');
    this.profileDir = path.join(CONFIG.paths.profiles, '.wellfound-chrome-profile');
    this.loginUrl = 'https://wellfound.com/login';
    this.dailyCap = CONFIG.pacing.wellfoundDailyCap;

    this.localDb = new LocalJobRepository();
    this.scanStateRepo = null;
    this.jobSource = new WellfoundJobSource();
    this.sessionMgr = new SessionManager();
    this.duplicateChecker = new DuplicateChecker(this.localDb, this.sessionMgr);
  }

  async login() {
    log('wellfound', 'Opening visible Chrome browser for manual Wellfound login...');
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log('wellfound', 'Please log in to Wellfound in the browser window, then close the browser when done.');

    await new Promise((res) => ctx.on('close', res));
    log('wellfound', 'Login session saved to profile directory.');
  }

  async applyOnJobPage(ctx, job, isLive) {
    if (!isLive) {
      log('wellfound', `  🔍 DRY_RUN — would click Apply on "${job.jobTitle || job.title}" @ "${job.companyName || job.company}"`);
      return true;
    }

    let jobPage = null;
    try {
      jobPage = await ctx.newPage();
      const link = job.url || job.link;
      await jobPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await jobPage.waitForTimeout(3000);

      const pageText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');
      if (/applied/i.test(pageText)) {
        log('wellfound', `  ⏭ Already applied on Wellfound: "${job.jobTitle}" @ "${job.companyName}"`);
        return false;
      }

      const applyBtn = jobPage.locator('button:has-text("Apply"), a:has-text("Apply"), button[class*="apply" i]').first();
      if (!(await applyBtn.isVisible().catch(() => false))) {
        log('wellfound', `  ⚠ Apply button not visible on page for "${job.jobTitle}" @ "${job.companyName}"`);
        return false;
      }

      await applyBtn.click().catch(() => {});
      await jobPage.waitForTimeout(2500);

      // Handle application modal (cover letter & questions)
      const modal = jobPage.locator('[role="dialog"], [class*="modal" i]').first();
      if (await modal.isVisible().catch(() => false)) {
        const textareas = await modal.locator('textarea').all();
        if (textareas.length > 0) {
          const coverLetter = await gemini.generateCoverLetter(job.jobTitle, job.companyName);
          await textareas[0].fill(coverLetter);
          log('wellfound', `  ✍ Cover letter generated & filled for "${job.jobTitle}"`);
        }

        const sendBtn = modal.locator('button:has-text("Send"), button:has-text("Submit"), button:has-text("Apply")').first();
        if (await sendBtn.isVisible().catch(() => false)) {
          await sendBtn.click();
          await jobPage.waitForTimeout(3000);
          log('wellfound', `  ✅ Application submitted on Wellfound for "${job.jobTitle}" @ "${job.companyName}"`);
          return true;
        }
      }

      log('wellfound', `  ✅ Apply action completed for "${job.jobTitle}" @ "${job.companyName}"`);
      return true;
    } catch (err) {
      log('wellfound', `  ⚠ Error applying on "${job.jobTitle}": ${err.message}`);
      return false;
    } finally {
      if (jobPage && !jobPage.isClosed()) {
        await jobPage.close().catch(() => {});
      }
    }
  }

  async run(options = {}) {
    const isLive = options.live === true;
    const isLogin = options.login === true;

    if (isLogin) {
      return await this.login();
    }

    const dayState = getDayState('wellfound');
    const targetCount = this.dailyCap - dayState.count;

    if (targetCount <= 0) {
      log('wellfound', `Daily cap of ${this.dailyCap} already reached today (${dayState.count} sent). Exiting.`);
      return { success: true, count: dayState.count };
    }

    this.sessionMgr.reset();

    log('wellfound', `================================================================`);
    log('wellfound', `🚀 Starting Wellfound Auto-Apply Cycle (Target: ${targetCount} applications, Mode: ${isLive ? 'LIVE' : 'DRY RUN'})`);
    log('wellfound', `📌 Stage 1 Local DB Loaded (${this.localDb.getRecordCount()} records)`);
    log('wellfound', `================================================================`);

    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
      ],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    let submittedCount = 0;

    try {
      for (const searchUrl of this.jobSource.searchUrls) {
        if (submittedCount >= targetCount) break;

        const rawCards = await this.jobSource.fetchRawCards(page, searchUrl);
        if (rawCards.length === 0) continue;

        const bodyText = await page.evaluate('document.body.innerText.slice(0, 2000)').catch(() => '');
        if (/verify you are human|captcha|cloudflare/i.test(bodyText)) {
          log('wellfound', 'CAPTCHA / DataDome verification detected!');
          const screenshotPath = path.join(CONFIG.paths.logs, `wellfound-captcha-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath }).catch(() => {});
          await notifier.alertHumanIntervention('Wellfound', 'Captcha or Bot Verification triggered', screenshotPath);
          return { success: false, error: 'Captcha triggered' };
        }

        for (const rawCard of rawCards) {
          if (submittedCount >= targetCount) break;

          const job = JobNormalizer.normalize(rawCard);
          const sessionJob = this.sessionMgr.addJob(job, SessionStatus.FOUND);

          // Flutter & Keyword Filter
          const filterResult = JobFilter.evaluate(sessionJob, true);
          if (!filterResult.passed) {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.FILTERED, filterResult.reason);
            this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: false, applicationStatus: 'FILTERED' });
            log('wellfound', `  ⏭ [FILTERED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${filterResult.reason}`);
            continue;
          }

          // Duplicate Detection Check (Session & Local DB)
          const dupResult = this.duplicateChecker.checkDuplicate(sessionJob);
          if (dupResult.isDuplicate) {
            const reason = `Already processed in ${dupResult.source} (matched by ${dupResult.matchedBy})`;
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.ALREADY_APPLIED, reason);
            log('wellfound', `  ⏭ [ALREADY_APPLIED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${reason}`);
            continue;
          }

          // Gemini AI Suitability Evaluation
          const evalResult = await gemini.evaluateJobSuitability(sessionJob.jobTitle, sessionJob.companyName, sessionJob.jobDescription);
          log('wellfound', `  ▶ Gemini AI Evaluation: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" | Match Score: ${evalResult.score}%`);

          if (evalResult.apply) {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.READY_TO_APPLY);

            const ok = await this.applyOnJobPage(ctx, sessionJob, isLive);
            if (ok || !isLive) {
              this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.APPLIED);
              this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: true, applicationStatus: 'APPLIED' });
              recordAction('wellfound', {
                key: sessionJob.uniqueKey,
                title: sessionJob.jobTitle,
                company: sessionJob.companyName,
                link: sessionJob.url,
                type: '1-Click Direct Apply',
                matchScore: evalResult.score,
              }, true);

              if (isLive) {
                logApplication('wellfound', {
                  title: sessionJob.jobTitle,
                  company: sessionJob.companyName,
                  matchScore: evalResult.score,
                  link: sessionJob.url,
                });
                await notifier.notifyAppliedJob('wellfound', sessionJob.jobTitle, sessionJob.companyName, sessionJob.url, evalResult.score);
              }
              submittedCount++;
            } else {
              this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.FAILED, 'Application failed on page');
              this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: false, applicationStatus: 'FAILED' });
            }
            await page.waitForTimeout(3000);
          } else {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.FILTERED, `Gemini score ${evalResult.score}% below threshold`);
            this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: false, applicationStatus: 'FILTERED' });
          }
        }
      }

      const report = this.sessionMgr.getExecutionReport();
      log('wellfound', `================================================================`);
      log('wellfound', `📊 Wellfound Execution Report Summary: Total=${report.totalJobsProcessed}, Applied=${report.counts.APPLIED}, Filtered=${report.counts.FILTERED}, Skipped=${report.counts.ALREADY_APPLIED}`);
      log('wellfound', `================================================================`);

      return { success: true, count: submittedCount };
    } catch (err) {
      log('wellfound', `ERROR: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  getStats() {
    return getDayState('wellfound');
  }
}

module.exports = new WellfoundAdapter();
