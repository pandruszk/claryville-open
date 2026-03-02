require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const StripeService = require('./services/stripe');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Middleware
app.use(express.json());
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
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  req.session.destroy = () => { delete sessions[sid]; };
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
app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

// Start IMAP polling
const InboxService = require('./services/inbox');
InboxService.startPolling();

app.listen(PORT, () => {
  console.log(`Claryville Open running at http://localhost:${PORT}`);
});
