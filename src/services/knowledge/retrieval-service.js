/**
 * Retrieval Service — Retrieval Before LLM Pipeline
 * Searches Candidate Knowledge Base for relevant evidence matching job requirements.
 * Enforces confidence thresholds:
 * - Professional Experience: >= 0.70
 * - Project Experience: >= 0.70
 * - GitHub Evidence: >= 0.75
 */
const kb = require('./knowledge-base');

class RetrievalService {
  /**
   * Retrieves top relevant evidence for extracted job skills/keywords
   */
  retrieveRelevantEvidence(requiredSkills = [], minConfidence = 0.70) {
    const matchedEvidence = {
      professional: [],
      projects: [],
      github: [],
      allMatchedSkills: new Set(),
    };

    const searchSkills = requiredSkills.map((s) => s.toLowerCase().trim());

    // 1. Search Professional Experience (Threshold >= 0.70)
    for (const exp of kb.professionalExperiences) {
      if (exp.confidence < 0.70) continue;
      const overlaps = exp.skills.filter((sk) =>
        searchSkills.some((req) => sk.toLowerCase().includes(req) || req.includes(sk.toLowerCase()))
      );

      if (overlaps.length > 0 || searchSkills.length === 0) {
        overlaps.forEach((s) => matchedEvidence.allMatchedSkills.add(s));
        matchedEvidence.professional.push({
          source: exp.company,
          role: exp.role,
          type: 'professional',
          matchedSkills: overlaps,
          confidence: exp.confidence,
          details: exp.details,
        });
      }
    }

    // 2. Search Project Evidence (Threshold >= 0.70)
    for (const proj of kb.projects) {
      if (proj.confidence < 0.70) continue;
      const overlaps = proj.skills.filter((sk) =>
        searchSkills.some((req) => sk.toLowerCase().includes(req) || req.includes(sk.toLowerCase()))
      );

      if (overlaps.length > 0) {
        overlaps.forEach((s) => matchedEvidence.allMatchedSkills.add(s));
        matchedEvidence.projects.push({
          source: proj.title,
          type: 'project',
          matchedSkills: overlaps,
          confidence: proj.confidence,
          details: proj.details,
        });
      }
    }

    // 3. Search GitHub Evidence (Threshold >= 0.75)
    for (const gh of kb.githubEvidence) {
      if (gh.confidence < 0.75) continue;
      const overlaps = gh.skills.filter((sk) =>
        searchSkills.some((req) => sk.toLowerCase().includes(req) || req.includes(sk.toLowerCase()))
      );

      if (overlaps.length > 0) {
        overlaps.forEach((s) => matchedEvidence.allMatchedSkills.add(s));
        matchedEvidence.github.push({
          source: gh.repo,
          type: 'github',
          matchedSkills: overlaps,
          confidence: gh.confidence,
          details: gh.details,
        });
      }
    }

    return {
      professional: matchedEvidence.professional,
      projects: matchedEvidence.projects,
      github: matchedEvidence.github,
      matchedSkills: Array.from(matchedEvidence.allMatchedSkills),
    };
  }

  getMasterResume() {
    return kb.candidate;
  }
}

module.exports = new RetrievalService();
