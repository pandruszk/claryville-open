const { Resend } = require('resend');
const db = require('../models/db');

let resend = null;

function getClient() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const EmailService = {
  async sendOne(to, subject, html) {
    const client = getClient();
    if (!client) {
      console.log('[Email] No API key configured, skipping send to:', to);
      return null;
    }
    const { data, error } = await client.emails.send({
      from: process.env.EMAIL_FROM || 'Claryville Open <noreply@claryvilleopen.com>',
      to: [to],
      subject,
      html,
    });
    if (error) {
      console.error('[Email] Send error:', error);
      throw error;
    }
    return data;
  },

  async sendBulk(recipients, subject, html) {
    const client = getClient();
    if (!client) {
      console.log('[Email] No API key configured, skipping bulk send to', recipients.length, 'recipients');
      return;
    }

    let sent = 0;
    for (const to of recipients) {
      try {
        await this.sendOne(to, subject, html);
        sent++;
      } catch (err) {
        console.error(`[Email] Failed to send to ${to}:`, err.message);
      }
    }

    db.prepare('INSERT INTO emails_sent (subject, body, recipient_count) VALUES (?, ?, ?)')
      .run(subject, html, sent);

    return sent;
  },

  async sendConfirmation(email, playerNames, groupName) {
    const names = playerNames.join(', ');
    const html = `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #2d5016;">The Claryville Open</h1>
        <p>You're registered! Here are your details:</p>
        <p><strong>Players:</strong> ${names}</p>
        <p><strong>Group:</strong> ${groupName}</p>
        <p>Check out the <a href="${process.env.BASE_URL || 'http://localhost:3000'}/groups">groups page</a> to see all registered teams.</p>
        <p style="color: #666; font-size: 14px;">See you on the course!</p>
      </div>
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
