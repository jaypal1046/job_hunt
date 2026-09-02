/**
 * Core Job Model representing a job post across all system stages.
 */
class Job {
  constructor(data = {}) {
    this.jobId = data.jobId || null;
    this.url = data.url || '';
    this.canonicalUrl = data.canonicalUrl || data.url || '';
    this.jobTitle = data.jobTitle || data.title || '';
    this.companyName = data.companyName || data.company || '';
    this.location = data.location || '';
    this.postingDate = data.postingDate || '';
    this.postingTimestamp = data.postingTimestamp || (data.postingDate ? Job.parsePostingDateToIso(data.postingDate) : new Date().toISOString());
    this.jobDescription = data.jobDescription || data.description || '';
    this.postingData = data.postingData || {};
    this.uniqueKey = data.uniqueKey || '';
    this.isApplied = Boolean(data.isApplied);
    this.applicationType = data.applicationType || null; // 'direct' | 'company_page'
    this.applicationStatus = data.applicationStatus || 'PENDING';
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  /**
   * Helper to convert relative posting dates into ISO strings
   * Examples: "5 hours ago", "1 day ago", "2 days ago", "3 days ago", "Just now"
   */
  static parsePostingDateToIso(postingDateStr) {
    if (!postingDateStr || typeof postingDateStr !== 'string') {
      return new Date().toISOString();
    }

    const str = postingDateStr.toLowerCase().trim();
    const now = new Date();

    if (str.includes('just now') || str.includes('few hours') || str.includes('today')) {
      return now.toISOString();
    }

    const hoursMatch = str.match(/(\d+)\s*hour/);
    if (hoursMatch) {
      const hours = parseInt(hoursMatch[1], 10);
      return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    }

    const daysMatch = str.match(/(\d+)\s*day/);
    if (daysMatch) {
      const days = parseInt(daysMatch[1], 10);
      return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    }

    const dateParsed = Date.parse(postingDateStr);
    if (!isNaN(dateParsed)) {
      return new Date(dateParsed).toISOString();
    }

    return now.toISOString();
  }

  /**
   * Serializes job instance for persistence or transmission
   */
  toJSON() {
    return {
      jobId: this.jobId,
      url: this.url,
      canonicalUrl: this.canonicalUrl,
      jobTitle: this.jobTitle,
      companyName: this.companyName,
      location: this.location,
      postingDate: this.postingDate,
      postingTimestamp: this.postingTimestamp,
      jobDescription: this.jobDescription,
      postingData: this.postingData,
      uniqueKey: this.uniqueKey,
      isApplied: this.isApplied,
      applicationType: this.applicationType,
      applicationStatus: this.applicationStatus,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = Job;
