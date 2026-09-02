/**
 * ScanStateRepository — Persists historical scan state across application restarts.
 * Ensures Day 2 & Day 3 scans are processed ONLY ONCE during initial setup/first run.
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('../../config');
const ScanState = require('../core/models/scan-state');

class ScanStateRepository {
  constructor(stateFilePath = null) {
    this.dir = CONFIG.paths.logs || path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }

    this.filePath = stateFilePath || path.join(this.dir, 'scan_state.json');
    this.state = this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return new ScanState(parsed);
      }
    } catch (err) {
      console.error(`[ScanStateRepository] Failed to read state file ${this.filePath}:`, err.message);
    }
    return new ScanState();
  }

  saveState() {
    try {
      this.state.lastScanTimestamp = new Date().toISOString();
      const payload = this.state.toJSON();
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error(`[ScanStateRepository] Failed to save state to ${this.filePath}:`, err.message);
    }
  }

  getScanState() {
    return this.state;
  }

  isHistoricalScanCompleted() {
    return this.state.historicalScanCompleted;
  }

  markHistoricalScanCompleted() {
    this.state.markHistoricalCompleted();
    this.saveState();
    return this.state;
  }
}

module.exports = ScanStateRepository;
