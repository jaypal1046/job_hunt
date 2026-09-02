/**
 * Communication & Notifier Service
 * Handles email notifications (via Nodemailer SMTP) and human interaction alerts.
 */
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const CONFIG = require('../../config');
const { log } = require('./logger');

class NotifierService {
  constructor() {
    this.transporter = null;
    this.initTransporter();
  }

  initTransporter() {
    if (CONFIG.comms.enabled && CONFIG.comms.smtpUser && CONFIG.comms.smtpPass) {
      try {
        this.transporter = nodemailer.createTransport({
          host: CONFIG.comms.smtpHost,
          port: CONFIG.comms.smtpPort,
          secure: CONFIG.comms.smtpSecure,
          auth: {
            user: CONFIG.comms.smtpUser,
            pass: CONFIG.comms.smtpPass,
          },
        });
        log('notifier', `Email transport initialized (${CONFIG.comms.smtpHost})`);
      } catch (err) {
        log('notifier', `Failed to initialize email transport: ${err.message}`);
      }
    } else {
      log('notifier', 'Email notifications disabled or credentials missing. Operating in console-only notification mode.');
    }
  }

  /**
   * Sends an email notification or logs it to console if email is disabled.
   */
  async sendEmail(subject, text, html = null, attachments = []) {
    const logHeader = `=== NOTIFICATION: [${subject}] ===`;
    log('notifier', logHeader);
    console.log(text);

    if (!this.transporter || !CONFIG.comms.enabled) {
      return false;
    }

    try {
      const mailOptions = {
        from: `"Autonomous Job Engine" <${CONFIG.comms.smtpUser}>`,
        to: CONFIG.comms.recipient,
        subject: `[Job Engine] ${subject}`,
        text: text,
        html: html || text.replace(/\n/g, '<br>'),
        attachments: attachments,
      };

      const info = await this.transporter.sendMail(mailOptions);
      log('notifier', `Email sent successfully: ${info.messageId}`);
      return true;
    } catch (err) {
      log('notifier', `Error sending email: ${err.message}`);
      return false;
    }
  }

  /**
   * Send daily summary report of applications and actions
   */
  async sendDailyReport(stats) {
    const subject = `Daily Application Report - ${new Date().toLocaleDateString()}`;

    let externalJobsText = '';
    const externalCsv = path.join(CONFIG.paths.logs, 'external_company_jobs.csv');
    if (fs.existsSync(externalCsv)) {
      try {
        const lines = fs.readFileSync(externalCsv, 'utf8').trim().split('\n').slice(1);
        if (lines.length > 0) {
          externalJobsText = `\n\n📌 EXTERNAL COMPANY SITE JOBS FOUND (${lines.length}):\n` +
            lines.slice(-5).map((l) => {
              const parts = l.split(',').map((p) => p.replace(/"/g, ''));
              return `- ${parts[2]} @ ${parts[3]}: ${parts[4]}`;
            }).join('\n');
        }
      } catch (e) {}
    }

    const text = `
Hello ${CONFIG.cv.name},

Here is your daily autonomous job search report for ${new Date().toLocaleDateString()}:

📊 SUMMARY STATS:
- Wellfound Applications Sent: ${stats.wellfoundSent || 0}
- Naukri Profile Updates: ${stats.naukriRefreshed ? 'Success' : 'Pending/N/A'}
- LinkedIn Status: ${stats.linkedinSent || 0} (Next Stage)
- High Match AI Jobs Evaluated: ${stats.evaluatedCount || 0}
${externalJobsText}

Keep going! Your job engine is operating autonomously.
`;
    return await this.sendEmail(subject, text);
  }

  /**
   * Alert user when human intervention is required (e.g. 2FA, Captcha, Bot Block)
   */
  async alertHumanIntervention(platform, reason, screenshotPath = null) {
    const subject = `ACTION REQUIRED: Human intervention needed on ${platform}`;
    const text = `
⚠️ ATTENTION NEEDED on ${platform}!

Reason: ${reason}

Action Required:
Please log in manually or complete the prompt by running:
node main.js login ${platform.toLowerCase()}

Timestamp: ${new Date().toLocaleString()}
`;
    const attachments = [];
    if (screenshotPath) {
      attachments.push({ path: screenshotPath });
    }

    return await this.sendEmail(subject, text, null, attachments);
  }

  /**
   * Send immediate email notification with job link when a job application is submitted or logged
   */
  async notifyAppliedJob(platform, jobTitle, companyName, jobUrl, matchScore = 'N/A') {
    const subject = `Job Application Sent: ${jobTitle} @ ${companyName}`;
    const text = `
Hello ${CONFIG.cv.name},

A new job application has been processed!

Role Title: ${jobTitle}
Company: ${companyName}
Platform: ${platform.toUpperCase()}
Match Score: ${matchScore}%
Job Link: ${jobUrl}

Timestamp: ${new Date().toLocaleString()}
`;
    const html = `
<div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
  <h2 style="color: #2563eb; margin-top: 0;">🚀 New Job Application Submitted!</h2>
  <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
    <tr><td style="padding: 8px 0; font-weight: bold; width: 120px;">Role Title:</td><td>${jobTitle}</td></tr>
    <tr><td style="padding: 8px 0; font-weight: bold;">Company:</td><td>${companyName}</td></tr>
    <tr><td style="padding: 8px 0; font-weight: bold;">Platform:</td><td>${platform.toUpperCase()}</td></tr>
    <tr><td style="padding: 8px 0; font-weight: bold;">Match Score:</td><td><span style="background: #dbeafe; color: #1e40af; padding: 3px 8px; border-radius: 4px; font-weight: bold;">${matchScore}%</span></td></tr>
    <tr><td style="padding: 8px 0; font-weight: bold;">Job Link:</td><td><a href="${jobUrl}" target="_blank" style="color: #2563eb; text-decoration: underline;">${jobUrl}</a></td></tr>
  </table>
  <p style="font-size: 12px; color: #666; margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
    Applied on ${new Date().toLocaleString()} by Autonomous Job Engine.
  </p>
</div>
`;

    return await this.sendEmail(subject, text, html);
  }
}

module.exports = new NotifierService();
