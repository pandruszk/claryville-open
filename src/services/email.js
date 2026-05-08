const { Resend } = require('resend');
const db = require('../models/db');

let resend = null;

function getClient() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM_DEFAULT = 'Claryville Open <noreply@claryvilleopen.com>';
const PUBLIC_LOGO = (process.env.BASE_URL || 'https://claryvilleopen.com') + '/media/logo.png';
const PUBLIC_HOME = process.env.BASE_URL || 'https://claryvilleopen.com';

// Wrap a body fragment in the branded email shell — logo header + content +
// footer. Inline-styled and table-based for Outlook compatibility.
function wrapEmail(bodyHtml, opts = {}) {
  const title = (opts.title || 'The Claryville Open').replace(/[<>]/g, '');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05)">
      <tr><td style="background:#0f1d3a;padding:28px 24px;text-align:center">
        <img src="${PUBLIC_LOGO}" alt="The Claryville Open" width="84" height="84" style="display:block;margin:0 auto 10px;border:0;border-radius:50%;background:#ffffff">
        <div style="color:#ffffff;font-size:13px;letter-spacing:0.12em;font-weight:600;text-transform:uppercase">The Claryville Open</div>
        <div style="margin-top:4px;color:#94a3b8;font-size:12px">Friday, July 3, 2026 · Tarry Brae Golf Course</div>
      </td></tr>
      <tr><td style="padding:28px 28px;font-size:15px;line-height:1.55;color:#1f2937">
        ${bodyHtml}
      </td></tr>
      <tr><td style="background:#f9fafb;padding:18px 24px;text-align:center;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb">
        <a href="${PUBLIC_HOME}" style="color:#6b7280;text-decoration:none">claryvilleopen.com</a> · Annual Family Scramble Tournament · Est. 1993
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

const EmailService = {
  wrapEmail,

  async sendOne(to, subject, html, opts = {}) {
    const client = getClient();
    if (!client) {
      console.log('[Email] No API key configured, skipping send to:', to);
      return null;
    }
    const params = {
      from: opts.from || process.env.EMAIL_FROM || FROM_DEFAULT,
      to: [to],
      subject,
      html: opts.wrap === false ? html : wrapEmail(html, { title: subject }),
    };
    if (opts.scheduledAt) params.scheduledAt = opts.scheduledAt;
    const { data, error } = await client.emails.send(params);
    if (error) {
      console.error('[Email] Send error:', error);
      throw error;
    }
    return data;
  },

  async sendReply(to, subject, html, opts = {}) {
    return this.sendOne(to, subject, html, {
      ...opts,
      from: process.env.REPLY_FROM || process.env.EMAIL_FROM || FROM_DEFAULT,
    });
  },

  async sendBulk(recipients, subject, html, opts = {}) {
    const client = getClient();
    if (!client) {
      console.log('[Email] No API key configured, skipping bulk send to', recipients.length, 'recipients');
      return;
    }

    let sent = 0;
    for (const to of recipients) {
      try {
        await this.sendOne(to, subject, html, opts);
        sent++;
      } catch (err) {
        console.error(`[Email] Failed to send to ${to}:`, err.message);
      }
    }

    db.prepare('INSERT INTO emails_sent (subject, body, recipient_count) VALUES (?, ?, ?)')
      .run(subject, html, sent);

    return sent;
  },

  // Send a single email with multiple recipients — everyone visible to each
  // other in the To: header. Use for small-group discussions (e.g. the rules
  // committee) where reply-all should loop everyone in. Do NOT use for
  // broadcast lists where recipients should not see each other.
  async sendGroup(recipients, subject, html, opts = {}) {
    const client = getClient();
    if (!client) {
      console.log('[Email] No API key configured, skipping group send');
      return 0;
    }
    try {
      const params = {
        from: opts.from || process.env.EMAIL_FROM || FROM_DEFAULT,
        to: recipients,
        subject,
        html: opts.wrap === false ? html : wrapEmail(html, { title: subject }),
      };
      if (opts.scheduledAt) params.scheduledAt = opts.scheduledAt;
      const { data, error } = await client.emails.send(params);
      if (error) throw error;
      db.prepare('INSERT INTO emails_sent (subject, body, recipient_count) VALUES (?, ?, ?)')
        .run(subject, html, recipients.length);
      return recipients.length;
    } catch (err) {
      console.error('[Email] Group send error:', err.message || err);
      db.prepare('INSERT INTO emails_sent (subject, body, recipient_count) VALUES (?, ?, ?)')
        .run(subject, html, 0);
      throw err;
    }
  },

  async sendConfirmation(email, playerNames, groupName) {
    const names = playerNames.join(', ');
    const html = `
      <p style="margin:0 0 1em 0">You're registered! Here are your details:</p>
      <p style="margin:0 0 0.5em 0"><strong>Players:</strong> ${names}</p>
      <p style="margin:0 0 1em 0"><strong>Group:</strong> ${groupName}</p>
      <p style="margin:0 0 1em 0">Check out the <a href="${PUBLIC_HOME}/groups">groups page</a> to see all registered teams.</p>
      <p style="margin:0;color:#6b7280;font-size:14px">See you on the course!</p>
    `;
    return this.sendOne(email, 'Claryville Open — Registration Confirmed', html);
  },

  getSentEmails() {
    return db.prepare('SELECT * FROM emails_sent ORDER BY sent_at DESC').all();
  },

  getEmailStats() {
    const total = db.prepare('SELECT COUNT(*) as c FROM emails_sent').get().c;
    const totalRecipients = db.prepare('SELECT COALESCE(SUM(recipient_count), 0) as c FROM emails_sent').get().c;
    return { total, totalRecipients };
  },
};

module.exports = EmailService;
