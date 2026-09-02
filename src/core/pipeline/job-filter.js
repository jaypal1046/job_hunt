/**
 * JobFilter — Handles rule-based job filtering:
 * 1. Case-insensitive "Flutter" job title check
 * 2. Freshness filtering (Day 1 vs Day 2/Day 3 rules)
 */

class JobFilter {
  /**
   * Case-insensitive check if job title, description, skills, or card text contains "Flutter"
   */
  static isFlutterJob(target) {
    if (!target) return false;
    if (typeof target === 'string') {
      return /\bflutter\b/i.test(target);
    }

    const title = target.jobTitle || target.title || '';
    const desc = target.jobDescription || target.description || target.postingData?.description || target.postingData?.textContent || '';
    const skills = target.skills || target.postingData?.skills || '';

    const combinedText = `${title} ${desc} ${skills}`;
    return /\bflutter\b/i.test(combinedText);
  }

  /**
   * Evaluates age category of job (1, 2, or 3 days)
   * Returns integer day number: 1, 2, or 3
   */
  static getJobAgeDays(postingDateStr, postingTimestamp) {
    if (postingDateStr && typeof postingDateStr === 'string') {
      const str = postingDateStr.toLowerCase();
      if (str.includes('just now') || str.includes('hour') || str.includes('today') || str.includes('1 day') || str.includes('jobage=1')) {
        return 1;
      }
      if (str.includes('2 day') || str.includes('2 days')) {
        return 2;
      }
      if (str.includes('3 day') || str.includes('3 days') || str.includes('jobage=3')) {
        return 3;
      }
    }

    if (postingTimestamp) {
      const postMs = new Date(postingTimestamp).getTime();
      const diffHours = (Date.now() - postMs) / (1000 * 60 * 60);

      if (diffHours <= 24) return 1;
      if (diffHours <= 48) return 2;
      if (diffHours <= 72) return 3;
    }

    return 1; // Default to Day 1 if unspecified
  }

  /**
   * Evaluates whether a job passes freshness rules given historical scan state
   */
  static isFreshnessAllowed(job, historicalScanCompleted) {
    const ageDays = JobFilter.getJobAgeDays(job.postingDate, job.postingTimestamp);

    if (ageDays === 1) {
      return { allowed: true, reason: 'Day 1 Fresh Job' };
    }

    if (ageDays === 2 || ageDays === 3) {
      if (!historicalScanCompleted) {
        return { allowed: true, reason: `Day ${ageDays} Initial Historical Scan` };
      } else {
        return { allowed: false, reason: `Day ${ageDays} job skipped (Historical scan already completed)` };
      }
    }

    return { allowed: false, reason: 'Job older than 3 days' };
  }

  /**
   * Main evaluation method running both Flutter & Freshness checks
   */
  static evaluate(job, historicalScanCompleted = false) {
    // 1. Flutter Title & Description Check
    if (!JobFilter.isFlutterJob(job)) {
      return {
        passed: false,
        reason: `Title/Description for "${job.jobTitle || job.title}" does not contain "Flutter"`,
      };
    }

    // 2. Freshness Rule Check
    const freshness = JobFilter.isFreshnessAllowed(job, historicalScanCompleted);
    if (!freshness.allowed) {
      return {
        passed: false,
        reason: freshness.reason,
      };
    }

    return {
      passed: true,
      reason: freshness.reason,
    };
  }
}

module.exports = JobFilter;
