/**
 * Autonomous Job Search & Application Engine
 * Main Orchestrator & CLI Entry Point
 *
 * Usage:
 *   node main.js run [--live] [--site=naukri|wellfound|all]   Runs background auto-apply / refresh
 *   node main.js daemon [--live] [--interval=60]              Runs recurring interval loop indefinitely
 *   node main.js login <naukri|wellfound>                      One-time visible browser login
 *   node main.js refresh                                        Hourly Naukri profile update
 *   node main.js report                                         Sends email summary report
 *   node main.js stop                                           Stops running daemon process
 */

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const { log } = require('./src/services/logger');
const notifier = require('./src/services/notifier');
const naukriAdapter = require('./src/modules/naukri-adapter');
const wellfoundAdapter = require('./src/modules/wellfound-adapter');
const ycAdapter = require('./src/modules/yc-adapter');
const remoteAdapter = require('./src/modules/remote-adapter');
const linkedinAdapter = require('./src/modules/linkedin-adapter');

const args = process.argv.slice(2);
const command = args[0] || 'run';
const isLive = args.includes('--live');

const PID_FILE = path.join(CONFIG.paths.logs, 'engine.pid');

function parseSiteArg() {
  const siteFlag = args.find((a) => a.startsWith('--site='));
  if (siteFlag) return siteFlag.split('=')[1].toLowerCase();
  if (['naukri', 'wellfound', 'yc', 'remote', 'linkedin'].includes(args[1])) return args[1].toLowerCase();
  return 'all';
}

function parseIntervalArg() {
  const intervalFlag = args.find((a) => a.startsWith('--interval='));
  if (intervalFlag) return parseInt(intervalFlag.split('=')[1], 10);
  return 60; // Default: 60 minutes
}

function showHelp() {
  console.log(`
=============================================================================
🤖 UNIFIED AUTONOMOUS JOB ENGINE (Gemini AI Powered)
=============================================================================

Commands:
  node main.js run [--live] [--site=all|wellfound|yc|remote|naukri|linkedin]
      Runs background jobs once (Dry-Run by default, add --live to submit real applications).

  node main.js daemon [--live] [--interval=60]
      Runs continuous interval loop (every X minutes) as long as laptop is on.

  node main.js login <naukri|wellfound|yc|linkedin>
      Opens visible Chrome browser to log into account and save persistent session.

  node main.js refresh
      Runs hourly Naukri resume headline update (toggles dot to refresh profile date).

  node main.js report
      Generates and sends a summary report via email / console.

  node main.js stop
      Stops any running background daemon process.

Options:
  --live         Submit real job applications (default is DRY RUN mode)
  --interval=60  Interval in minutes for daemon mode (default: 60 minutes)
  --site=...     Target specific platform (wellfound, yc, remote, naukri, linkedin, all)
`);
}

async function handleRun() {
  const targetSite = parseSiteArg();
  log('engine', `Starting autonomous run cycle. SiteTarget=${targetSite}, Mode=${isLive ? 'LIVE' : 'DRY RUN'}`);

  const results = {};

  // 1. Run Naukri Module (Refresh + Auto Apply)
  if (targetSite === 'all' || targetSite === 'naukri') {
    log('engine', '--- Executing Naukri Module ---');
    results.naukri = await naukriAdapter.run({ live: isLive });
  }

  // 2. Run Wellfound Module (Auto Apply)
  if (targetSite === 'all' || targetSite === 'wellfound') {
    log('engine', '--- Executing Wellfound Module ---');
    results.wellfound = await wellfoundAdapter.run({ live: isLive });
  }

  // 3. Run Y Combinator Work at a Startup Module (Auto Apply)
  if (targetSite === 'all' || targetSite === 'yc') {
    log('engine', '--- Executing Y Combinator Module ---');
    results.yc = await ycAdapter.run({ live: isLive });
  }

  // 4. Run Unified Remote Jobs Module (startup.jobs, RemoteOK, WWR, Himalayas)
  if (targetSite === 'all' || targetSite === 'remote') {
    log('engine', '--- Executing Remote Jobs Module (Startup.jobs, RemoteOK, WWR, Himalayas) ---');
    results.remote = await remoteAdapter.run({ live: isLive });
  }

  // 5. LinkedIn Module (Explicit flag only)
  if (targetSite === 'linkedin') {
    log('engine', '--- Executing LinkedIn Module ---');
    results.linkedin = await linkedinAdapter.run({ live: isLive });
  }

  const wellfoundStats = wellfoundAdapter.getStats();
  const ycStats = ycAdapter.getStats();
  const remoteStats = remoteAdapter.getStats();
  const naukriStats = naukriAdapter.getStats();
  const linkedinStats = linkedinAdapter.getStats();

  const reportStats = {
    wellfoundSent: wellfoundStats.count || 0,
    ycSent: ycStats.count || 0,
    remoteSent: remoteStats.count || 0,
    naukriRefreshed: results.naukri ? results.naukri.success : false,
    linkedinConnections: linkedinStats.connections || 0,
    linkedinJobs: linkedinStats.jobs || 0,
    linkedinSent: linkedinStats.count || 0,
    evaluatedCount: (wellfoundStats.count || 0) + (ycStats.count || 0) + (remoteStats.count || 0) + (naukriStats.count || 0),
  };

  log('engine', `Run cycle finished. Summary: NaukriRefreshed=${reportStats.naukriRefreshed}, Wellfound=${reportStats.wellfoundSent}, YCombinator=${reportStats.ycSent}, RemoteJobs=${reportStats.remoteSent}`);

  // Send email update if notifications enabled
  await notifier.sendDailyReport(reportStats);
  return results;
}

async function handleDaemon() {
  const intervalMins = parseIntervalArg();
  const intervalMs = intervalMins * 60 * 1000;

  // Record process ID
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {}

  log('engine', `DAEMON MODE STARTED. Running cycle every ${intervalMins} minutes. Mode=${isLive ? 'LIVE' : 'DRY RUN'} (PID: ${process.pid})`);

  async function executeCycle() {
    await handleRun().catch((err) => log('engine', `Cycle error: ${err.message}`));
    const nextTrigger = new Date(Date.now() + intervalMs);
    const timeStr = nextTrigger.toLocaleTimeString();
    const statusMsg = `NEXT EVENT TRIGGER: Today at ${timeStr} (in ${intervalMins} minutes)`;
    log('engine', statusMsg);
    console.log('\n=============================================================================');
    console.log(`⏰ ${statusMsg}`);
    console.log('=============================================================================\n');
  }

  // Run first cycle immediately
  await executeCycle();

  // Recurring loop
  setInterval(async () => {
    log('engine', `Starting scheduled interval cycle (${intervalMins}m elapsed)...`);
    await executeCycle();
  }, intervalMs);
}

function handleStop() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid) {
        process.kill(pid);
        log('engine', `Daemon process ${pid} stopped.`);
        fs.unlinkSync(PID_FILE);
        console.log(`Successfully stopped autonomous engine daemon (PID: ${pid}).`);
        return;
      }
    }
  } catch (e) {
    // Process might already be stopped
  }
  console.log('No active daemon process found or process already stopped.');
}

async function handleLogin() {
  const site = parseSiteArg();
  if (site === 'naukri') {
    await naukriAdapter.login();
  } else if (site === 'wellfound') {
    await wellfoundAdapter.login();
  } else if (site === 'yc') {
    await ycAdapter.login();
  } else if (site === 'linkedin') {
    await linkedinAdapter.login();
  } else {
    console.log('Please specify site to login: node main.js login <naukri|wellfound|yc|linkedin>');
  }
}

async function handleRefresh() {
  log('engine', 'Executing Naukri headline refresh...');
  const res = await naukriAdapter.run({ live: true, refreshOnly: true });
  console.log('Refresh result:', res);
}

async function handleReport() {
  const wellfoundStats = wellfoundAdapter.getStats();
  const ycStats = ycAdapter.getStats();
  const remoteStats = remoteAdapter.getStats();
  const naukriStats = naukriAdapter.getStats();

  await notifier.sendDailyReport({
    wellfoundSent: wellfoundStats.count || 0,
    ycSent: ycStats.count || 0,
    remoteSent: remoteStats.count || 0,
    naukriRefreshed: true,
    evaluatedCount: (wellfoundStats.count || 0) + (ycStats.count || 0) + (remoteStats.count || 0) + (naukriStats.count || 0),
  });
}

async function main() {
  switch (command.toLowerCase()) {
    case 'run':
      await handleRun();
      break;
    case 'daemon':
      await handleDaemon();
      break;
    case 'stop':
      handleStop();
      break;
    case 'login':
      await handleLogin();
      break;
    case 'refresh':
      await handleRefresh();
      break;
    case 'report':
      await handleReport();
      break;
    case 'test-notify':
      await notifier.sendEmail('Test Communication Channel', 'This is a test notification from your Autonomous Job Engine.');
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      console.log(`Unknown command: ${command}`);
      showHelp();
      break;
  }
}

main().catch((err) => {
  console.error('Fatal engine error:', err);
  process.exit(1);
});
