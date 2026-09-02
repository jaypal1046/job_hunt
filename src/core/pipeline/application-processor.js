/**
 * ApplicationProcessor — Handles application execution for Direct Apply vs Company Page Apply.
 * Saves results to Stage 1 Local Database and updates Stage 2 Session state.
 */
const { SessionStatus, ApplicationType, ApplicationStatus } = require('../state/status-enum');
const externalApply = require('../../services/external-apply-service');
const notifier = require('../../services/notifier');
const { log, logApplication } = require('../../services/logger');

class ApplicationProcessor {
  constructor(localJobRepository, sessionManager) {
    this.localJobRepository = localJobRepository;
    this.sessionManager = sessionManager;
  }

  /**
   * Determines application type from raw job data
   */
  determineApplicationType(job) {
    const rawData = job.postingData || {};
    const isCompanySite = Boolean(rawData.isCompanySite) || Boolean(rawData.isExternal);
    return isCompanySite ? ApplicationType.COMPANY_PAGE : ApplicationType.DIRECT;
  }

  /**
   * Processes application for a single job
   * @param {Object} browserCtx Playwright context
   * @param {SessionJob} sessionJob Job to process
   * @param {Object} options Execution options ({ live: boolean, naukriAdapter: Object })
   */
  async processApplication(browserCtx, sessionJob, options = {}) {
    const isLive = options.live === true;
    const naukriAdapter = options.naukriAdapter || null;

    // Set Session Status: APPLYING
    this.sessionManager.updateStatus(sessionJob.uniqueKey, SessionStatus.APPLYING);

    const appType = this.determineApplicationType(sessionJob);
    sessionJob.applicationType = appType;

    log('naukri', `[ApplicationProcessor] Processing job "${sessionJob.jobTitle}" @ "${sessionJob.companyName}" | Type: ${appType.toUpperCase()}`);

    let success = false;
    let failureReason = null;

    try {
      if (appType === ApplicationType.COMPANY_PAGE) {
        // Company Page Apply
        log('naukri', `  📌 [Company Page Apply]: Logging redirect to external career portal -> ${sessionJob.url}`);
        externalApply.logExternalJob(
          'naukri',
          sessionJob.jobTitle,
          sessionJob.companyName,
          sessionJob.url,
          'Company Page Redirect'
        );
        success = true;
      } else {
        // Direct Apply on Naukri
        if (isLive && naukriAdapter && typeof naukriAdapter.applyDirectOnNaukri === 'function') {
          success = await naukriAdapter.applyDirectOnNaukri(browserCtx, sessionJob, isLive);
        } else {
          log('naukri', `  🔍 DRY_RUN — Simulated Direct Apply for: "${sessionJob.jobTitle}" @ "${sessionJob.companyName}"`);
          success = true;
        }
      }
    } catch (err) {
      log('naukri', `  ⚠ Application error on "${sessionJob.jobTitle}": ${err.message}`);
      success = false;
      failureReason = err.message;
    }

    if (success) {
      // 1. Update Session Status -> APPLIED
      sessionJob.isApplied = true;
      sessionJob.applicationStatus = ApplicationStatus.APPLIED;
      this.sessionManager.updateStatus(sessionJob.uniqueKey, SessionStatus.APPLIED, `Successfully processed (${appType})`);

      // 2. Persist to Stage 1 Local Database
      this.localJobRepository.saveJob({
        ...sessionJob.toJSON(),
        isApplied: true,
        applicationType: appType,
        applicationStatus: ApplicationStatus.APPLIED,
      });

      if (isLive) {
        logApplication('naukri', {
          title: sessionJob.jobTitle,
          company: sessionJob.companyName,
          salary: sessionJob.postingData?.salary || 'Not Disclosed',
          matchScore: sessionJob.postingData?.matchScore || '100%',
          link: sessionJob.url,
          jd: `${sessionJob.location} | Type: ${appType}`,
        });
        await notifier.notifyAppliedJob('naukri', sessionJob.jobTitle, sessionJob.companyName, sessionJob.url, sessionJob.postingData?.matchScore || 100);
      }
    } else {
      // Update Session Status -> FAILED
      sessionJob.isApplied = false;
      sessionJob.applicationStatus = ApplicationStatus.FAILED;
      this.sessionManager.updateStatus(sessionJob.uniqueKey, SessionStatus.FAILED, failureReason || 'Application failed');

      this.localJobRepository.saveJob({
        ...sessionJob.toJSON(),
        isApplied: false,
        applicationType: appType,
        applicationStatus: ApplicationStatus.FAILED,
      });
    }

    return success;
  }
}

module.exports = ApplicationProcessor;
