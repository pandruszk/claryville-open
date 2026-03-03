const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../models/db');
const AutoReplyService = require('./auto-reply');

let polling = false;

function createImapConnection() {
  if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASSWORD) {
    return null;
  }
  return new Imap({
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT) || 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });
}

function fetchNewEmails() {
  return new Promise((resolve, reject) => {
    const imap = createImapConnection();
    if (!imap) {
      resolve([]);
      return;
    }

    const messages = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        // Search for unseen messages
        imap.search(['UNSEEN'], (err, results) => {
          if (err) { imap.end(); return reject(err); }
          if (!results || results.length === 0) { imap.end(); return resolve([]); }

          const fetch = imap.fetch(results, { bodies: '', markSeen: true });

          fetch.on('message', (msg) => {
            let buffer = '';
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            });
            msg.once('end', () => {
              messages.push(buffer);
            });
          });

          fetch.once('end', () => {
            imap.end();
          });

          fetch.once('error', (err) => {
            console.error('[Inbox] Fetch error:', err);
            imap.end();
          });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('[Inbox] IMAP error:', err.message);
      resolve([]);
    });

    imap.once('end', async () => {
      const parsed = [];
      for (const raw of messages) {
        try {
          const mail = await simpleParser(raw);
          parsed.push({
            from: mail.from?.text || '',
            subject: mail.subject || '(no subject)',
            body: mail.text || mail.html || '',
            date: mail.date || new Date(),
          });
        } catch (e) {
          console.error('[Inbox] Parse error:', e.message);
        }
      }
      resolve(parsed);
    });

    imap.connect();
  });
}

const InboxService = {
  async poll() {
    if (polling) return;
    polling = true;
    try {
      const emails = await fetchNewEmails();
      const stmt = db.prepare(
        'INSERT INTO inbox_messages (from_addr, subject, body, received_at) VALUES (?, ?, ?, ?)'
      );
      for (const email of emails) {
        stmt.run(email.from, email.subject, email.body, email.date.toISOString());
      }
      if (emails.length > 0) {
        console.log(`[Inbox] Fetched ${emails.length} new email(s)`);
      }

      // Generate AI drafts for new messages
      try {
        await AutoReplyService.processNewMessages();
      } catch (err) {
        console.error('[AutoReply] Error during auto-reply processing:', err.message);
      }
    } catch (err) {
      console.error('[Inbox] Poll error:', err.message);
    } finally {
      polling = false;
    }
  },

  getAll() {
    return db.prepare('SELECT * FROM inbox_messages ORDER BY received_at DESC').all();
  },

  getUnprocessed() {
    return db.prepare('SELECT * FROM inbox_messages WHERE processed = 0 ORDER BY received_at DESC').all();
  },

  markProcessed(id) {
    db.prepare('UPDATE inbox_messages SET processed = 1 WHERE id = ?').run(id);
  },

  insertFromWebhook({ from, subject, body }) {
    db.prepare(
      'INSERT INTO inbox_messages (from_addr, subject, body, received_at) VALUES (?, ?, ?, ?)'
    ).run(from, subject, body, new Date().toISOString());
  },

  delete(id) {
    db.prepare('DELETE FROM draft_replies WHERE inbox_message_id = ?').run(id);
    db.prepare('DELETE FROM inbox_messages WHERE id = ?').run(id);
  },

  startPolling(intervalMs = 5 * 60 * 1000) {
    if (!process.env.IMAP_HOST) {
      console.log('[Inbox] IMAP not configured, skipping poll');
      return;
    }
    console.log('[Inbox] Starting polling every', intervalMs / 1000, 'seconds');
    this.poll();
    setInterval(() => this.poll(), intervalMs);
  },
};

module.exports = InboxService;
