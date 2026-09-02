const Job = require('./job');
const { SessionStatus } = require('../state/status-enum');

/**
 * SessionJob represents a job in Stage 2 (Current Session).
 */
class SessionJob extends Job {
  constructor(jobData = {}, sessionStatus = SessionStatus.FOUND, statusReason = null) {
    super(jobData);
    this.sessionStatus = sessionStatus;
    this.statusReason = statusReason;
    this.processedAt = new Date().toISOString();
    this.attempts = 0;
  }

  setStatus(status, reason = null) {
    this.sessionStatus = status;
    if (reason !== null) {
      this.statusReason = reason;
    }
    this.updatedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      sessionStatus: this.sessionStatus,
      statusReason: this.statusReason,
      processedAt: this.processedAt,
      attempts: this.attempts,
    };
  }
}

module.exports = SessionJob;
