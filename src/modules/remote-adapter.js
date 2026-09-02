/**
 * Unified Remote & Startup Jobs Adapter — Integrated with 3-Stage Tracking System
 * Auto-retrieves & applies to jobs across:
 * 1. Startup.jobs (https://startup.jobs/?q=Flutter&since=30d)
 * 2. RemoteOK (https://remoteok.com/remote-flutter-jobs)
 * 3. We Work Remotely (https://weworkremotely.com/remote-jobs/search?term=Flutter)
 * 4. Himalayas (https://himalayas.app/jobs/countries/india?q=Flutter&sort=recent)
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
const RemoteJobSource = require('../sources/remote-job-source');
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

class RemoteAdapter extends BaseAdapter {
  constructor() {
    super('remote');
    this.profileDir = path.join(CONFIG.paths.profiles, '.remote-chrome-profile');
    this.dailyCap = CONFIG.pacing.remoteDailyCap || 30;

    this.localDb = new LocalJobRepository();
    this.jobSource = new RemoteJobSource();
    this.sessionMgr = new SessionManager();
    this.duplicateChecker = new DuplicateChecker(this.localDb, this.sessionMgr);
  }

  async processRemoteJobPage(ctx, sessionJob, sourceName, isLive) {
    log('remote', `  📌 [${sourceName} Redirect Logged]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${sessionJob.url}`);
    externalApply.logExternalJob(
      'remote',
      sessionJob.jobTitle,
      sessionJob.companyName,
      sessionJob.url,
      `${sourceName} External Link`
    );
    return true;
  }

  async run(options = {}) {
    const isLive = options.live === true;
    const dayState = getDayState('remote');
    const targetCount = this.dailyCap - dayState.count;

    if (targetCount <= 0) {
      log('remote', `Daily cap of ${this.dailyCap} reached today (${dayState.count} sent). Exiting.`);
      return { success: true, count: dayState.count };
    }

    this.sessionMgr.reset();

    log('remote', `================================================================`);
    log('remote', `🚀 Starting Multi-Source Remote Job Pipeline (Target: ${targetCount} jobs, Mode: ${isLive ? 'LIVE' : 'DRY RUN'})`);
    log('remote', `📌 Stage 1 Local DB Loaded (${this.localDb.getRecordCount()} records)`);
    log('remote', `================================================================`);

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
    let totalProcessed = 0;

    try {
      for (const src of this.jobSource.sources) {
        if (totalProcessed >= targetCount) break;

        const rawCards = await this.jobSource.fetchRawCardsFromSource(page, src);
        if (rawCards.length === 0) continue;

        for (const rawCard of rawCards) {
          if (totalProcessed >= targetCount) break;

          const job = JobNormalizer.normalize(rawCard);
          const sessionJob = this.sessionMgr.addJob(job, SessionStatus.FOUND);

          // Flutter Title, Description & Skill Filter
          const filterResult = JobFilter.evaluate(sessionJob, true);
          if (!filterResult.passed) {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.FILTERED, filterResult.reason);
            this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: false, applicationStatus: 'FILTERED' });
            log('remote', `  ⏭ [FILTERED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${filterResult.reason}`);
            continue;
          }

          // Duplicate Detection (Session & Stage 1 Local DB)
          const dupResult = this.duplicateChecker.checkDuplicate(sessionJob);
          if (dupResult.isDuplicate) {
            const reason = `Already processed in ${dupResult.source} (matched by ${dupResult.matchedBy})`;
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.ALREADY_APPLIED, reason);
            log('remote', `  ⏭ [ALREADY_APPLIED]: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" -> ${reason}`);
            continue;
          }

          // Gemini AI Evaluation
          const evalResult = await gemini.evaluateJobSuitability(sessionJob.jobTitle, sessionJob.companyName, sessionJob.jobDescription);
          log('remote', `  ▶ Gemini AI Evaluation: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" | Match Score: ${evalResult.score}%`);

          if (evalResult.apply) {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.READY_TO_APPLY);

            const ok = await this.processRemoteJobPage(ctx, sessionJob, src.name, isLive);
            if (ok || !isLive) {
              this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.APPLIED);
              this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: true, applicationType: 'company_page', applicationStatus: 'APPLIED' });
              recordAction('remote', {
                key: sessionJob.uniqueKey,
                title: sessionJob.jobTitle,
                company: sessionJob.companyName,
                link: sessionJob.url,
                type: `${src.name} External Link`,
                matchScore: evalResult.score,
              }, true);

              if (isLive) {
                logApplication('remote', {
                  title: sessionJob.jobTitle,
                  company: sessionJob.companyName,
                  matchScore: evalResult.score,
                  link: sessionJob.url,
                  jd: `Source: ${src.name}`,
                });
                await notifier.notifyAppliedJob('remote', sessionJob.jobTitle, sessionJob.companyName, sessionJob.url, evalResult.score);
              }
              totalProcessed++;
            }
            await page.waitForTimeout(2000);
          } else {
            this.sessionMgr.updateStatus(sessionJob.uniqueKey, SessionStatus.FILTERED, `Gemini score ${evalResult.score}% below threshold`);
            this.localDb.saveJob({ ...sessionJob.toJSON(), isApplied: false, applicationStatus: 'FILTERED' });
          }
        }
      }

      const report = this.sessionMgr.getExecutionReport();
      log('remote', `================================================================`);
      log('remote', `📊 Remote Job Pipeline Execution Report Summary: Total=${report.totalJobsProcessed}, Processed=${report.counts.APPLIED}, Filtered=${report.counts.FILTERED}, Skipped=${report.counts.ALREADY_APPLIED}`);
      log('remote', `================================================================`);

      return { success: true, count: totalProcessed };
    } catch (err) {
      log('remote', `ERROR: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  getStats() {
    return getDayState('remote');
  }
}

module.exports = new RemoteAdapter();
