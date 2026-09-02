/**
 * Y Combinator (Work at a Startup) Auto-Apply Module — Integrated with 3-Stage Tracking System
 * Automated job search & application submission on Y Combinator Work at a Startup (workatastartup.com) using Playwright & Gemini AI.
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
const YCJobSource = require('../sources/yc-job-source');
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

class YCAdapter extends BaseAdapter {
  constructor() {
    super('yc');
    this.profileDir = path.join(CONFIG.paths.profiles, '.yc-chrome-profile');
    this.loginUrl = 'https://www.workatastartup.com/login';
    this.dailyCap = CONFIG.pacing.ycDailyCap || 20;

    this.localDb = new LocalJobRepository();
    this.jobSource = new YCJobSource();
    this.sessionMgr = new SessionManager();
    this.duplicateChecker = new DuplicateChecker(this.localDb, this.sessionMgr);
  }

  async login() {
    log('yc', 'Opening visible Chrome browser for manual Y Combinator Work at a Startup login...');
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log('yc', 'Please log into YC Work at a Startup in the browser window, then close the browser when done.');

    await new Promise((res) => ctx.on('close', res));
    log('yc', 'Login session saved to profile directory.');
  }

  async applyOnYCJobPage(ctx, job, isLive) {
    if (!isLive) {
      log('yc', `  🔍 DRY_RUN — would apply to YC startup "${job.jobTitle || job.title}" @ "${job.companyName || job.company}"`);
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
        log('yc', `  ⏭ Already applied on YC: "${job.jobTitle}" @ "${job.companyName}"`);
        return false;
      }

      const applySelectors = [
        'button:has-text("Apply")',
        'a:has-text("Apply")',
        'button:has-text("Apply to")',
        'a[href*="apply" i]',
        'button[class*="apply" i]',
        'a[class*="apply" i]',
        '[role="button"]:has-text("Apply")',
      ];

      let applyBtn = null;
      for (const sel of applySelectors) {
        const loc = jobPage.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          applyBtn = loc;
          break;
        }
      }

      if (!applyBtn) {
        log('yc', `  ⚠ Apply button not visible on YC page for "${job.jobTitle}" @ "${job.companyName}"`);
        return false;
      }

      await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
      await applyBtn.click().catch(async () => {
        await jobPage.evaluate(() => {
          const btn = document.querySelector('button[class*="apply"], a[href*="apply"], button:has-text("Apply")');
          if (btn) btn.click();
        });
      });
      await jobPage.waitForTimeout(2500);

      // Handle application form or modal
      const modal = jobPage.locator('[role="dialog"], [class*="modal" i], form, [class*="application" i]').first();
      if (await modal.isVisible().catch(() => false)) {
        const textareas = await modal.locator('textarea').all();
        if (textareas.length > 0) {
          const founderNote = await gemini.generateCoverLetter(job.jobTitle, job.companyName);
          await textareas[0].fill(founderNote);
          log('yc', `  ✍ YC founder note generated & filled for "${job.jobTitle}"`);
        }

        const submitBtn = modal.locator('button:has-text("Send"), button:has-text("Submit"), button:has-text("Apply"), input[type="submit"]').first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click().catch(async () => {
            await jobPage.evaluate(() => {
              const btn = document.querySelector('button[type="submit"], input[type="submit"]');
              if (btn) btn.click();
            });
          });
          await jobPage.waitForTimeout(3000);
          log('yc', `  ✅ YC application submitted for "${job.jobTitle}" @ "${job.companyName}"`);
          return true;
        }
      }

      log('yc', `  ✅ YC apply action completed for "${job.jobTitle}" @ "${job.companyName}"`);
      return true;
    } catch (err) {
      log('yc', `  ⚠ Error applying on YC job "${job.jobTitle}": ${err.message}`);
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

    const dayState = getDayState('yc');
    const targetCount = this.dailyCap - dayState.count;

    if (targetCount <= 0) {
      log('yc', `Daily cap of ${this.dailyCap} reached today (${dayState.count} sent). Exiting.`);
      return { success: true, count: dayState.count };
    }

    this.sessionMgr.reset();

    log('yc', `================================================================`);
    log('yc', `🚀 Starting Y Combinator Auto-Apply Cycle (Target: ${targetCount} applications, Mode: ${isLive ? 'LIVE' : 'DRY RUN'})`);
    log('yc', `📌 Stage 1 Local DB Loaded (${this.localDb.getRecordCount()} records)`);
    log('yc', `================================================================`);

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
          log('yc', 'CAPTCHA / Cloudflare verification detected on YC Work at a Startup!');
          const screenshotPath = path.join(CONFIG.paths.logs, `yc-captcha-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath }).catch(() => {});
          await notifier.alertHumanIntervention('Y Combinator', 'Captcha or Bot Verification triggered', screenshotPath);
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
            log('yc', `  ⏭ [FILTERED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${filterResult.reason}`);
            continue;
          }

          // Duplicate Detection Check (Session & Local DB)
          const dupResult = this.duplicateChecker.checkDuplicate(sessionJob);
          if (dupResult.isDuplicate) {
            const reason = `Already processed in ${dupResult.source} (matched by ${dupResult.matchedBy})`;
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.ALREADY_APPLIED, reason);
            log('yc', `  ⏭ [ALREADY_APPLIED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${reason}`);
            continue;
          }

          // Gemini AI Suitability Evaluation
          const evalResult = await gemini.evaluateJobSuitability(sessionJob.jobTitle, sessionJob.companyName, sessionJob.jobDescription);
          log('yc', `  ▶ Gemini AI Evaluation: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" | Match Score: ${evalResult.score}%`);

          if (evalResult.apply) {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.READY_TO_APPLY);

            const ok = await this.applyOnYCJobPage(ctx, sessionJob, isLive);
            if (ok || !isLive) {
              this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.APPLIED);
              this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: true, applicationStatus: 'APPLIED' });
              recordAction('yc', {
                key: sessionJob.uniqueKey,
                title: sessionJob.jobTitle,
                company: sessionJob.companyName,
                link: sessionJob.url,
                type: 'YC Direct Apply',
                matchScore: evalResult.score,
              }, true);

              if (isLive) {
                logApplication('yc', {
                  title: sessionJob.jobTitle,
                  company: sessionJob.companyName,
                  matchScore: evalResult.score,
                  link: sessionJob.url,
                });
                await notifier.notifyAppliedJob('yc', sessionJob.jobTitle, sessionJob.companyName, sessionJob.url, evalResult.score);
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
      log('yc', `================================================================`);
      log('yc', `📊 Y Combinator Execution Report Summary: Total=${report.totalJobsProcessed}, Applied=${report.counts.APPLIED}, Filtered=${report.counts.FILTERED}, Skipped=${report.counts.ALREADY_APPLIED}`);
      log('yc', `================================================================`);

      return { success: true, count: submittedCount };
    } catch (err) {
      log('yc', `ERROR: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  getStats() {
    return getDayState('yc');
  }
}

module.exports = new YCAdapter();
