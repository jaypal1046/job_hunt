/**
 * LinkedIn Networking & Job Application Module (v2.0)
 *
 * Multi-Strategy Engine:
 * 1. Connection Outreach (Primary):
 *    - 4-tier search: Decision Makers, Recruiters, Peers, Freelance Sources
 *    - AI-powered personalized connection notes via Gemini
 *    - Profile warmup (view before connect)
 *    - Multi-page pagination (3+ pages per search)
 *    - Persistent cross-day deduplication
 *
 * 2. EasyApply Jobs (Secondary):
 *    - Auto-applies to matching LinkedIn EasyApply postings
 *    - Gemini job evaluation & Q&A answering
 *    - Multi-step wizard handling
 */
const path = require('path');
const fs = require('fs');
const BaseAdapter = require('./base-adapter');
const CONFIG = require('../../config');
const { log, getDayState, bumpDayCount, hasBeenSeen, recordAction, logApplication, isPermanentlySeen, recordPermanent } = require('../services/logger');
const gemini = require('../services/gemini');
const notifier = require('../services/notifier');

let chromium;
try {
  const { addExtra } = require('playwright-extra');
  chromium = addExtra(require('playwright-core').chromium);
  chromium.use(require('puppeteer-extra-plugin-stealth')());
} catch (e) {
  ({ chromium } = require('playwright-core'));
}

const CONNECTIONS_CSV = path.join(CONFIG.paths.logs, 'linkedin_connections.csv');

// ============================================================================
// Multi-Tier Search Strategy
// ============================================================================
const SEARCH_CATEGORIES = {
  // Tier 1: Direct hiring decision makers (highest value)
  decisionMakers: [
    { keywords: 'Engineering Manager Flutter Mobile', type: 'job' },
    { keywords: 'VP Engineering Mobile Apps India', type: 'job' },
    { keywords: 'Head of Engineering Startup India', type: 'job' },
    { keywords: 'CTO Startup Mobile Flutter', type: 'freelance' },
  ],
  // Tier 2: Recruiters & HR (highest ROI for job finding)
  recruiters: [
    { keywords: 'Technical Recruiter Flutter Developer India', type: 'job' },
    { keywords: 'HR Manager Hiring Flutter Mobile', type: 'job' },
    { keywords: 'Talent Acquisition Mobile Developer India', type: 'job' },
    { keywords: 'IT Recruiter Pune Mumbai Bangalore', type: 'job' },
  ],
  // Tier 3: Peer network (referrals & community)
  peers: [
    { keywords: 'Senior Flutter Developer India', type: 'job' },
    { keywords: 'Senior Full Stack Engineer Node.js India', type: 'job' },
    { keywords: 'Staff Engineer Mobile India', type: 'job' },
  ],
  // Tier 4: Freelance/Contract sources
  freelance: [
    { keywords: 'Founder CEO Mobile App Startup India', type: 'freelance' },
    { keywords: 'Product Manager Flutter App', type: 'freelance' },
  ],
};

// LinkedIn EasyApply Job Search URLs
const JOB_SEARCH_URLS = [
  // f_AL=true = Easy Apply only, sortBy=DD = Most Recent
  'https://www.linkedin.com/jobs/search/?keywords=Flutter%20Developer&f_AL=true&sortBy=DD&location=India',
  'https://www.linkedin.com/jobs/search/?keywords=Mobile%20Developer%20Flutter&f_AL=true&sortBy=DD&location=India',
  'https://www.linkedin.com/jobs/search/?keywords=Full%20Stack%20Developer%20Node.js&f_AL=true&sortBy=DD&location=India',
  'https://www.linkedin.com/jobs/search/?keywords=Senior%20Software%20Engineer&f_AL=true&sortBy=DD&location=India',
];

// ============================================================================
// Helper: Human-like random delay
// ============================================================================
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Detect role type from a person's title for note strategy
 */
function detectRoleType(title) {
  const t = (title || '').toLowerCase();
  if (/recruiter|talent|hr manager|hiring|sourcer|people ops/i.test(t)) return 'recruiter';
  if (/founder|ceo|co-founder|owner|managing director/i.test(t)) return 'founder';
  if (/cto|vp eng|head of eng|director of eng|engineering manager|eng manager|tech lead|principal/i.test(t)) return 'leader';
  if (/developer|engineer|architect|sde|swe|programmer|full.?stack|flutter|mobile|backend|frontend/i.test(t)) return 'peer';
  return 'general';
}

class LinkedInAdapter extends BaseAdapter {
  constructor() {
    super('linkedin');
    this.profileDir = path.join(CONFIG.paths.profiles, '.linkedin-chrome-profile');
    this.loginUrl = 'https://www.linkedin.com/login';
    this.dailyConnectionCap = CONFIG.linkedin?.dailyConnectionCap || 15;
    this.dailyJobCap = CONFIG.linkedin?.dailyJobCap || 10;
    this.enableEasyApply = CONFIG.linkedin?.enableEasyApply !== false;
    this.enableProfileWarmup = CONFIG.linkedin?.enableProfileWarmup !== false;
    this.searchPages = CONFIG.linkedin?.searchPages || 3;
    // Cache AI-generated notes by roleType to avoid burning Gemini API quota
    // Key: roleType (recruiter/founder/leader/peer/general), Value: generated note template
    this.noteCache = {};
    this.initCsv();
  }

  initCsv() {
    if (!fs.existsSync(CONNECTIONS_CSV)) {
      try {
        const header = '"Date","Name","Title","Role Type","Connection Type","Note Preview","Profile Link"\n';
        fs.writeFileSync(CONNECTIONS_CSV, '\uFEFF' + header);
      } catch (e) {}
    }
  }

  logConnection(name, title, roleType, type, note, link) {
    try {
      const csvRow = (vals) => vals.map((v) => '"' + String(v || '').replace(/"/g, '""').replace(/\s+/g, ' ').trim() + '"').join(',') + '\n';
      fs.appendFileSync(CONNECTIONS_CSV, csvRow([new Date().toLocaleString(), name, title, roleType, type, note.slice(0, 120), link]));
      log('linkedin', `Logged connection request: ${name} (${title}) [${roleType}/${type}]`);
    } catch (e) {}
  }

  // ============================================================================
  // LOGIN
  // ============================================================================
  async login() {
    log('linkedin', 'Opening visible Chrome browser for manual LinkedIn login...');
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log('linkedin', 'Please log in to LinkedIn in the browser window, then close the browser when done.');

    await new Promise((res) => ctx.on('close', res));
    log('linkedin', 'LinkedIn login session saved to profile directory.');
  }

  // ============================================================================
  // PHASE 1 + 6: AI-Powered, Role-Based Connection Notes
  // ============================================================================
  async generateConnectionNote(personName, personTitle, searchType = 'job') {
    const cv = CONFIG.cv;
    const cleanName = personName.split(' ')[0].replace(/[^a-zA-Z]/g, '') || 'there';
    const roleType = detectRoleType(personTitle);

    // Strategy: Generate ONE AI note per roleType per run, then personalize with name swap.
    // This reduces Gemini API calls from ~390/run to ~5/run (one per role type).
    if (this.noteCache[roleType]) {
      // Replace cached name placeholder with current person's name
      const cached = this.noteCache[roleType].replace(/\{NAME\}/g, cleanName);
      log('linkedin', `  📋 Using cached ${roleType} note for ${cleanName}`);
      return cached;
    }

    // Try Gemini AI to generate ONE template for this roleType
    try {
      let roleContext = '';
      switch (roleType) {
        case 'recruiter':
          roleContext = `They are a recruiter/HR. Mention you're actively looking for senior Flutter/Full-Stack roles, 4.5+ years experience, delivered 10M+ download apps. Keep it short and direct.`;
          break;
        case 'founder':
          roleContext = `They are a founder/CEO. Angle: freelance/consulting/collaboration. Mention FlutterJS (your open source tool), production apps, 10M+ downloads track record.`;
          break;
        case 'leader':
          roleContext = `They are an engineering leader. Mention shared tech interest, senior-level experience, and interest in opportunities on their team.`;
          break;
        case 'peer':
          roleContext = `They are a fellow developer. Angle: community/knowledge sharing. Mention your open source tools (FlutterJS, Browser-Copilot).`;
          break;
        default:
          roleContext = `Generic professional connection. Mention your Flutter & Full-Stack engineering background.`;
      }

      const prompt = `Write a LinkedIn connection note (MAXIMUM 280 characters).
From: ${cv.name} (${cv.currentRole}, ${cv.yearsOfExperience} experience)
To: {NAME} (a ${roleType})
${roleContext}
Rules:
- Start with "Hi {NAME}," (use exactly "{NAME}" as a placeholder — I will replace it later)
- Be natural and human, NOT robotic
- No emojis, no exclamation marks spam
- End with clear intent (connect/explore/collaborate)
- MUST be under 280 characters total.`;

      const aiNote = await gemini.callGemini(prompt);
      if (aiNote && aiNote.length > 20 && aiNote.length <= 300) {
        let cleaned = aiNote.replace(/^["']|["']$/g, '').trim();
        // Ensure it has the {NAME} placeholder, or add it
        if (!cleaned.includes('{NAME}')) {
          cleaned = cleaned.replace(/^Hi\s+\w+/i, 'Hi {NAME}');
        }
        if (cleaned.length <= 300) {
          this.noteCache[roleType] = cleaned;
          log('linkedin', `  🧠 AI template cached for ${roleType}: "${cleaned.slice(0, 80)}..."`);
          return cleaned.replace(/\{NAME\}/g, cleanName);
        }
      }
    } catch (err) {
      log('linkedin', `  ⚠ Gemini note generation failed for ${roleType}, using template: ${err.message}`);
    }

    // Fallback: role-based templates (no API call needed)
    let template;
    switch (roleType) {
      case 'recruiter':
        template = `Hi {NAME}, I'm a Sr. Flutter & Full-Stack Engineer (${cv.yearsOfExperience} exp, delivered 10M+ download apps). Actively exploring senior roles — would love to connect if you're hiring in this space.`;
        break;
      case 'founder':
        template = `Hi {NAME}, I build production mobile & web apps (Flutter/Node.js, ${cv.yearsOfExperience} exp). Creator of FlutterJS. Would love to connect for potential freelance projects or tech collaborations.`;
        break;
      case 'leader':
        template = `Hi {NAME}, noticed your engineering leadership role. I'm a Sr. Flutter & Full-Stack Eng (${cv.yearsOfExperience} exp, shipped ILTakeCare 10M+ downloads). Would love to connect & explore opportunities.`;
        break;
      case 'peer':
        template = `Hi {NAME}, fellow developer here — Sr. Flutter & Full-Stack Eng. I build open-source tools (FlutterJS, Browser-Copilot). Always great to connect with engineers in the space.`;
        break;
      default:
        template = `Hi {NAME}, I'm ${cv.name}, a Sr. Flutter & Full-Stack Engineer with ${cv.yearsOfExperience} experience. Would love to connect and exchange ideas.`;
    }
    this.noteCache[roleType] = template;
    return template.replace(/\{NAME\}/g, cleanName);
  }

  // ============================================================================
  // PHASE 5: Profile View Warmup (uses separate tab — doesn't break search page)
  // ============================================================================
  async warmupProfileView(ctx, profileUrl) {
    if (!this.enableProfileWarmup) return null;

    let warmupPage = null;
    try {
      log('linkedin', `  👀 Warming up profile view: ${profileUrl}`);
      warmupPage = await ctx.newPage();
      await warmupPage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await warmupPage.waitForTimeout(randomDelay(2000, 4000)); // Human-like browse time

      // Scroll down a bit to simulate reading
      await warmupPage.evaluate(() => window.scrollTo(0, 400));
      await warmupPage.waitForTimeout(randomDelay(800, 1500));

      // Extract profile data for richer AI context
      const profileData = await warmupPage.evaluate(() => {
        const getText = (sel) => {
          const el = document.querySelector(sel);
          return el ? el.innerText.trim().slice(0, 300) : '';
        };
        return {
          headline: getText('.text-body-medium.break-words'),
          about: getText('[class*="about"] .full-width, section.pv-about-section .pv-about__summary-text'),
          currentCompany: getText('.pv-text-details__right-panel-item-text, .inline-show-more-text'),
        };
      });

      log('linkedin', `  👀 Profile viewed: headline="${(profileData.headline || '').slice(0, 60)}"`);
      return profileData;
    } catch (err) {
      log('linkedin', `  ⚠ Profile warmup failed: ${err.message}`);
      return null;
    } finally {
      // Always close the warmup tab to keep memory clean
      if (warmupPage && !warmupPage.isClosed()) {
        await warmupPage.close().catch(() => {});
      }
    }
  }

  // ============================================================================
  // PHASE 2: Expanded Connection Search + Multi-Page Pagination
  // ============================================================================
  async sendConnections(ctx, page, isLive) {
    const dayState = getDayState('linkedin_connections');
    const targetCount = this.dailyConnectionCap - dayState.count;

    if (targetCount <= 0) {
      log('linkedin', `Daily connection limit of ${this.dailyConnectionCap} reached (${dayState.count} sent today). Skipping.`);
      return 0;
    }

    log('linkedin', `Starting LinkedIn Connection Builder v2.0 (Target: ${targetCount}, Mode: ${isLive ? 'LIVE' : 'DRY RUN'})...`);

    // Build today's search list — rotate through all tiers
    const allSearches = [];
    const tierNames = Object.keys(SEARCH_CATEGORIES);
    // Round-robin across tiers for balanced coverage
    const maxPerTier = Math.max(...tierNames.map((t) => SEARCH_CATEGORIES[t].length));
    for (let i = 0; i < maxPerTier; i++) {
      for (const tier of tierNames) {
        if (SEARCH_CATEGORIES[tier][i]) {
          allSearches.push({ ...SEARCH_CATEGORIES[tier][i], tier });
        }
      }
    }

    let sentCount = 0;

    for (const search of allSearches) {
      if (sentCount >= targetCount) break;

      // Multi-page pagination
      for (let pageNum = 1; pageNum <= this.searchPages; pageNum++) {
        if (sentCount >= targetCount) break;

        const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(search.keywords)}&page=${pageNum}`;
        log('linkedin', `[${search.tier.toUpperCase()}] Searching: "${search.keywords}" (Page ${pageNum}/${this.searchPages})`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(randomDelay(3000, 5000));

          // Scroll to load lazy content
          for (let scroll = 0; scroll < 3; scroll++) {
            await page.evaluate((y) => window.scrollTo(0, y), 400 * (scroll + 1));
            await page.waitForTimeout(randomDelay(800, 1500));
          }

          // Native JS DOM extraction with Connection Status Inspection
          const people = await page.evaluate(() => {
            const cards = [];
            const titleLinks = document.querySelectorAll('.entity-result__title-text a, a[href*="/in/"]');
            for (const a of titleLinks) {
              const href = a.href ? a.href.split('?')[0] : '';
              if (!href || !href.includes('/in/') || href.includes('jayprakashpal') || cards.some((c) => c.link === href)) continue;

              let container = a.closest('.entity-result, .reusable-search__result-container') || a.closest('li');
              const rawName = a.textContent.trim().split('\n')[0].replace(/•.*/, '').trim();
              const titleEl = container ? container.querySelector('.entity-result__primary-subtitle, [class*="subtitle"], .t-14.t-normal') : null;
              const title = titleEl ? titleEl.textContent.trim() : '';

              let isConnected = false;
              let isPending = false;
              let canConnect = false;

              if (container) {
                const fullText = (container.textContent || '').toLowerCase();
                const badgeEl = container.querySelector('.entity-result__badge-text, [class*="badge"]');
                const badgeText = badgeEl ? badgeEl.textContent.trim().toLowerCase() : '';

                // 1. Check if 1st degree connection (already connected)
                if (/\b1st\b/i.test(badgeText) || /\b1st\b/i.test(fullText)) {
                  isConnected = true;
                }

                // 2. Check text and buttons for Pending / Withdraw / Requested
                if (
                  /pending/i.test(fullText) ||
                  /requested/i.test(fullText) ||
                  /invitation sent/i.test(fullText) ||
                  /withdraw/i.test(fullText)
                ) {
                  isPending = true;
                }

                // 3. Check for Connect button availability
                const buttons = [...container.querySelectorAll('button, a[role="button"]')];
                for (const btn of buttons) {
                  const txt = (btn.textContent || '').trim().toLowerCase();
                  const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                  if (txt === 'pending' || aria.includes('pending') || txt === 'requested' || txt === 'withdraw') {
                    isPending = true;
                  }
                  if (/^connect$/i.test(txt) || /invite.*to connect/i.test(aria) || /^connect\b/i.test(txt)) {
                    canConnect = true;
                  }
                  if (/^more$/i.test(txt) || /more actions/i.test(aria)) {
                    // "More" button might contain Connect inside dropdown
                    if (!isConnected && !isPending) {
                      canConnect = true;
                    }
                  }
                }
              }

              if (rawName && rawName.length > 2 && !/linkedin member|status|notifications/i.test(rawName)) {
                cards.push({
                  name: rawName,
                  title,
                  link: href,
                  isConnected,
                  isPending,
                  canConnect,
                });
              }
            }
            return cards;
          });

          log('linkedin', `  Found ${people.length} profiles on page ${pageNum}.`);

          for (const person of people) {
            if (sentCount >= targetCount) break;

            const itemKey = person.link || `${person.name}_${person.title}`;

            // 1. Cross-day permanent & same-day dedup check (Instant O(1) memory lookup)
            if (isPermanentlySeen(itemKey) || hasBeenSeen('linkedin_connections', itemKey)) {
              continue; // Silently skip — already processed in past
            }

            // 2. DOM inspection check: Already 1st degree connected
            if (person.isConnected) {
              log('linkedin', `  ⏭ Skipping ${person.name}: Already 1st degree connected.`);
              recordPermanent({ key: itemKey, name: person.name, title: person.title, link: person.link, type: 'already_connected' });
              continue;
            }

            // 3. DOM inspection check: Connection request already sent (Pending)
            if (person.isPending) {
              log('linkedin', `  ⏭ Skipping ${person.name}: Connection request already sent (Pending).`);
              recordPermanent({ key: itemKey, name: person.name, title: person.title, link: person.link, type: 'already_pending' });
              continue;
            }

            const roleType = detectRoleType(person.title);

            if (isLive) {
              // Verify Connect button attempt BEFORE profile warmup / AI note to save time and quota
              const clickedConnect = await this.clickConnectButton(page, person);

              if (clickedConnect) {
                log('linkedin', `  ▶ [${roleType.toUpperCase()}] ${person.name} — ${person.title || 'No title'}`);

                // Profile warmup (only for valid connectable profiles)
                if (this.enableProfileWarmup && person.link) {
                  await this.warmupProfileView(ctx, person.link);
                }

                // Generate AI-powered note
                const note = await this.generateConnectionNote(person.name, person.title, search.type);
                log('linkedin', `     Note: "${note.slice(0, 110)}..."`);

                await page.waitForTimeout(1500);

                // Handle "Add a note" modal vs Direct Send
                const addNoteBtn = page.locator('button:has-text("Add a note"), button[aria-label*="Add a note"]').first();
                if (await addNoteBtn.isVisible().catch(() => false)) {
                  await addNoteBtn.click();
                  await page.waitForTimeout(1000);

                  const textarea = page.locator('textarea[name="message"], #custom-message, textarea').first();
                  if (await textarea.isVisible().catch(() => false)) {
                    await textarea.fill(note);
                    await page.waitForTimeout(1000);

                    const sendBtn = page.locator('button:has-text("Send"), button[aria-label*="Send"]').first();
                    if (await sendBtn.isVisible().catch(() => false)) {
                      await sendBtn.click();
                      log('linkedin', `  ✅ Connection SENT with AI note to ${person.name} [${roleType}]`);
                    }
                  }
                } else {
                  // Direct "Send without a note" or "Send" button
                  const sendBtn = page.locator('button:has-text("Send without a note"), button:has-text("Send"), button[aria-label*="Send"]').first();
                  if (await sendBtn.isVisible().catch(() => false)) {
                    await sendBtn.click();
                    log('linkedin', `  ✅ Connection SENT (no note modal) to ${person.name}`);
                  }
                }

                // Record to CSV, daily state, and permanent history
                const recordObj = {
                  key: itemKey,
                  title: person.name,
                  company: person.title,
                  type: search.type === 'freelance' ? 'Freelance Outreach' : 'Job Networking',
                  link: person.link,
                };
                this.logConnection(person.name, person.title, roleType, search.type, note, person.link);
                recordAction('linkedin_connections', recordObj, true);
                recordPermanent({ key: itemKey, name: person.name, title: person.title, link: person.link, type: `connection_${roleType}` });
                sentCount++;
              } else {
                log('linkedin', `  ⏭ Connect button unavailable for ${person.name} (already connected/pending).`);
                recordAction('linkedin_connections', { key: itemKey, title: person.name, company: person.title, type: 'Already Connected / Pending', link: person.link }, false);
                recordPermanent({ key: itemKey, name: person.name, title: person.title, link: person.link, type: 'already_connected' });
              }
            } else {
              if (person.canConnect) {
                log('linkedin', `  ▶ [${roleType.toUpperCase()}] ${person.name} — ${person.title || 'No title'}`);
                log('linkedin', `  🔍 DRY_RUN — would send ${roleType} connection note to ${person.name}`);
                recordPermanent({ key: itemKey, name: person.name, title: person.title, link: person.link, type: `dryrun_${roleType}` });
                sentCount++;
              } else {
                log('linkedin', `  ⏭ DRY_RUN — skipping ${person.name} (already connected/pending).`);
                recordPermanent({ key: itemKey, name: person.name, title: person.title, link: person.link, type: 'already_connected' });
              }
            }

            // Human-like delay between connection attempts
            await page.waitForTimeout(randomDelay(2500, 5000));
          }
        } catch (err) {
          log('linkedin', `Error processing search "${search.keywords}" page ${pageNum}: ${err.message}`);
        }
      }
    }

    log('linkedin', `Connection builder finished (${sentCount} requests processed across all tiers).`);
    return sentCount;
  }

  /**
   * Click the Connect button for a person on the search results page
   */
  async clickConnectButton(page, person) {
    const actionResult = await page.evaluate(([targetHref]) => {
      const getProfileId = (url) => {
        if (!url) return '';
        const match = String(url).match(/\/in\/([^\/\?#]+)/i);
        return match ? match[1].toLowerCase().trim() : '';
      };

      const targetId = getProfileId(targetHref);
      const links = [...document.querySelectorAll('a[href*="/in/"]')];
      const matchLink = links.find((a) => getProfileId(a.href) === targetId);
      if (!matchLink) return { success: false, reason: 'Profile link not found on page' };

      const card = matchLink.closest('.entity-result, .reusable-search__result-container') || matchLink.closest('li');
      if (!card) return { success: false, reason: 'Card container not found' };

      const fullText = (card.textContent || '').toLowerCase();
      const badgeEl = card.querySelector('.entity-result__badge-text, [class*="badge"]');
      const badgeText = badgeEl ? badgeEl.textContent.trim().toLowerCase() : '';

      // Check if already 1st degree connected or request pending
      if (/\b1st\b/i.test(badgeText) || /\b1st\b/i.test(fullText)) {
        return { success: false, reason: 'Already 1st degree connected' };
      }
      if (/pending/i.test(fullText) || /requested/i.test(fullText) || /invitation sent/i.test(fullText) || /withdraw/i.test(fullText)) {
        return { success: false, reason: 'Connection request already sent (Pending)' };
      }

      const buttons = [...card.querySelectorAll('button, a[role="button"]')];

      // 1. Direct Connect button
      const connectBtn = buttons.find((b) => {
        const text = (b.textContent || '').trim();
        const aria = b.getAttribute('aria-label') || '';
        return /^connect$/i.test(text) || /invite.*to connect/i.test(aria) || /^connect\b/i.test(text);
      });

      if (connectBtn) {
        const txt = (connectBtn.textContent || '').trim().toLowerCase();
        if (txt === 'pending' || txt === 'requested' || txt === 'message') {
          return { success: false, reason: 'Already connected or pending' };
        }
        connectBtn.scrollIntoView({ block: 'center' });
        connectBtn.click();
        return { success: true, mode: 'direct' };
      }

      // 2. More dropdown button
      const moreBtn = buttons.find((b) => {
        const text = (b.textContent || '').trim();
        const aria = b.getAttribute('aria-label') || '';
        return /^more$/i.test(text) || /more actions/i.test(aria) || /artdeco-dropdown__trigger/i.test(b.className);
      });

      if (moreBtn) {
        moreBtn.scrollIntoView({ block: 'center' });
        moreBtn.click();
        return { success: true, mode: 'more' };
      }

      return { success: false, reason: 'No connect or more button visible' };
    }, [person.link]);

    if (!actionResult.success) return false;

    if (actionResult.mode === 'direct') return true;

    if (actionResult.mode === 'more') {
      await page.waitForTimeout(1000);
      const dropdownConnect = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.artdeco-dropdown__content button, .artdeco-dropdown__content [role="button"], [role="menu"] button, [role="menu"] [role="button"], [role="menuitem"], .artdeco-dropdown__item')];
        const connItem = items.find((b) => {
          const text = (b.textContent || '').trim();
          const aria = b.getAttribute('aria-label') || '';
          return /^connect$/i.test(text) || /invite.*to connect/i.test(aria) || /^connect\b/i.test(text);
        });
        const pendingItem = items.find((b) => {
          const text = (b.textContent || '').trim().toLowerCase();
          return text.includes('pending') || text.includes('withdraw') || text.includes('remove connection');
        });

        if (pendingItem && !connItem) {
          return false;
        }

        if (connItem) {
          connItem.click();
          return true;
        }
        return false;
      });
      return dropdownConnect;
    }

    return false;
  }

  // ============================================================================
  // PHASE 3: LinkedIn EasyApply Job Automation
  // ============================================================================
  async searchAndApplyJobs(page, ctx, isLive) {
    if (!this.enableEasyApply) {
      log('linkedin', 'EasyApply is disabled in config. Skipping job applications.');
      return 0;
    }

    const dayState = getDayState('linkedin_jobs');
    const targetCount = this.dailyJobCap - dayState.count;

    if (targetCount <= 0) {
      log('linkedin', `Daily job apply limit of ${this.dailyJobCap} reached (${dayState.count} applied today). Skipping.`);
      return 0;
    }

    log('linkedin', `Starting LinkedIn EasyApply (Target: ${targetCount}, Mode: ${isLive ? 'LIVE' : 'DRY RUN'})...`);
    let appliedCount = 0;

    for (const searchUrl of JOB_SEARCH_URLS) {
      if (appliedCount >= targetCount) break;

      try {
        log('linkedin', `Searching jobs: ${searchUrl.split('keywords=')[1]?.split('&')[0] || searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(randomDelay(3000, 5000));

        // Scroll to load job cards
        for (let s = 0; s < 3; s++) {
          await page.evaluate((y) => window.scrollTo(0, y), 400 * (s + 1));
          await page.waitForTimeout(randomDelay(500, 1000));
        }

        // Extract job listings
        const jobs = await page.evaluate(() => {
          const items = [];
          const jobCards = document.querySelectorAll('.job-card-container, .jobs-search-results__list-item, [data-job-id]');
          for (const card of jobCards) {
            const titleEl = card.querySelector('.job-card-list__title, a[class*="job-card"],.job-card-container__link');
            const companyEl = card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
            const locationEl = card.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');

            const link = titleEl ? (titleEl.href || titleEl.closest('a')?.href || '') : '';
            const title = titleEl ? titleEl.textContent.trim() : '';

            if (title && link && !items.some((j) => j.link === link)) {
              items.push({
                title: title.split('\n')[0].trim(),
                company: companyEl ? companyEl.textContent.trim() : 'LinkedIn Job',
                location: locationEl ? locationEl.textContent.trim() : '',
                link: link.split('?')[0],
              });
            }
          }
          return items;
        });

        log('linkedin', `Found ${jobs.length} job listings.`);

        for (const job of jobs) {
          if (appliedCount >= targetCount) break;

          const itemKey = job.link || `${job.title}_${job.company}`;

          if (isPermanentlySeen(itemKey) || hasBeenSeen('linkedin_jobs', itemKey)) {
            continue;
          }

          // Gemini job evaluation
          const evalResult = await gemini.evaluateJobSuitability(job.title, job.company, `${job.title} ${job.location}`);
          log('linkedin', `  ▶ Job: "${job.title}" @ "${job.company}" | Score: ${evalResult.score}%`);

          if (!evalResult.apply) {
            recordAction('linkedin_jobs', { key: itemKey, title: job.title, company: job.company, type: 'Skipped (low score)', link: job.link, matchScore: evalResult.score }, false);
            continue;
          }

          if (isLive) {
            const applied = await this.applyToJob(ctx, job);
            if (applied) {
              recordAction('linkedin_jobs', { key: itemKey, title: job.title, company: job.company, type: 'EasyApply', link: job.link, matchScore: evalResult.score }, true);
              logApplication('linkedin', { title: job.title, company: job.company, matchScore: evalResult.score, link: job.link, jd: `LinkedIn EasyApply | ${job.location}` });
              recordPermanent({ key: itemKey, name: job.title, title: job.company, link: job.link, type: 'job_applied' });
              appliedCount++;
              log('linkedin', `  ✅ EasyApply submitted: "${job.title}" @ "${job.company}"`);
            } else {
              recordPermanent({ key: itemKey, name: job.title, title: job.company, link: job.link, type: 'job_apply_failed' });
            }
          } else {
            log('linkedin', `  🔍 DRY_RUN — would EasyApply to "${job.title}" @ "${job.company}"`);
            recordPermanent({ key: itemKey, name: job.title, title: job.company, link: job.link, type: 'job_dryrun' });
            appliedCount++;
          }

          await page.waitForTimeout(randomDelay(3000, 6000));
        }
      } catch (err) {
        log('linkedin', `Error searching jobs: ${err.message}`);
      }
    }

    log('linkedin', `EasyApply finished (${appliedCount} applications processed).`);
    return appliedCount;
  }

  /**
   * Apply to a single LinkedIn EasyApply job
   */
  async applyToJob(ctx, job) {
    let jobPage = null;
    try {
      jobPage = await ctx.newPage();
      await jobPage.goto(job.link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await jobPage.waitForTimeout(randomDelay(2000, 4000));

      // Check if already applied
      const pageText = await jobPage.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
      if (/applied|submitted|application sent/i.test(pageText)) {
        log('linkedin', `  ⏭ Already applied: "${job.title}" @ "${job.company}"`);
        return false;
      }

      // Find EasyApply button
      const easyApplyBtn = jobPage.locator('button:has-text("Easy Apply"), button.jobs-apply-button, button[aria-label*="Easy Apply"]').first();
      if (!(await easyApplyBtn.isVisible().catch(() => false))) {
        log('linkedin', `  ⚠ EasyApply button not found for "${job.title}"`);
        return false;
      }

      await easyApplyBtn.click();
      await jobPage.waitForTimeout(2000);

      // Handle multi-step EasyApply wizard
      let steps = 0;
      const maxSteps = 8;

      while (steps < maxSteps) {
        steps++;

        // Check for "Submit application" button (final step)
        const submitBtn = jobPage.locator('button:has-text("Submit application"), button[aria-label*="Submit application"]').first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click();
          await jobPage.waitForTimeout(2000);
          log('linkedin', `  ✅ Application submitted after ${steps} steps.`);
          return true;
        }

        // Check for "Review" button
        const reviewBtn = jobPage.locator('button:has-text("Review"), button[aria-label*="Review"]').first();
        if (await reviewBtn.isVisible().catch(() => false)) {
          await reviewBtn.click();
          await jobPage.waitForTimeout(1500);
          continue;
        }

        // Handle text questions — answer with Gemini
        const textInputs = await jobPage.locator('.jobs-easy-apply-form-section__grouping textarea, .jobs-easy-apply-form-section__grouping input[type="text"]').all();
        for (const input of textInputs) {
          const currentValue = await input.inputValue().catch(() => '');
          if (!currentValue || currentValue.trim().length === 0) {
            // Try to find the question label
            const label = await input.evaluate((el) => {
              const labelEl = el.closest('.jobs-easy-apply-form-section__grouping')?.querySelector('label, .artdeco-text-input--label, span');
              return labelEl ? labelEl.textContent.trim() : '';
            });

            if (label) {
              const answer = await gemini.answerQuestion(label);
              await input.fill(answer);
              log('linkedin', `    📝 Answered: "${label.slice(0, 50)}" → "${answer.slice(0, 50)}..."`);
            }
          }
        }

        // Handle select dropdowns — pick first non-empty option
        const selects = await jobPage.locator('.jobs-easy-apply-form-section__grouping select').all();
        for (const sel of selects) {
          const value = await sel.inputValue().catch(() => '');
          if (!value) {
            await sel.evaluate((el) => {
              if (el.options.length > 1) {
                el.selectedIndex = 1;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          }
        }

        // Handle radio buttons — select "Yes" if available
        const radios = await jobPage.locator('.jobs-easy-apply-form-section__grouping input[type="radio"]').all();
        for (const radio of radios) {
          const labelText = await radio.evaluate((el) => {
            const lab = el.closest('label') || el.parentElement?.querySelector('label');
            return lab ? lab.textContent.trim() : '';
          });
          if (/^yes$/i.test(labelText)) {
            await radio.check().catch(() => {});
          }
        }

        // Click "Next" button to proceed
        const nextBtn = jobPage.locator('button:has-text("Next"), button[aria-label*="Continue"], button[aria-label*="Next"]').first();
        if (await nextBtn.isVisible().catch(() => false)) {
          await nextBtn.click();
          await jobPage.waitForTimeout(randomDelay(1500, 2500));
          continue;
        }

        // No actionable button found — break
        break;
      }

      // Close any open modal
      const closeBtn = jobPage.locator('button[aria-label="Dismiss"], button:has-text("Discard")').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        // Handle "Discard" confirmation
        const discardBtn = jobPage.locator('button:has-text("Discard"), button[data-control-name="discard_application_confirm_btn"]').first();
        if (await discardBtn.isVisible().catch(() => false)) {
          await discardBtn.click();
        }
      }

      log('linkedin', `  ⚠ EasyApply wizard did not complete for "${job.title}" after ${steps} steps.`);
      return false;
    } catch (err) {
      log('linkedin', `  ⚠ Error applying to "${job.title}": ${err.message}`);
      return false;
    } finally {
      if (jobPage && !jobPage.isClosed()) {
        await jobPage.close().catch(() => {});
      }
    }
  }

  // ============================================================================
  // MAIN RUN ORCHESTRATOR
  // ============================================================================
  async run(options = {}) {
    const isLive = options.live === true;
    const isLogin = options.login === true;

    if (isLogin) {
      return await this.login();
    }

    log('linkedin', '═══════════════════════════════════════════════════════════');
    log('linkedin', 'Starting LinkedIn Module v2.0 (Connections + EasyApply)...');
    log('linkedin', `Mode: ${isLive ? '🔴 LIVE' : '🔍 DRY RUN'} | Connection Cap: ${this.dailyConnectionCap} | Job Cap: ${this.dailyJobCap}`);
    log('linkedin', `Profile Warmup: ${this.enableProfileWarmup ? 'ON' : 'OFF'} | EasyApply: ${this.enableEasyApply ? 'ON' : 'OFF'} | Search Pages: ${this.searchPages}`);
    log('linkedin', '═══════════════════════════════════════════════════════════');

    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 850 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
      ],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());

    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);

      if (page.url().includes('/login') || page.url().includes('/signup')) {
        log('linkedin', 'LinkedIn session expired. Run "node main.js login linkedin" to save session.');
        await notifier.alertHumanIntervention('LinkedIn', 'Session expired. Run "node main.js login linkedin"');
        return { success: false, error: 'Session expired' };
      }

      // Phase 1: Connection Building (Primary)
      log('linkedin', '--- PHASE 1: Connection Outreach ---');
      const connectionsSent = await this.sendConnections(ctx, page, isLive);

      // Phase 2: EasyApply Job Applications (Secondary)
      let jobsApplied = 0;
      if (this.enableEasyApply) {
        log('linkedin', '--- PHASE 2: EasyApply Job Applications ---');
        jobsApplied = await this.searchAndApplyJobs(page, ctx, isLive);
      }

      log('linkedin', '═══════════════════════════════════════════════════════════');
      log('linkedin', `LinkedIn Module COMPLETE: ${connectionsSent} connections + ${jobsApplied} job applications`);
      log('linkedin', '═══════════════════════════════════════════════════════════');

      return {
        success: true,
        connectionsSent,
        jobsApplied,
        message: `LinkedIn: ${connectionsSent} connections sent, ${jobsApplied} jobs applied.`,
      };
    } catch (err) {
      log('linkedin', `ERROR: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  getStats() {
    const connStats = getDayState('linkedin_connections');
    const jobStats = getDayState('linkedin_jobs');
    return {
      connections: connStats.count || 0,
      jobs: jobStats.count || 0,
      count: (connStats.count || 0) + (jobStats.count || 0),
    };
  }
}

module.exports = new LinkedInAdapter();
