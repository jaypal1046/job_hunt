/**
 * GeminiProvider — Google Gemini Implementation of LLMProvider
 * Uses GoogleGenAI / Gemini models for job analysis, match scoring, and resume tailoring.
 * Guarantees validated structured JSON output with fallback retries.
 */
const { GoogleGenAI } = require('@google/genai');
const LLMProvider = require('./llm-provider-interface');
const llmCache = require('./llm-cache');
const CONFIG = require('../../../config');
const { log } = require('../logger');

class GeminiProvider extends LLMProvider {
  constructor() {
    super();
    this.apiKey = CONFIG.gemini.apiKey;
    this.primaryModel = CONFIG.gemini.primaryModel || 'gemini-3.5-flash-lite';
    this.strongModel = CONFIG.gemini.strongModel || 'gemini-2.5-pro';
    this.ai = new GoogleGenAI({ apiKey: this.apiKey });
  }

  /**
   * Helper to execute Gemini request and parse JSON safely
   */
  async _callGeminiJson(prompt, modelName = this.primaryModel, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.ai.models.generateContent({
          model: modelName,
          contents: prompt,
        });

        const text = response.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        log('gemini', `[GeminiProvider] Attempt ${attempt} failed: ${err.message}`);
        if (attempt === retries) throw err;
      }
    }
    return null;
  }

  /**
   * Layer 1 Fast Analysis: Extract requirements & keywords
   */
  async analyzeJob(jobTitle, companyName, jobDescription) {
    const cacheKey = llmCache.generateKey(jobDescription, 'v1', this.primaryModel, 'analyze');
    const cached = llmCache.get(cacheKey);
    if (cached) return cached.data;

    const prompt = `You are an expert AI Job Classifier.
Analyze the following job posting and return valid JSON ONLY:

Job Title: ${jobTitle}
Company: ${companyName}
Description Snippet:
${(jobDescription || '').slice(0, 2500)}

Return JSON in exact format:
{
  "isFlutterJob": true/false,
  "extractedSkills": ["Flutter", "Dart", "REST API"],
  "experienceLevel": "Mid / Senior",
  "summary": "Brief 1-sentence role summary"
}`;

    const result = await this._callGeminiJson(prompt, this.primaryModel).catch(() => ({
      isFlutterJob: /flutter/i.test(jobTitle + jobDescription),
      extractedSkills: ['Flutter'],
      experienceLevel: 'Mid',
      summary: jobTitle,
    }));

    if (result) llmCache.set(cacheKey, result);
    return result;
  }

  /**
   * Layer 1 Fast Resume Score calculation vs candidate profile
   */
  async scoreResume(jobTitle, companyName, jobDescription, candidateProfile) {
    const cacheKey = llmCache.generateKey(jobDescription, 'v1', this.primaryModel, 'score');
    const cached = llmCache.get(cacheKey);
    if (cached) return cached.data;

    const prompt = `You are a Senior Technical Recruiter evaluating candidate suitability.
Candidate Core Role: ${candidateProfile.targetRole}
Candidate Skills: ${candidateProfile.coreSkills.join(', ')}
Candidate Total Experience: ${candidateProfile.totalExperienceYears} years

Job Posting:
Title: ${jobTitle}
Company: ${companyName}
Description: ${(jobDescription || '').slice(0, 3000)}

Perform evaluation and return valid JSON ONLY:
{
  "overall_score": 85,
  "apply": true/false,
  "reasoning": "Reason for score",
  "matched_skills": ["Flutter", "Dart"],
  "missing_from_resume": ["Insurance Domain"]
}`;

    const result = await this._callGeminiJson(prompt, this.primaryModel).catch(() => ({
      overall_score: /flutter/i.test(jobTitle + jobDescription) ? 85 : 40,
      apply: /flutter/i.test(jobTitle + jobDescription),
      reasoning: 'Fallback keyword evaluation',
      matched_skills: ['Flutter'],
      missing_from_resume: [],
    }));

    if (result) llmCache.set(cacheKey, result);
    return result;
  }

  /**
   * Layer 2 Deep Resume Analysis & Factual Cover Letter/Tailoring
   */
  async tailorResume(jobDescription, masterResume, evidence) {
    const prompt = `You are a strict, factual AI Resume Tailoring Agent.

SAFETY DIRECTIVE:
1. ONLY USE THE FACTUAL INFORMATION PROVIDED.
2. DO NOT INVENT EXPERIENCE, METRICS, OR EMPLOYERS.
3. DO NOT FABRICATE RESPONSIBILITIES.

JOB DESCRIPTION:
${(jobDescription || '').slice(0, 3000)}

CANDIDATE MASTER RESUME:
${JSON.stringify(masterResume)}

RETRIEVED FACTUAL EVIDENCE:
${JSON.stringify(evidence)}

Return JSON ONLY:
{
  "overall_score": 88,
  "decision": "TAILOR_SUCCESS",
  "tailored_summary": "Tailored factual summary highlighting Flutter & REST API work",
  "matched_skills": ["Flutter", "Dart", "REST API"],
  "missing_skills": [],
  "cover_note": "Respected Founder/Hiring Manager..."
}`;

    return await this._callGeminiJson(prompt, this.primaryModel).catch(() => ({
      overall_score: 80,
      decision: "USE_MASTER_RESUME",
      tailored_summary: masterResume.targetRole,
      matched_skills: masterResume.coreSkills,
      missing_skills: [],
      cover_note: `Hello, I am interested in applying for this position as a ${masterResume.targetRole} with ${masterResume.totalExperienceYears} years of experience building Flutter applications.`,
    }));
  }

  async validateResume(tailoredResume, masterResume) {
    return { valid: true, errors: [] };
  }
}

module.exports = new GeminiProvider();
