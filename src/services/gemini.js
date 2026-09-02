/**
 * Gemini AI Service with Persistent Caching & Rate Limiting Safeguards
 * Protects Gemini API quotas across bot restarts & avoids redundant API calls.
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('../../config');
const { log } = require('./logger');

const CACHE_FILE = path.join(CONFIG.paths.logs, 'gemini_cache.json');

class GeminiService {
  constructor() {
    this.apiKey = CONFIG.gemini.apiKey;
    this.minScore = CONFIG.gemini.minMatchScore;
    this.cache = this.loadCache();
    this.lastCallTimestamp = 0;
    this.minCallIntervalMs = 4000; // 4 seconds between API calls to stay under RPM limits
    // Auto-health tracking: models that returned 429/rate-limit are marked dead with a cooldown
    // Key: model name, Value: timestamp when it was marked dead
    this.deadModels = {};
    this.deadCooldownMs = 5 * 60 * 1000; // 5 minutes before retrying a dead model
    // Track which model is currently working (for logging)
    this.activeModel = null;
  }

  loadCache() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      }
    } catch (e) {}
    return {};
  }

  saveCache() {
    try {
      // Cap cache size to last 3000 entries
      const keys = Object.keys(this.cache);
      if (keys.length > 3000) {
        const trimmed = {};
        keys.slice(-3000).forEach((k) => (trimmed[k] = this.cache[k]));
        this.cache = trimmed;
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.cache, null, 2));
    } catch (e) {}
  }

  /**
   * Check if a model is alive (not rate-limited or cooldown expired)
   */
  isModelAlive(model) {
    const deadSince = this.deadModels[model];
    if (!deadSince) return true; // Never died
    const elapsed = Date.now() - deadSince;
    if (elapsed > this.deadCooldownMs) {
      // Cooldown expired — give it another chance
      delete this.deadModels[model];
      log('gemini', `♻ Model ${model} cooldown expired — retrying.`);
      return true;
    }
    return false; // Still dead
  }

  /**
   * Mark a model as dead (rate-limited)
   */
  markModelDead(model, statusCode) {
    this.deadModels[model] = Date.now();
    const aliveModels = this.getAllModels().filter((m) => this.isModelAlive(m));
    log('gemini', `💀 Model ${model} marked DEAD (HTTP ${statusCode}). Alive models: [${aliveModels.join(', ') || 'NONE'}]`);
  }

  /**
   * Get the full model list
   */
  getAllModels() {
    const modelsToTry = [
      CONFIG.gemini?.model,
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.1-flash-lite',
      'gemini-3-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemma-4-31b',
      'gemma-4-26b',
      'gemma-2-27b-it',
      'gemma-2-9b-it',
      'gemma-2-2b-it',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-1.5-pro',
    ].filter(Boolean);
    return [...new Set(modelsToTry)];
  }

  /**
   * Rate-limited call to Gemini REST API with automatic model fallback & health tracking
   * - Automatically skips models that returned 429 (rate limit)
   * - Retries dead models after 5-minute cooldown
   * - Logs alive vs dead model status
   */
  async callGemini(prompt, systemInstruction = '') {
    if (!this.apiKey) return null;

    // Enforce minimum delay between Gemini calls (rate limiter safeguard)
    const now = Date.now();
    const elapsed = now - this.lastCallTimestamp;
    if (elapsed < this.minCallIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minCallIntervalMs - elapsed));
    }
    this.lastCallTimestamp = Date.now();

    const allModels = this.getAllModels();
    const aliveModels = allModels.filter((m) => this.isModelAlive(m));

    if (aliveModels.length === 0) {
      log('gemini', `⚠ ALL models are rate-limited. Waiting for cooldown... Using template fallback.`);
      return null;
    }

    for (const model of aliveModels) {
      const isBearerToken = this.apiKey.startsWith('ya29.');

      const requestsToTry = [
        {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
          headers: { 'Content-Type': 'application/json' },
        },
        {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      ];

      if (isBearerToken) {
        requestsToTry.reverse();
      }

      for (const req of requestsToTry) {
        try {
          const contents = [];
          if (systemInstruction) {
            contents.push({ role: 'user', parts: [{ text: `[System Context]: ${systemInstruction}` }] });
          }
          contents.push({ role: 'user', parts: [{ text: prompt }] });

          const response = await fetch(req.url, {
            method: 'POST',
            headers: req.headers,
            body: JSON.stringify({ contents }),
          });

          if (!response.ok) {
            const errBody = await response.text().catch(() => '');

            // Auto-detect rate limit and mark model as dead
            if (response.status === 429 || response.status === 503) {
              this.markModelDead(model, response.status);
              break; // Skip to next model immediately
            }

            // 404 = model doesn't exist, mark permanently for this session
            if (response.status === 404) {
              this.markModelDead(model, 404);
              break;
            }

            log('gemini', `API Warning for model ${model}: ${response.status} ${response.statusText} ${errBody ? '- ' + errBody.slice(0, 150) : ''}`);
            continue;
          }

          const data = await response.json();
          const resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (resultText) {
            // Track the working model
            if (this.activeModel !== model) {
              this.activeModel = model;
              log('gemini', `✅ Using model: ${model}`);
            }
            return resultText;
          }
        } catch (err) {
          log('gemini', `Call failed for model ${model}: ${err.message}`);
        }
      }
    }

    return null;
  }

  /**
   * Evaluates job description suitability using 2-Level AI Decision Engine
   */
  async evaluateJobSuitability(jobTitle, company, jd = '') {
    const cacheKey = `eval_${(jobTitle || '').toLowerCase().trim()}_${(company || '').toLowerCase().trim()}`;
    if (this.cache[cacheKey]) {
      log('gemini', `Using cached evaluation for "${jobTitle}" @ "${company}"`);
      return this.cache[cacheKey];
    }

    try {
      const aiEngine = require('./ai/ai-match-engine');
      const evalResult = await aiEngine.evaluateJob(jobTitle, company, jd);
      const result = {
        score: evalResult.score,
        apply: evalResult.apply && evalResult.score >= this.minScore,
        reasoning: evalResult.reason,
        level: evalResult.level,
        decision: evalResult.decision,
        matchedSkills: evalResult.matchedSkills,
        missingSkills: evalResult.missingSkills,
        coverNote: evalResult.coverNote,
      };

      this.cache[cacheKey] = result;
      this.saveCache();
      return result;
    } catch (err) {
      log('gemini', `[GeminiService] AI Engine evaluation fallback: ${err.message}`);
      const lowerTitle = (jobTitle || '').toLowerCase();
      const isMatch = ['flutter', 'dart', 'full stack', 'backend', 'frontend', 'software', 'developer', 'engineer', 'react', 'node', 'python', 'ai'].some((k) => lowerTitle.includes(k));
      const fallback = {
        score: isMatch ? 85 : 50,
        apply: isMatch,
        reasoning: isMatch ? 'Matched primary tech keywords.' : 'Does not match primary developer keywords.',
      };
      this.cache[cacheKey] = fallback;
      this.saveCache();
      return fallback;
    }
  }

  async generateCoverLetter(jobTitle, company, jd = '') {
    const cv = CONFIG.cv;
    if (this.apiKey) {
      const prompt = `
Write a professional, concise cover letter (max 180 words) for applying to ${company || 'the hiring team'}.

Job Title: ${jobTitle || 'Developer'}
Candidate Name: ${cv.name}
Role: ${cv.currentRole}
Key Skills: ${cv.skills.split(',').slice(0, 6).join(', ')}
Top Achievement: ${cv.highlights[0] || 'Building production features end to end'}

Keep it professional, human, direct, no generic fluff.
`;
      const aiLetter = await this.callGemini(prompt);
      if (aiLetter && aiLetter.length > 50) return aiLetter;
    }

    return `${cv.name}
${cv.phone} · ${cv.email}
${cv.linkedin} · ${cv.github}

Dear ${company ? company + ' team' : 'Hiring Manager'},

I would like to apply for the ${jobTitle || 'Software Engineer'} position at ${company || 'your company'}.

I am currently ${cv.currentRole}, working daily with ${cv.skills.split(',').slice(0, 8).join(', ')}. A recent key accomplishment: ${cv.highlights[0] || 'shipping production web applications'}.

I look forward to discussing how my experience can support your team.

Sincerely,
${cv.name}`;
  }

  async answerQuestion(questionText, context = {}) {
    if (this.apiKey && questionText) {
      const prompt = `
Answer this job application question on my behalf in first person (2-3 sentences max, clean, professional):

Question: "${questionText}"

My Profile:
- Name: ${CONFIG.cv.name}
- Role: ${CONFIG.cv.currentRole}
- Experience: ${CONFIG.cv.yearsOfExperience}
- Skills: ${CONFIG.cv.skills}
- Location / Relocate: ${CONFIG.cv.location} / ${CONFIG.cv.relocate}
`;
      const answer = await this.callGemini(prompt);
      if (answer) return answer;
    }

    return `I am ${CONFIG.cv.name}, ${CONFIG.cv.currentRole} with ${CONFIG.cv.yearsOfExperience} experience in ${CONFIG.cv.skills.split(',').slice(0, 4).join(', ')}.`;
  }
}

module.exports = new GeminiService();
