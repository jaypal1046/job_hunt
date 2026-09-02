/**
 * DuplicateChecker — 4-stage waterfall duplicate detection logic.
 * Checks against both Stage 2 (Current Session) and Stage 1 (Local Database).
 */
const JobNormalizer = require('./job-normalizer');

class DuplicateChecker {
  constructor(localJobRepository, sessionManager) {
    this.localJobRepository = localJobRepository;
    this.sessionManager = sessionManager;
  }

  /**
   * Generates or retrieves unique job key using waterfall strategy
   */
  generateUniqueKey(job) {
    if (job.uniqueKey) return job.uniqueKey;

    const jobId = job.jobId || JobNormalizer.extractNaukriJobId(job.url || job.canonicalUrl);
    const canonicalUrl = job.canonicalUrl || JobNormalizer.normalizeCanonicalUrl(job.url);

    return JobNormalizer.determineUniqueKey(
      jobId,
      canonicalUrl,
      job.postingData,
      job.jobTitle,
      job.companyName,
      job.location
    );
  }

  /**
   * Checks if job is duplicate in current session or local database
   */
  checkDuplicate(job) {
    const uniqueKey = this.generateUniqueKey(job);
    const jobId = job.jobId || JobNormalizer.extractNaukriJobId(job.url || job.canonicalUrl);
    const canonicalUrl = job.canonicalUrl || JobNormalizer.normalizeCanonicalUrl(job.url);
    const rawUrl = job.url;

    // 1. Check Stage 2: Current Session
    const sessionCheck = this.sessionManager.findInSession({ uniqueKey, jobId, canonicalUrl, rawUrl }, job);
    if (sessionCheck.found) {
      return {
        isDuplicate: true,
        source: 'SESSION',
        matchedBy: sessionCheck.matchedBy,
        existingJob: sessionCheck.job,
        uniqueKey,
      };
    }

    // 2. Check Stage 1: Local Database
    const dbCheck = this.localJobRepository.isJobProcessedOrApplied({ uniqueKey, jobId, canonicalUrl, rawUrl });
    if (dbCheck.found) {
      return {
        isDuplicate: true,
        source: 'LOCAL_DATABASE',
        matchedBy: dbCheck.matchedBy,
        existingJob: dbCheck.job,
        uniqueKey,
      };
    }

    return {
      isDuplicate: false,
      source: null,
      matchedBy: null,
      existingJob: null,
      uniqueKey,
    };
  }
}

module.exports = DuplicateChecker;
