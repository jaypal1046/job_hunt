/**
 * LocalJobRepository — Stage 1 Local Database (Source of Truth)
 * Handles persistent storage, lookup indexing, duplicate detection, and 30-day automated cleanup.
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('../../config');
const Job = require('../core/models/job');

class LocalJobRepository {
  constructor(dbPath = null) {
    this.dbDir = CONFIG.paths.logs || path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.dbDir)) {
      fs.mkdirSync(this.dbDir, { recursive: true });
    }

    this.dbPath = dbPath || path.join(this.dbDir, 'jobs_database.json');
    this.jobsMap = new Map(); // key: uniqueKey -> Job instance
    this.jobIdIndex = new Map(); // key: jobId -> uniqueKey
    this.canonicalUrlIndex = new Map(); // key: canonicalUrl -> uniqueKey

    this.init();
  }

  /**
   * Initializes database and triggers 30-day retention cleanup
   */
  init() {
    this.loadFromDisk();
    this.seedFromExistingLogs();
    this.cleanupOlderThan(30);
  }

  /**
   * Loads existing jobs database from disk into memory maps & indices
   */
  loadFromDisk() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        const data = JSON.parse(raw);

        if (Array.isArray(data.jobs)) {
          for (const rawJob of data.jobs) {
            const job = new Job(rawJob);
            this.indexJobInMemory(job);
          }
        }
      }
    } catch (err) {
      console.error(`[LocalJobRepository] Error reading DB file ${this.dbPath}:`, err.message);
    }
  }

  /**
   * Indexes a Job object in memory for fast lookup
   */
  indexJobInMemory(job) {
    if (!job.uniqueKey) return;
    this.jobsMap.set(job.uniqueKey, job);

    if (job.jobId) {
      this.jobIdIndex.set(String(job.jobId), job.uniqueKey);
    }

    if (job.canonicalUrl) {
      this.canonicalUrlIndex.set(job.canonicalUrl.toLowerCase(), job.uniqueKey);
    }
  }

  /**
   * Saves memory state atomically to disk
   */
  persistToDisk() {
    try {
      const jobsArray = Array.from(this.jobsMap.values()).map((job) => job.toJSON());
      const payload = {
        updatedAt: new Date().toISOString(),
        totalCount: jobsArray.length,
        jobs: jobsArray,
      };

      const tmpPath = `${this.dbPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.dbPath);
    } catch (err) {
      console.error(`[LocalJobRepository] Failed to save DB to disk: ${err.message}`);
    }
  }

  /**
   * Seeds DB from existing CSV/naukri_history.json if present
   */
  seedFromExistingLogs() {
    try {
      const historyFile = path.join(this.dbDir, 'naukri_history.json');
      if (fs.existsSync(historyFile)) {
        const historyData = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        if (historyData && Array.isArray(historyData.jobs)) {
          for (const item of historyData.jobs) {
            if (!item.key && !item.link) continue;
            const uniqueKey = item.key || item.link;

            if (!this.jobsMap.has(uniqueKey)) {
              const job = new Job({
                uniqueKey,
                jobId: item.jobId || null,
                url: item.link || item.key,
                canonicalUrl: item.link || item.key,
                jobTitle: item.title || 'Seeded Job',
                companyName: item.company || 'Naukri Employer',
                isApplied: true,
                applicationType: item.type && item.type.includes('Company') ? 'company_page' : 'direct',
                applicationStatus: 'APPLIED',
                createdAt: item.date ? new Date(item.date).toISOString() : new Date().toISOString(),
              });
              this.indexJobInMemory(job);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[LocalJobRepository] Error seeding from history: ${err.message}`);
    }
  }

  /**
   * Automatic Data Retention Policy: Deletes records older than retentionDays (default: 30 days)
   */
  cleanupOlderThan(retentionDays = 30) {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    for (const [uniqueKey, job] of this.jobsMap.entries()) {
      const createdAtMs = new Date(job.createdAt).getTime();
      if (createdAtMs < cutoffMs) {
        this.jobsMap.delete(uniqueKey);
        if (job.jobId && this.jobIdIndex.get(String(job.jobId)) === uniqueKey) {
          this.jobIdIndex.delete(String(job.jobId));
        }
        if (job.canonicalUrl && this.canonicalUrlIndex.get(job.canonicalUrl.toLowerCase()) === uniqueKey) {
          this.canonicalUrlIndex.delete(job.canonicalUrl.toLowerCase());
        }
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      this.persistToDisk();
    }
    return deletedCount;
  }

  /**
   * Find job by uniqueKey
   */
  findByUniqueKey(uniqueKey) {
    if (!uniqueKey) return null;
    return this.jobsMap.get(uniqueKey) || null;
  }

  /**
   * Find job by jobId
   */
  findByJobId(jobId) {
    if (!jobId) return null;
    const uniqueKey = this.jobIdIndex.get(String(jobId));
    return uniqueKey ? this.findByUniqueKey(uniqueKey) : null;
  }

  /**
   * Find job by canonical URL
   */
  findByCanonicalUrl(url) {
    if (!url) return null;
    const canonical = url.toLowerCase().trim();
    const uniqueKey = this.canonicalUrlIndex.get(canonical);
    return uniqueKey ? this.findByUniqueKey(uniqueKey) : null;
  }

  /**
   * Checks if job exists in Local Database using any available identifier
   */
  isJobProcessedOrApplied(identifiers = {}) {
    const { uniqueKey, jobId, canonicalUrl, rawUrl } = identifiers;

    if (jobId) {
      const existing = this.findByJobId(jobId);
      if (existing) return { found: true, job: existing, matchedBy: 'jobId' };
    }

    if (canonicalUrl || rawUrl) {
      const existing = this.findByCanonicalUrl(canonicalUrl || rawUrl);
      if (existing) return { found: true, job: existing, matchedBy: 'canonicalUrl' };
    }

    if (uniqueKey) {
      const existing = this.findByUniqueKey(uniqueKey);
      if (existing) return { found: true, job: existing, matchedBy: 'uniqueKey' };
    }

    return { found: false, job: null, matchedBy: null };
  }

  /**
   * Save or update job in Stage 1 database
   */
  saveJob(jobData) {
    const job = jobData instanceof Job ? jobData : new Job(jobData);
    job.updatedAt = new Date().toISOString();

    this.indexJobInMemory(job);
    this.persistToDisk();
    return job;
  }

  /**
   * Returns total count of stored records
   */
  getRecordCount() {
    return this.jobsMap.size;
  }
}

module.exports = LocalJobRepository;
