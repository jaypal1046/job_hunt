/**
 * Persistent Scan State Model tracking historical Day 2 & Day 3 scan completion.
 */
class ScanState {
  constructor(data = {}) {
    this.day2ScanCompleted = Boolean(data.day2ScanCompleted);
    this.day3ScanCompleted = Boolean(data.day3ScanCompleted);
    this.historicalScanCompleted = Boolean(data.historicalScanCompleted || (this.day2ScanCompleted && this.day3ScanCompleted));
    this.initialScanCompletedAt = data.initialScanCompletedAt || null;
    this.lastScanTimestamp = data.lastScanTimestamp || new Date().toISOString();
  }

  markHistoricalCompleted() {
    this.day2ScanCompleted = true;
    this.day3ScanCompleted = true;
    this.historicalScanCompleted = true;
    if (!this.initialScanCompletedAt) {
      this.initialScanCompletedAt = new Date().toISOString();
    }
    this.lastScanTimestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      day2ScanCompleted: this.day2ScanCompleted,
      day3ScanCompleted: this.day3ScanCompleted,
      historicalScanCompleted: this.historicalScanCompleted,
      initialScanCompletedAt: this.initialScanCompletedAt,
      lastScanTimestamp: this.lastScanTimestamp,
    };
  }
}

module.exports = ScanState;
