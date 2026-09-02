/**
 * Abstract LLMProvider Interface
 * Base contract for LLM models (Gemini, Gemma, etc.)
 */
class LLMProvider {
  /**
   * Fast Layer 1 Job Requirement & Keyword Analysis
   */
  async analyzeJob(jobTitle, companyName, jobDescription) {
    throw new Error('Method analyzeJob() must be implemented');
  }

  /**
   * Calculate initial Resume Score vs candidate profile
   */
  async scoreResume(jobTitle, companyName, jobDescription, candidateSkills) {
    throw new Error('Method scoreResume() must be implemented');
  }

  /**
   * Layer 2 Deep Resume Analysis & Tailoring
   */
  async tailorResume(jobDescription, masterResume, evidence) {
    throw new Error('Method tailorResume() must be implemented');
  }

  /**
   * Validate generated output against strict factual safety rules
   */
  async validateResume(tailoredResume, masterResume) {
    throw new Error('Method validateResume() must be implemented');
  }
}

module.exports = LLMProvider;
