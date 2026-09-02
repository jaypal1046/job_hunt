/**
 * SessionManager — Stage 2 In-Memory Job List & Execution State Manager
 */
const SessionJob = require('../models/session-job');
const { SessionStatus } = require('../state/status-enum');

class SessionManager {
  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.startTime = new Date().toISOString();
    this.sessionJobs = new Map(); // key: uniqueKey -> SessionJob
    this.jobIdIndex = new Map(); // key: jobId -> uniqueKey
    this.canonicalUrlIndex = new Map(); // key: canonicalUrl -> uniqueKey
  }

  /**
   * Resets session state
   */
  reset() {
    this.sessionId = `session_${Date.now()}`;
    this.startTime = new Date().toISOString();
    this.sessionJobs.clear();
    this.jobIdIndex.clear();
    this.canonicalUrlIndex.clear();
  }

  /**
   * Adds job to current session
   */
  addJob(job, initialStatus = SessionStatus.FOUND, reason = null) {
    const sessionJob = job instanceof SessionJob ? job : new SessionJob(job, initialStatus, reason);
    if (!sessionJob.uniqueKey) return null;

    this.sessionJobs.set(sessionJob.uniqueKey, sessionJob);

    if (sessionJob.jobId) {
      this.jobIdIndex.set(String(sessionJob.jobId), sessionJob.uniqueKey);
    }

    if (sessionJob.canonicalUrl) {
      this.canonicalUrlIndex.set(sessionJob.canonicalUrl.toLowerCase(), sessionJob.uniqueKey);
    }

    return sessionJob;
  }

  /**
   * Updates status of job in current session
   */
  updateStatus(uniqueKey, status, reason = null) {
    const sessionJob = this.sessionJobs.get(uniqueKey);
    if (sessionJob) {
      sessionJob.setStatus(status, reason);
      return sessionJob;
    }
    return null;
  }

  /**
   * Search for job in session using identifiers
   */
  findInSession(identifiers = {}, excludeJob = null) {
    const { uniqueKey, jobId, canonicalUrl, rawUrl } = identifiers;

    if (uniqueKey && this.sessionJobs.has(uniqueKey)) {
      const match = this.sessionJobs.get(uniqueKey);
      if (match !== excludeJob) {
        return { found: true, job: match, matchedBy: 'uniqueKey' };
      }
    }

    if (jobId && this.jobIdIndex.has(String(jobId))) {
      const uKey = this.jobIdIndex.get(String(jobId));
      const match = this.sessionJobs.get(uKey);
      if (match !== excludeJob) {
        return { found: true, job: match, matchedBy: 'jobId' };
      }
    }

    const urlToTest = (canonicalUrl || rawUrl || '').toLowerCase().trim();
    if (urlToTest && this.canonicalUrlIndex.has(urlToTest)) {
      const uKey = this.canonicalUrlIndex.get(urlToTest);
      const match = this.sessionJobs.get(uKey);
      if (match !== excludeJob) {
        return { found: true, job: match, matchedBy: 'canonicalUrl' };
      }
    }

    return { found: false, job: null, matchedBy: null };
  }

  /**
   * Retrieves all jobs in session filtered by status
   */
  getJobsByStatus(status) {
    const results = [];
    for (const job of this.sessionJobs.values()) {
      if (job.sessionStatus === status) {
        results.push(job);
      }
    }
    return results;
  }

  /**
   * Returns current counts by status
   */
  getSummaryCounts() {
    const counts = {
      FOUND: 0,
      FILTERED: 0,
      ALREADY_APPLIED: 0,
      READY_TO_APPLY: 0,
      APPLYING: 0,
      APPLIED: 0,
      FAILED: 0,
      SKIPPED: 0,
    };

    for (const job of this.sessionJobs.values()) {
      if (counts.hasOwnProperty(job.sessionStatus)) {
        counts[job.sessionStatus]++;
      }
    }
    return counts;
  }

  /**
   * Returns full formatted execution report for the session
   */
  getExecutionReport() {
    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      endTime: new Date().toISOString(),
      totalJobsProcessed: this.sessionJobs.size,
      counts: this.getSummaryCounts(),
      jobs: Array.from(this.sessionJobs.values()).map((j) => j.toJSON()),
    };
  }
}

module.exports = SessionManager;
