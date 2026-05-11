require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./models/db');
const StripeService = require('./services/stripe');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust nginx as a reverse proxy so rate-limiter sees real client IPs
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com", "https://www.google-analytics.com", "https://js.stripe.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://www.google-analytics.com"],
      connectSrc: ["'self'", "https://www.google-analytics.com"],
      frameSrc: ["https://js.stripe.com"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// Rate limiting for forms and login
const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stripe webhook needs raw body — must come before express.json()
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    StripeService.handleWebhook(req.body, req.headers['stripe-signature']);
    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] Stripe error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Cloudflare Email Worker webhook
app.post('/webhook/email', express.json({ limit: '5mb' }), async (req, res) => {
  const token = req.headers['authorization'];
  if (!process.env.EMAIL_WEBHOOK_SECRET || token !== `Bearer ${process.env.EMAIL_WEBHOOK_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { from, subject, body } = req.body;
  if (!from) {
    return res.status(400).json({ error: 'Missing from field' });
  }

  try {
    const InboxService = require('./services/inbox');
    InboxService.insertFromWebhook({
      from: from,
      subject: subject || '(no subject)',
      body: body || '',
    });
    console.log(`[Webhook] Email received from ${from}: ${subject}`);

    // Trigger auto-reply drafts
    const AutoReplyService = require('./services/auto-reply');
    await AutoReplyService.processNewMessages();

    // Extract proposed actions (e.g. add_contact) from the new message for
    // admin approval. Failures here must not break the webhook response.
    try {
      const { extractActions } = require('./services/action-extractor');
      const latest = db.prepare(
        'SELECT id, from_addr, subject, body FROM inbox_messages ORDER BY id DESC LIMIT 1'
      ).get();
      if (latest) await extractActions(latest);
    } catch (err) {
      console.error('[Webhook] action extraction failed:', err.message);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] Email error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Resend email-events webhook (delivered / opened / clicked / bounced / complained)
// Signed with Svix HMAC-SHA256. Raw body required for signature verification.
app.post('/webhook/resend', express.raw({ type: '*/*' }), (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send('webhook secret not configured');

  const svixId = req.header('svix-id');
  const svixTs = req.header('svix-timestamp');
  const svixSig = req.header('svix-signature');
  if (!svixId || !svixTs || !svixSig) return res.status(400).send('missing svix headers');

  // Reject replays older than 5 minutes
  const tsNum = parseInt(svixTs, 10);
  if (!tsNum || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return res.status(400).send('timestamp out of range');
  }

  const rawBody = req.body.toString('utf8');
  const cleanSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const secretBytes = Buffer.from(cleanSecret, 'base64');
  const expected = 'v1,' + crypto.createHmac('sha256', secretBytes)
    .update(`${svixId}.${svixTs}.${rawBody}`)
    .digest('base64');

  // svix-signature can contain multiple space-separated entries (key rotation)
  const presented = svixSig.split(' ');
  const ok = presented.some(s => {
    if (s.length !== expected.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)); }
    catch { return false; }
  });
  if (!ok) return res.status(401).send('invalid signature');

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).send('invalid json'); }

  // Persist the event. Resend payload shape:
  //   { type: "email.opened", created_at: "...", data: { email_id, to, from, subject, ... } }
  const data = event.data || {};
  const recipient = Array.isArray(data.to) ? data.to[0] : (data.to || null);
  try {
    db.prepare(
      'INSERT INTO email_events (resend_id, event_type, recipient, subject, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      data.email_id || null,
      event.type || 'unknown',
      recipient,
      data.subject || null,
      event.created_at || new Date().toISOString(),
      rawBody
    );
  } catch (err) {
    console.error('[Resend webhook] insert error:', err.message);
  }

  res.status(204).send();
});

// Telnyx SMS webhook
app.post('/webhook/sms', express.json(), async (req, res) => {
  const event = req.body?.data;
  if (!event || event.event_type !== 'message.received') {
    return res.sendStatus(200);
  }

  const from = event.payload?.from?.phone_number;
  const body = event.payload?.text?.trim();

  if (!from || !body) {
    return res.sendStatus(200);
  }

  console.log(`[SMS] Received from ${from}: ${body}`);
  res.sendStatus(200); // Respond to Telnyx immediately

  try {
    const SmsService = require('./services/sms');
    const answer = await SmsService.handleIncoming(from, body);
    if (answer) {
      console.log(`[SMS] Replying to ${from}: ${answer.slice(0, 80)}...`);
      await SmsService.sendReply(from, answer);
    }
  } catch (err) {
    console.error('[SMS] Error:', err.message);
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware — SQLite-backed so sessions survive container restarts.
// Loads the session row at request start and persists any changes when the
// response finishes. Session data is stored as JSON in the `sessions` table.
const selectSession = db.prepare('SELECT data FROM sessions WHERE sid = ?');
const upsertSession = db.prepare(
  "INSERT INTO sessions (sid, data, updated_at) VALUES (?, ?, datetime('now')) " +
  "ON CONFLICT(sid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
);
const deleteSession = db.prepare('DELETE FROM sessions WHERE sid = ?');

app.use((req, res, next) => {
  let sid = null;
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('sid='));
    if (match) sid = match.split('=')[1];
  }

  let session = null;
  if (sid) {
    const row = selectSession.get(sid);
    if (row) {
      try { session = JSON.parse(row.data); } catch { session = null; }
    }
  }

  let isNew = false;
  if (!session) {
    sid = crypto.randomBytes(16).toString('hex');
    session = {};
    isNew = true;
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Secure`);
  }

  req.session = session;
  let destroyed = false;
  req.session.destroy = () => {
    deleteSession.run(sid);
    destroyed = true;
  };

  res.on('finish', () => {
    if (destroyed) return;
    try {
      const { destroy, ...toSave } = req.session;
      // Avoid writing empty, never-touched sessions for anonymous GETs
      if (!isNew || Object.keys(toSave).length > 0) {
        upsertSession.run(sid, JSON.stringify(toSave));
      }
    } catch (err) {
      console.error('[Session] save error:', err.message);
    }
  });

  next();
});
// CSRF protection
app.use((req, res, next) => {
  // Skip CSRF for webhooks (they use their own auth)
  if (req.path.startsWith('/webhook/')) return next();
  // Skip for API endpoints that use JSON
  if (req.path === '/api/ask' || req.path === '/admin/tee-order') return next();

  // Generate token if not present
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  // Validate on POST/PUT/DELETE
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.body?._csrf || req.headers['x-csrf-token'];
    if (token !== req.session.csrfToken) {
      return res.status(403).send('Invalid CSRF token');
    }
  }
  next();
});

// EJS setup with layout support
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Layout helper — templates call layout('layout') to wrap in layout
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function (view, options = {}) {
    let layoutName = null;
    options.layout = function (name) { layoutName = name; };
    originalRender(view, options, (err, body) => {
      if (err) return next(err);
      if (layoutName) {
        originalRender(layoutName, { ...options, body }, (err2, html) => {
          if (err2) return next(err2);
          res.send(html);
        });
      } else {
        res.send(body);
      }
    });
  };
  next();
});

// Routes
// Apply rate limiting to form endpoints
app.use('/register', formLimiter);
app.use('/subscribe', formLimiter);
app.use('/admin/login', loginLimiter);

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

// Start IMAP polling (skipped if IMAP not configured — emails arrive via webhook instead)
const InboxService = require('./services/inbox');
InboxService.startPolling();

app.listen(PORT, () => {
  console.log(`Claryville Open running at http://localhost:${PORT}`);
});
