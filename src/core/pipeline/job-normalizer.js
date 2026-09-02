/**
 * JobNormalizer — Normalizes raw Naukri job cards/objects into standard Job instances.
 * Computes canonical URLs, extracts Naukri job IDs, and generates deterministic unique keys.
 */
const crypto = require('crypto');
const Job = require('../models/job');

class JobNormalizer {
  /**
   * Extracts Naukri numeric job ID from URL or key string
   * Example: https://www.naukri.com/job-listings-flutter-developer-zensar-260826012624 -> "260826012624"
   */
  static extractNaukriJobId(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const match = rawUrl.match(/[-_](\d{8,15})(?:\?|$)/) || rawUrl.match(/(\d{10,15})/);
    return match ? match[1] : null;
  }

  /**
   * Cleans URL by stripping search params, tracking tokens, and anchor hashes
   */
  static normalizeCanonicalUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl);
      parsed.search = ''; // Strip search query parameters
      parsed.hash = ''; // Strip hash anchors
      let href = parsed.toString();
      if (href.endsWith('/')) {
        href = href.slice(0, -1);
      }
      return href;
    } catch {
      return rawUrl.split('?')[0].split('#')[0].replace(/\/$/, '');
    }
  }

  /**
   * Generates deterministic SHA256 hash fallback identifier
   */
  static generateDeterministicHash(title, company, location, canonicalUrl) {
    const normTitle = (title || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const normCompany = (company || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const normLoc = (location || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const normUrl = (canonicalUrl || '').toLowerCase().trim();

    const rawString = `${normTitle}|${normCompany}|${normLoc}|${normUrl}`;
    return 'hash_' + crypto.createHash('sha256').update(rawString).digest('hex').substring(0, 16);
  }

  /**
   * Determines the strongest unique key available
   * Order:
   * 1. Naukri jobId
   * 2. Canonical job URL
   * 3. Stable identifier from raw posting data
   * 4. Deterministic hash fallback
   */
  static determineUniqueKey(jobId, canonicalUrl, rawData = {}, title = '', company = '', location = '') {
    if (jobId) {
      return `naukri_id_${jobId}`;
    }
    if (canonicalUrl && canonicalUrl.startsWith('http')) {
      return `url_${JobNormalizer.normalizeCanonicalUrl(canonicalUrl)}`;
    }
    if (rawData && (rawData.id || rawData.uniqueId)) {
      return `id_${rawData.id || rawData.uniqueId}`;
    }
    return JobNormalizer.generateDeterministicHash(title, company, location, canonicalUrl);
  }

  /**
   * Main normalization method converting raw card into Job model
   */
  static normalize(rawCard) {
    const title = rawCard.title || rawCard.jobTitle || '';
    const company = rawCard.company || rawCard.companyName || '';
    const location = rawCard.location || '';
    const rawUrl = rawCard.link || rawCard.url || '';
    const postingDate = rawCard.postingDate || rawCard.experience || 'Just now';

    const jobId = JobNormalizer.extractNaukriJobId(rawUrl) || rawCard.jobId || null;
    const canonicalUrl = JobNormalizer.normalizeCanonicalUrl(rawUrl);
    const uniqueKey = JobNormalizer.determineUniqueKey(jobId, canonicalUrl, rawCard, title, company, location);

    const description = rawCard.description || rawCard.jobDescription || rawCard.snippet || rawCard.textContent || '';

    const isCompanySite = Boolean(rawCard.isCompanySite);
    const applicationType = isCompanySite ? 'company_page' : 'direct';

    return new Job({
      jobId,
      url: rawUrl,
      canonicalUrl,
      jobTitle: title,
      companyName: company,
      location,
      postingDate,
      postingTimestamp: Job.parsePostingDateToIso(postingDate),
      jobDescription: description,
      postingData: rawCard,
      uniqueKey,
      isApplied: false,
      applicationType,
      applicationStatus: 'PENDING',
    });
  }
}

module.exports = JobNormalizer;
