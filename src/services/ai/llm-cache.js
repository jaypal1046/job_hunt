/**
 * LLMCache — Persistent SHA256 LLM Prompt & Analysis Cache
 * Prevents redundant LLM API calls for identical job descriptions / prompts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CONFIG = require('../../../config');
const { log } = require('../logger');

class LLMCache {
  constructor() {
    this.cacheFile = path.join(CONFIG.paths.logs, 'llm_cache.json');
    this.cache = {};
    this.loadCache();
  }

  loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const raw = fs.readFileSync(this.cacheFile, 'utf8');
        this.cache = JSON.parse(raw);
      }
    } catch (err) {
      log('gemini', `Error loading LLM cache: ${err.message}`);
      this.cache = {};
    }
  }

  saveCache() {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (err) {
      log('gemini', `Error saving LLM cache: ${err.message}`);
    }
  }

  generateKey(jobDescription, resumeVersion = 'v1', modelVersion = 'gemini-2.5-flash', promptVersion = 'p1') {
    const raw = `${jobDescription || ''}_${resumeVersion}_${modelVersion}_${promptVersion}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  get(key) {
    if (this.cache[key]) {
      log('gemini', `  ⚡ [LLM Cache Hit]: Reusing cached analysis for key ${key.slice(0, 8)}...`);
      return this.cache[key];
    }
    return null;
  }

  set(key, value) {
    this.cache[key] = {
      timestamp: new Date().toISOString(),
      data: value,
    };
    this.saveCache();
  }
}

module.exports = new LLMCache();
