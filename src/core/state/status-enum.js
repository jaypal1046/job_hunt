/**
 * Status Enums for Job Application Tracking System
 */

const SessionStatus = Object.freeze({
  FOUND: 'FOUND',
  FILTERED: 'FILTERED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  READY_TO_APPLY: 'READY_TO_APPLY',
  APPLYING: 'APPLYING',
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

const ApplicationType = Object.freeze({
  DIRECT: 'direct',
  COMPANY_PAGE: 'company_page',
});

const ApplicationStatus = Object.freeze({
  APPLIED: 'APPLIED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

module.exports = {
  SessionStatus,
  ApplicationType,
  ApplicationStatus,
};
