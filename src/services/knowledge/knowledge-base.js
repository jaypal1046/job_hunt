/**
 * Candidate Factual Knowledge Base — Source of Truth
 * Contains factual candidate profile, professional experiences, side projects, and GitHub repositories.
 */
const candidateKnowledgeBase = {
  candidate: {
    name: 'Jayprakash Pal',
    targetRole: 'Flutter Developer / Mobile Engineer',
    totalExperienceYears: 4,
    location: 'Mumbai / Remote India',
    coreSkills: [
      'Flutter',
      'Dart',
      'Android Native',
      'iOS',
      'REST APIs',
      'State Management (Provider, Bloc, GetX)',
      'Firebase',
      'Git',
      'CI/CD Pipelines',
      'Node.js',
    ],
  },

  professionalExperiences: [
    {
      company: 'ICICI Lombard / Mobile Development',
      role: 'Senior Flutter Engineer',
      skills: ['Flutter', 'Dart', 'Insurance Domain', 'REST APIs', 'Payment Gateways', 'Encryption'],
      confidence: 1.0,
      details: 'Built enterprise Flutter insurance & mobile banking applications with seamless payment integration, biometric auth, and high-performance UI.',
    },
    {
      company: 'Mobile Tech Solutions',
      role: 'Flutter & Native Mobile Developer',
      skills: ['Flutter', 'Dart', 'Android (Java/Kotlin)', 'iOS (Swift)', 'SQLite', 'Push Notifications'],
      confidence: 1.0,
      details: 'Developed cross-platform mobile apps, optimized native bridge integrations, and implemented state management architectures.',
    },
  ],

  projects: [
    {
      title: 'Autonomous Job Application System',
      skills: ['Node.js', 'Playwright', 'Gemini AI', 'Automation', 'REST APIs'],
      confidence: 0.95,
      details: 'Designed and built 3-stage automated job application engine with 4-tier waterfall duplicate detection and multi-platform scrapers.',
    },
    {
      title: 'Real-time Flutter Chat & E-Commerce App',
      skills: ['Flutter', 'Firebase', 'WebSockets', 'Razorpay', 'State Management'],
      confidence: 0.90,
      details: 'Full-featured Flutter mobile application with real-time messaging, order tracking, and payment processing.',
    },
  ],

  githubEvidence: [
    {
      repo: 'jayprakash/flutter-state-architecture',
      skills: ['Flutter', 'Bloc', 'Provider', 'Architecture'],
      confidence: 0.85,
      details: 'Clean Architecture implementation for scalable Flutter applications.',
    },
    {
      repo: 'jayprakash/mobile-automation-agent',
      skills: ['Node.js', 'Playwright', 'LLM RAG', 'Automation'],
      confidence: 0.80,
      details: 'Automated browser web scraping and AI evaluation suite.',
    },
  ],
};

module.exports = candidateKnowledgeBase;
