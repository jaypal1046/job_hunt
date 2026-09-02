# Autonomous Job Search Engine (Gemini AI & Multi-Channel Communication)

A unified autonomous program that automates job searching, application submission, and profile refreshing across multiple job portals (**Wellfound**, **Naukri**, and **LinkedIn-ready**) using **Google Gemini AI** and **Email Communication Channels**.

---

## Key Features

1. **Unified Automation Orchestrator**: Runs Naukri profile refresh and Wellfound auto-apply in a single command.
2. **Gemini AI Integration**:
   - **Job Suitability Analysis**: Evaluates job descriptions against candidate CV to calculate a match score.
   - **Tailored Cover Letter Generation**: Generates customized cover letters per role & company.
   - **Smart Q&A Answering**: Auto-fills recruiter questions using candidate experience context.
3. **Communication Channel (Email Alerts & Daily Reports)**:
   - Automated Email notifications for daily application summaries.
   - Immediate alert emails with screenshot attachments when manual 2FA or Captcha intervention is required.
4. **Safety & Pacing**:
   - Off-screen persistent Chrome sessions.
   - Customizable daily caps (e.g. 50/day on Wellfound, 20/day on Naukri).
   - Human-like randomized delays between applications.
   - DRY RUN mode enabled by default (fills forms without clicking Send until `--live` flag is supplied).
5. **LinkedIn Next Stage Ready**:
   - Standardized adapter interface (`src/modules/linkedin-adapter.js`) for easy expansion in the next phase.

---

## Project Structure

```
marge/
├── config.js                 # Unified configuration & .env loader
├── main.js                   # Entry point CLI & orchestrator
├── package.json              # Dependencies
├── .env.example              # Template environment file
├── profiles/                 # Persistent browser sessions (git-ignored)
│   ├── .naukri-chrome-profile
│   └── .wellfound-chrome-profile
├── src/
│   ├── modules/
│   │   ├── base-adapter.js   # Standard adapter interface
│   │   ├── naukri-adapter.js # Naukri headline refresher module
│   │   ├── wellfound-adapter.js # Wellfound auto-apply & AI module
│   │   └── linkedin-adapter.js  # LinkedIn adapter (Next Stage ready)
│   └── services/
│       ├── gemini.js         # Gemini AI evaluation & cover letter service
│       ├── logger.js         # Logging & CSV application tracker
│       └── notifier.js       # Email SMTP & notification service
└── logs/                     # Log files & screenshots (git-ignored)
    ├── system.log
    ├── state-wellfound.json
    └── state-naukri.json
```

---

## Setup & Installation

### 1. Install Dependencies
```powershell
cd c:\Users\jaypr\Desktop\resume\marge
npm install
```

### 2. Configure `.env`
Copy `.env.example` to `.env` and fill in your details:
```powershell
copy .env.example .env
```

Key variables to update:
- `GEMINI_API_KEY`: Get your free key at [Google AI Studio](https://aistudio.google.com/)
- `GOOGLE_EMAIL` & `GOOGLE_PASSWORD`: For automated Naukri sign-in.
- `CANDIDATE_*`: Your contact details, skills, CTC, and career highlights.
- `EMAIL_NOTIFICATIONS_ENABLED`: Set to `true` if you want daily email summaries & captcha alerts via SMTP.

---

## Usage Guide

### Continuous Background Interval Mode (Recommended)
Double-click the batch files inside `marge`:

- **[`start_engine.bat`](file:///c:/Users/jaypr/Desktop/resume/marge/start_engine.bat)**:
  Runs the engine in the background continuously every 60 minutes as long as your laptop is on.
  Each cycle automatically executes:
  1. Naukri Resume Headline Refresh
  2. Naukri Auto-Apply (Flutter & Full-Stack Jobs)
  3. Wellfound Auto-Apply & Cover Letter Generation
  4. Email Report Delivery

- **[`stop_engine.bat`](file:///c:/Users/jaypr/Desktop/resume/marge/stop_engine.bat)**:
  Stops the running background engine daemon immediately.

---

### Command Line Interface (CLI)
```powershell
# Run continuous background daemon loop (runs every 60 mins)
node main.js daemon --live --interval=60

# Stop running daemon
node main.js stop

# Run single cycle live
node main.js run --live
```

Target specific platform:
```powershell
node main.js run --live --site=wellfound
node main.js run --live --site=naukri
```

### Hourly Naukri Profile Refresh
```powershell
node main.js refresh
```

### Test Communication Channel
```powershell
node main.js test-notify
```

---

## Application Logs & Export

Every submitted application is logged to `applications.csv` with:
- Date & Timestamp
- Platform (Site)
- Job Title & Company
- CTC / Salary
- Gemini Match Score
- Extracted Skills
- Job Link & Description
