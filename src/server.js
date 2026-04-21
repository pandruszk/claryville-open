require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
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

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] Email error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
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

// Simple session (cookie-based, no external store needed for this scale)
const sessions = {};
app.use((req, res, next) => {
  let sid = null;
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('sid='));
    if (match) sid = match.split('=')[1];
  }
  if (sid && sessions[sid]) {
    req.session = sessions[sid];
  } else {
    sid = crypto.randomBytes(16).toString('hex');
    sessions[sid] = {};
    req.session = sessions[sid];
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Secure`);
  }
  req.session.destroy = () => { delete sessions[sid]; };
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
