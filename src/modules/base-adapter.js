/**
 * Base Adapter Interface for Job Search Platforms
 * Standardizes lifecycle across Naukri, Wellfound, LinkedIn, and future modules.
 */
class BaseAdapter {
  constructor(name) {
    this.name = name;
  }

  /**
   * One-time manual login mode (visible browser window to save persistent session)
   */
  async login() {
    throw new Error(`[${this.name}] login() not implemented`);
  }

  /**
   * Executes background automation run (dry-run or live)
   */
  async run(options = {}) {
    throw new Error(`[${this.name}] run() not implemented`);
  }

  /**
   * Gets current day stats
   */
  getStats() {
    return { name: this.name, count: 0 };
  }
}

module.exports = BaseAdapter;
