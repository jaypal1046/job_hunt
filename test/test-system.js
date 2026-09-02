/**
 * Comprehensive Automated Verification Suite for 3-Stage Naukri System
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const LocalJobRepository = require('../src/repositories/local-job-repository');
const ScanStateRepository = require('../src/repositories/scan-state-repository');
const JobNormalizer = require('../src/core/pipeline/job-normalizer');
const JobFilter = require('../src/core/pipeline/job-filter');
const DuplicateChecker = require('../src/core/pipeline/duplicate-checker');
const SessionManager = require('../src/core/pipeline/session-manager');
const ApplicationProcessor = require('../src/core/pipeline/application-processor');
const { SessionStatus, ApplicationType } = require('../src/core/state/status-enum');

async function runTests() {
  console.log('🧪 Starting 3-Stage System Automated Test Suite...\n');

  const testDbDir = path.join(__dirname, 'logs', 'test_env');
  if (!fs.existsSync(testDbDir)) {
    fs.mkdirSync(testDbDir, { recursive: true });
  }

  const testDbPath = path.join(testDbDir, 'test_jobs.json');
  const testScanStatePath = path.join(testDbDir, 'test_scan_state.json');

  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testScanStatePath)) fs.unlinkSync(testScanStatePath);

  // Initialize fresh repositories
  const localDb = new LocalJobRepository(testDbPath);
  const scanStateRepo = new ScanStateRepository(testScanStatePath);
  const sessionMgr = new SessionManager();
  const duplicateChecker = new DuplicateChecker(localDb, sessionMgr);
  const appProcessor = new ApplicationProcessor(localDb, sessionMgr);

  // ----------------------------------------------------------------
  // Test 1: Normalization & Unique Key Generation
  // ----------------------------------------------------------------
  console.log('▶ Test 1: Normalization & Unique Key Generation');
  const raw1 = {
    title: 'Senior Flutter Developer',
    company: 'Company A',
    location: 'Bengaluru',
    link: 'https://www.naukri.com/job-listings-flutter-developer-company-a-260826012624?src=searchFeed',
    postingDate: '5 hours ago',
  };

  const job1 = JobNormalizer.normalize(raw1);
  assert.strictEqual(job1.jobId, '260826012624');
  assert.strictEqual(job1.canonicalUrl, 'https://www.naukri.com/job-listings-flutter-developer-company-a-260826012624');
  assert.strictEqual(job1.uniqueKey, 'naukri_id_260826012624');
  console.log('  ✅ Extracted Job ID and Canonical URL successfully.');

  // Test deterministic hash fallback when no Job ID exists
  const rawNoId = {
    title: 'Flutter Developer',
    company: 'Startup B',
    location: 'Remote',
    link: 'https://external-careers.com/jobs/flutter-dev',
  };
  const jobNoId = JobNormalizer.normalize(rawNoId);
  assert.ok(jobNoId.uniqueKey.startsWith('url_') || jobNoId.uniqueKey.startsWith('hash_'));
  console.log('  ✅ Generated URL/Hash fallback key:', jobNoId.uniqueKey);

  // ----------------------------------------------------------------
  // Test 2: Flutter Title & Description Filtering (Case-Insensitive)
  // ----------------------------------------------------------------
  console.log('\n▶ Test 2: Flutter Title & Description Filtering');
  const flutterTitles = [
    'Flutter Developer',
    'SENIOR FLUTTER DEVELOPER',
    'Mobile Engineer (Flutter + Dart)',
    'Fullstack Developer - flutter',
  ];
  for (const t of flutterTitles) {
    assert.strictEqual(JobFilter.isFlutterJob(t), true, `Failed for "${t}"`);
  }

  // Generic titles with Flutter mentioned in job description / skills
  const jobWithDesc = JobNormalizer.normalize({
    title: 'Mobile Engineer',
    company: 'Tech Co',
    description: 'Looking for an experienced mobile engineer with 3+ years in Flutter framework.',
  });
  assert.strictEqual(JobFilter.isFlutterJob(jobWithDesc), true);

  const jobWithSkills = JobNormalizer.normalize({
    title: 'Software Developer',
    company: 'App Corp',
    skills: 'Dart, Flutter, REST APIs, Git',
  });
  assert.strictEqual(JobFilter.isFlutterJob(jobWithSkills), true);

  assert.strictEqual(JobFilter.isFlutterJob({ title: 'Java Developer', description: 'Spring Boot, MySQL' }), false);
  console.log('  ✅ Case-insensitive Flutter title & description matching verified.');

  // ----------------------------------------------------------------
  // Test 3: Day 1 vs Day 2 / Day 3 Historical Scan Rules
  // ----------------------------------------------------------------
  console.log('\n▶ Test 3: Day 1 / Day 2 / Day 3 Freshness Logic');
  assert.strictEqual(scanStateRepo.isHistoricalScanCompleted(), false);

  const jobDay1 = JobNormalizer.normalize({ title: 'Flutter Dev 1', postingDate: '1 day ago' });
  const jobDay2 = JobNormalizer.normalize({ title: 'Flutter Dev 2', postingDate: '2 days ago' });
  const jobDay3 = JobNormalizer.normalize({ title: 'Flutter Dev 3', postingDate: '3 days ago' });

  // Initial Run: Day 1, 2, 3 allowed
  assert.strictEqual(JobFilter.evaluate(jobDay1, false).passed, true);
  assert.strictEqual(JobFilter.evaluate(jobDay2, false).passed, true);
  assert.strictEqual(JobFilter.evaluate(jobDay3, false).passed, true);

  // Mark historical scan completed
  scanStateRepo.markHistoricalScanCompleted();
  assert.strictEqual(scanStateRepo.isHistoricalScanCompleted(), true);

  // Subsequent Runs: Day 1 allowed, Day 2 & Day 3 skipped
  assert.strictEqual(JobFilter.evaluate(jobDay1, true).passed, true);
  assert.strictEqual(JobFilter.evaluate(jobDay2, true).passed, false);
  assert.strictEqual(JobFilter.evaluate(jobDay3, true).passed, false);
  console.log('  ✅ Day 1 vs Day 2/3 scan completion logic verified.');

  // ----------------------------------------------------------------
  // Test 4: Stage 2 Session State Machine & Duplicate Detection
  // ----------------------------------------------------------------
  console.log('\n▶ Test 4: Stage 2 Session & Duplicate Detection');
  sessionMgr.reset();

  const sessJob1 = sessionMgr.addJob(job1, SessionStatus.FOUND);
  const job1Dup = JobNormalizer.normalize(raw1);
  const dupCheck1 = duplicateChecker.checkDuplicate(job1Dup);
  assert.strictEqual(dupCheck1.isDuplicate, true);
  assert.strictEqual(dupCheck1.source, 'SESSION');
  console.log('  ✅ Session-level duplicate correctly caught in memory.');

  // ----------------------------------------------------------------
  // Test 5: Stage 1 Database Persistence & Idempotency
  // ----------------------------------------------------------------
  console.log('\n▶ Test 5: Stage 1 Database Persistence & Idempotency');
  await appProcessor.processApplication(null, sessJob1, { live: false });

  assert.strictEqual(sessJob1.sessionStatus, SessionStatus.APPLIED);
  assert.strictEqual(sessJob1.isApplied, true);

  // Verify in Local DB
  const storedInDb = localDb.findByUniqueKey(sessJob1.uniqueKey);
  assert.notStrictEqual(storedInDb, null);
  assert.strictEqual(storedInDb.isApplied, true);

  // Re-run check on fresh session
  sessionMgr.reset();
  const newRunJob = JobNormalizer.normalize(raw1);
  const dupCheckDb = duplicateChecker.checkDuplicate(newRunJob);
  assert.strictEqual(dupCheckDb.isDuplicate, true);
  assert.strictEqual(dupCheckDb.source, 'LOCAL_DATABASE');
  sessionMgr.addJob(newRunJob, SessionStatus.ALREADY_APPLIED);

  // Test that filtered jobs are also remembered persistently
  const filteredJob = JobNormalizer.normalize({ title: 'Java Engineer', company: 'Non-Flutter Corp' });
  localDb.saveJob({ ...filteredJob.toJSON(), isApplied: false, applicationStatus: 'FILTERED' });
  const filteredDupCheck = duplicateChecker.checkDuplicate(filteredJob);
  assert.strictEqual(filteredDupCheck.isDuplicate, true);
  assert.strictEqual(filteredDupCheck.source, 'LOCAL_DATABASE');
  console.log('  ✅ Persistent DB duplicate caught for both applied and filtered jobs (Idempotency verified).');

  // ----------------------------------------------------------------
  // Test 6: 30-Day Automated Data Retention Policy
  // ----------------------------------------------------------------
  console.log('\n▶ Test 6: 30-Day Automated Data Retention Cleanup');
  const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(); // 35 days ago
  const oldJob = JobNormalizer.normalize({
    title: 'Flutter Developer Old',
    company: 'Old Company',
    link: 'https://www.naukri.com/job-listings-old-job-111111111111',
  });
  oldJob.createdAt = oldDate;
  localDb.saveJob(oldJob);

  assert.strictEqual(localDb.getRecordCount(), 3);
  const purgedCount = localDb.cleanupOlderThan(30);
  assert.strictEqual(purgedCount, 1);
  assert.strictEqual(localDb.getRecordCount(), 2);
  assert.strictEqual(localDb.findByUniqueKey(oldJob.uniqueKey), null);
  console.log('  ✅ Records older than 30 days automatically purged.');

  // ----------------------------------------------------------------
  // Test 7: Y Combinator & Wellfound Job Normalization & Pipeline
  // ----------------------------------------------------------------
  console.log('\n▶ Test 7: Y Combinator & Wellfound Job Pipeline');
  const rawYC = {
    title: 'Senior Flutter Engineer',
    company: 'YC Fintech (S24)',
    link: 'https://www.workatastartup.com/jobs/998877',
    description: 'Build mobile payments infrastructure using Flutter and Dart.',
  };
  const jobYC = JobNormalizer.normalize(rawYC);
  assert.strictEqual(jobYC.uniqueKey, 'url_https://www.workatastartup.com/jobs/998877');
  assert.strictEqual(JobFilter.isFlutterJob(jobYC), true);

  const rawWellfound = {
    title: 'Mobile Engineer (Flutter)',
    company: 'Wellfound Startup',
    link: 'https://wellfound.com/jobs/554433-mobile-engineer',
    description: 'Looking for a Flutter expert.',
  };
  const jobWF = JobNormalizer.normalize(rawWellfound);
  assert.strictEqual(jobWF.uniqueKey, 'url_https://wellfound.com/jobs/554433-mobile-engineer');
  assert.strictEqual(JobFilter.isFlutterJob(jobWF), true);
  // ----------------------------------------------------------------
  // Test 8: Startup.jobs, RemoteOK, WWR, and Himalayas Job Pipeline
  // ----------------------------------------------------------------
  console.log('\n▶ Test 8: Multi-Platform Remote Jobs Pipeline');
  const remoteTestCases = [
    { title: 'Flutter Developer', company: 'StartupJobs Co', link: 'https://startup.jobs/flutter-developer-123' },
    { title: 'Senior Mobile Dev', company: 'RemoteOK Startup', link: 'https://remoteok.com/remote-jobs/flutter-dev-456', description: 'Requires Flutter experience' },
    { title: 'Flutter Engineer', company: 'WWR Tech', link: 'https://weworkremotely.com/remote-jobs/789-flutter-engineer' },
    { title: 'Mobile Developer - Flutter', company: 'Himalayas India', link: 'https://himalayas.app/jobs/flutter-dev-india-321' },
  ];

  for (const raw of remoteTestCases) {
    const norm = JobNormalizer.normalize(raw);
    assert.ok(norm.uniqueKey.startsWith('url_'));
    assert.strictEqual(JobFilter.isFlutterJob(norm), true, `Failed Flutter check for ${raw.company}`);
  }
  // ----------------------------------------------------------------
  // Test 9: 2-Level AI Model Strategy & Knowledge Base Retrieval
  // ----------------------------------------------------------------
  console.log('\n▶ Test 9: 2-Level AI Engine & Knowledge Base Evidence Retrieval');
  const retrievalService = require('../src/services/knowledge/retrieval-service');
  const llmCache = require('../src/services/ai/llm-cache');

  const evidence = retrievalService.retrieveRelevantEvidence(['Flutter', 'REST API'], 0.70);
  assert.ok(evidence.professional.length > 0, 'Should retrieve ICICI Lombard experience for Flutter/REST API');
  assert.ok(evidence.matchedSkills.includes('Flutter'));
  console.log('  ✅ Factual evidence retrieved based on confidence threshold (>= 0.70).');

  const cacheKey = llmCache.generateKey('Senior Flutter Engineer JD', 'v1', 'gemini-3.5-flash-lite', 'test');
  llmCache.set(cacheKey, { score: 92, status: 'cached' });
  const cachedVal = llmCache.get(cacheKey);
  assert.strictEqual(cachedVal.data.score, 92);
  console.log('  ✅ SHA256 prompt caching verified.');

  // Clean test files
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testScanStatePath)) fs.unlinkSync(testScanStatePath);
  fs.rmdirSync(testDbDir);

  console.log('\n🎉 ALL AUTOMATED TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
