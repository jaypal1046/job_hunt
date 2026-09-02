/**
 * AIMatchEngine — 2-Level AI Decision Engine
 * Integrates Layer 1 Fast Analysis with Layer 2 Deep Evidence Retrieval & Tailoring.
 */
const geminiProvider = require('./gemini-provider');
const retrievalService = require('../knowledge/retrieval-service');
const { log } = require('../logger');

class AIMatchEngine {
  /**
   * Performs complete 2-Level evaluation for a job posting
   */
  async evaluateJob(jobTitle, companyName, jobDescription) {
    const candidateProfile = retrievalService.getMasterResume();

    // ----------------------------------------------------------------
    // Layer 1 — Fast / Low-Cost Analysis
    // ----------------------------------------------------------------
    log('gemini', `  ▶ [AI Layer 1 Fast Analysis]: "${jobTitle}" @ "${companyName}"`);
    const fastAnalysis = await geminiProvider.analyzeJob(jobTitle, companyName, jobDescription);
    const initialScore = await geminiProvider.scoreResume(jobTitle, companyName, jobDescription, candidateProfile);

    const score = initialScore.overall_score || 0;
    log('gemini', `  📊 Layer 1 Match Score: ${score}% | Decision: ${initialScore.apply ? 'APPLY' : 'SKIP'}`);

    if (score >= 80) {
      return {
        score,
        apply: true,
        level: 'Layer 1 (Fast)',
        decision: 'APPLY_MASTER_RESUME',
        matchedSkills: initialScore.matched_skills || candidateProfile.coreSkills,
        missingSkills: initialScore.missing_from_resume || [],
        reason: initialScore.reasoning || 'Score >= 80% with master resume.',
      };
    }

    // ----------------------------------------------------------------
    // Layer 2 — Deep Analysis & Evidence Retrieval (Triggered when Score < 80%)
    // ----------------------------------------------------------------
    log('gemini', `  🔍 [AI Layer 2 Deep Analysis Triggered]: Score (${score}%) < 80%. Retrieving Knowledge Base evidence...`);
    const extractedSkills = fastAnalysis.extractedSkills || ['Flutter'];
    const evidence = retrievalService.retrieveRelevantEvidence(extractedSkills);

    const totalEvidenceFound = evidence.professional.length + evidence.projects.length + evidence.github.length;
    log('gemini', `  📌 Knowledge Base Evidence Found: ${totalEvidenceFound} items (Matched skills: ${evidence.matchedSkills.join(', ')})`);

    if (totalEvidenceFound > 0 && initialScore.apply) {
      const deepResult = await geminiProvider.tailorResume(jobDescription, candidateProfile, evidence);
      return {
        score: Math.max(score, deepResult.overall_score || score),
        apply: true,
        level: 'Layer 2 (Deep Tailoring)',
        decision: 'TAILOR_RESUME',
        matchedSkills: deepResult.matched_skills || evidence.matchedSkills,
        missingSkills: deepResult.missing_skills || [],
        coverNote: deepResult.cover_note,
        evidence: evidence,
        reason: 'Layer 2 Deep evidence retrieval tailored resume successfully.',
      };
    }

    return {
      score,
      apply: initialScore.apply && score >= 50,
      level: 'Layer 1 (Standard)',
      decision: initialScore.apply ? 'APPLY_MASTER_RESUME' : 'SKIP_LOW_SCORE',
      matchedSkills: initialScore.matched_skills || [],
      missingSkills: initialScore.missing_from_resume || [],
      reason: initialScore.reasoning || 'Score below threshold.',
    };
  }
}

module.exports = new AIMatchEngine();
