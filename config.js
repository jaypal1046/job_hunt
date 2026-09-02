/**
 * Centralized Configuration Loader
 * Parses environment variables from `.env` and exports structured configuration objects.
 */
const path = require('path');
const fs = require('fs');

// Load environment variables from .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    require('dotenv').config({ path: envPath });
  } catch (e) {
    // dotenv not installed yet
  }
} else {
  // If .env doesn't exist, try copying .env.example
  const examplePath = path.join(__dirname, '.env.example');
  if (fs.existsSync(examplePath)) {
    console.log('[CONFIG] .env file not found, creating from .env.example');
    fs.copyFileSync(examplePath, envPath);
    try {
      require('dotenv').config({ path: envPath });
    } catch (e) {}
  }
}

const env = process.env;

const CONFIG = {
  // Auth & Account
  creds: {
    googleEmail: env.GOOGLE_EMAIL || '',
    googlePassword: env.GOOGLE_PASSWORD || '',
    naukriProfileUrl: env.NAUKRI_PROFILE_URL || 'https://www.naukri.com/mnjuser/profile',
  },

  // Gemini AI Engine
  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    minMatchScore: parseInt(env.MIN_JOB_MATCH_SCORE || '70', 10),
  },

  // Communication & Email
  comms: {
    enabled: (env.EMAIL_NOTIFICATIONS_ENABLED || 'false').toLowerCase() === 'true',
    smtpHost: env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: parseInt(env.SMTP_PORT || '587', 10),
    smtpSecure: (env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    recipient: env.NOTIFICATION_RECIPIENT || env.SMTP_USER || '',
  },

  // Candidate CV / Profile Information
  cv: {
    name: env.CANDIDATE_NAME || 'Candidate',
    email: env.CANDIDATE_EMAIL || '',
    phone: env.CANDIDATE_PHONE || '',
    location: env.CANDIDATE_LOCATION || '',
    currentRole: env.CANDIDATE_CURRENT_ROLE || 'Software Developer',
    company: env.CANDIDATE_COMPANY || '',
    education: env.CANDIDATE_EDUCATION || '',
    yearsOfExperience: env.CANDIDATE_EXPERIENCE || '3+ years',
    skills: env.CANDIDATE_SKILLS || 'JavaScript, React, Node.js, Python',
    highlights: [
      env.CANDIDATE_HIGHLIGHT_1 || '',
      env.CANDIDATE_HIGHLIGHT_2 || '',
      env.CANDIDATE_HIGHLIGHT_3 || '',
      env.CANDIDATE_HIGHLIGHT_4 || '',
      env.CANDIDATE_HIGHLIGHT_5 || '',
    ],
    noticePeriod: env.CANDIDATE_NOTICE_PERIOD || 'Immediate',
    currentCTC: env.CANDIDATE_CURRENT_CTC || '',
    expectedCTC: env.CANDIDATE_EXPECTED_CTC || '',
    currentSalary: env.CANDIDATE_CURRENT_SALARY || '',
    expectedSalary: env.CANDIDATE_EXPECTED_SALARY || '',
    dob: env.CANDIDATE_DOB || '',
    gender: env.CANDIDATE_GENDER || 'Male',
    workAuth: env.CANDIDATE_WORK_AUTH || 'Authorized to work',
    github: env.CANDIDATE_GITHUB || '',
    linkedin: env.CANDIDATE_LINKEDIN || '',
    portfolio: env.CANDIDATE_PORTFOLIO || '',
    links: env.CANDIDATE_LINKS || '',
    remoteOk: env.CANDIDATE_REMOTE_OK || 'Yes',
    relocate: env.CANDIDATE_RELOCATE || 'Yes',
    startDate: env.CANDIDATE_START_DATE || 'Immediate',
  },

  // Automation & Delays
  pacing: {
    wellfoundDailyCap: parseInt(env.WELLFOUND_DAILY_CAP || '50', 10),
    naukriDailyCap: parseInt(env.NAUKRI_DAILY_CAP || '20', 10),
    ycDailyCap: parseInt(env.YC_DAILY_CAP || '20', 10),
    remoteDailyCap: parseInt(env.REMOTE_DAILY_CAP || '30', 10),
    minDelayMs: parseInt(env.MIN_DELAY_MS || '60000', 10),
    maxDelayMs: parseInt(env.MAX_DELAY_MS || '150000', 10),
  },

  // LinkedIn Networking & EasyApply
  linkedin: {
    dailyConnectionCap: parseInt(env.LINKEDIN_CONNECTION_CAP || '15', 10),
    dailyJobCap: parseInt(env.LINKEDIN_JOB_CAP || '10', 10),
    enableEasyApply: (env.LINKEDIN_EASY_APPLY || 'true').toLowerCase() === 'true',
    enableProfileWarmup: (env.LINKEDIN_PROFILE_WARMUP || 'true').toLowerCase() === 'true',
    searchPages: parseInt(env.LINKEDIN_SEARCH_PAGES || '3', 10),
  },

  // Naukri Adapter Settings
  naukri: {
    searchPages: parseInt(env.NAUKRI_SEARCH_PAGES || '4', 10),
    jobAgeDays: parseInt(env.NAUKRI_JOB_AGE || '1', 10),
  },

  // Directory Paths
  paths: {
    root: __dirname,
    profiles: path.join(__dirname, 'profiles'),
    logs: path.join(__dirname, 'logs'),
    csv: path.join(__dirname, 'applications.csv'),
  },
};

module.exports = CONFIG;
