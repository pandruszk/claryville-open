const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../models/db');
const Players = require('../models/players');
const Groups = require('../models/groups');
const Scores = require('../models/scores');
const Gallery = require('../models/gallery');
const EmailService = require('../services/email');
const AutoReplyService = require('../services/auto-reply');
const StripeService = require('../services/stripe');
const { calculateTeamStrokes, getTeeBox, TEE_COLORS } = require('../services/handicap');

// Multer config for gallery uploads
const storage = multer.diskStorage({
  destination: path.join(__dirname, '../public/media/uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

// Home
router.get('/', (req, res) => {
  const settings = getSettings();
  res.render('home', { settings });
});

// Rules
router.get('/rules', (req, res) => {
  const settings = getSettings();
  res.render('rules', { settings, title: 'Rules' });
});

// Past Winners
router.get('/past-winners', (req, res) => {
  const settings = getSettings();
  const winners = db.prepare('SELECT * FROM past_winners ORDER BY year ASC, id ASC').all();
  for (const w of winners) {
    const players = db.prepare('SELECT display_name FROM past_winner_players WHERE past_winner_id = ? ORDER BY id').all(w.id);
    w.display = players.length > 0 ? players.map(p => p.display_name).join(', ') : w.team_display;
  }
  res.render('past-winners', { settings, winners, title: 'Past Winners' });
});

// Register page
router.get('/register', (req, res) => {
  const settings = getSettings();
  if (settings.registration_open !== 'true') {
    return res.render('register', { settings, closed: true, title: 'Register' });
  }
  res.render('register', { settings, closed: false, success: req.query.success, error: null, title: 'Register' });
});

// Register submit
router.post('/register', express.urlencoded({ extended: true }), async (req, res) => {
  const settings = getSettings();
  if (settings.registration_open !== 'true') {
    return res.redirect('/register');
  }

  const { group_name } = req.body;
  const players = [];

  for (let i = 1; i <= 4; i++) {
    const name = req.body[`p${i}_name`]?.trim();
    if (name) {
      players.push({
        name,
        display_name: req.body[`p${i}_display_name`]?.trim() || null,
        email: req.body[`p${i}_email`]?.trim() || null,
        phone: req.body[`p${i}_phone`]?.trim() || null,
        age: req.body[`p${i}_age`] ? parseInt(req.body[`p${i}_age`]) : null,
        gender: req.body[`p${i}_gender`] || null,
        ghin_index: req.body[`p${i}_ghin`] ? parseFloat(req.body[`p${i}_ghin`]) : null,
        is_military: req.body[`p${i}_is_military`] ? 1 : 0,
        never_played_course: req.body[`p${i}_never_played_course`] ? 1 : 0,
        heart_attack_stroke_tumor: req.body[`p${i}_heart_attack_stroke_tumor`] ? 1 : 0,
        played_high_school_golf: req.body[`p${i}_played_high_school_golf`] ? 1 : 0,
        played_college_golf: req.body[`p${i}_played_college_golf`] ? 1 : 0,
        played_pga_lpga: req.body[`p${i}_played_pga_lpga`] ? 1 : 0,
        is_post_partum: req.body[`p${i}_is_post_partum`] ? 1 : 0,
        only_plays_claryville: req.body[`p${i}_only_plays_claryville`] ? 1 : 0,
      });
    }
  }

  if (players.length === 0) {
    return res.redirect('/register');
  }

  // Check for duplicate registrations by email
  const dupes = [];
  for (const p of players) {
    if (p.email) {
      const existing = db.prepare(
        "SELECT p.name, g.name as group_name FROM players p JOIN groups g ON p.group_id = g.id WHERE lower(p.email) = lower(?)"
      ).get(p.email);
      if (existing) {
        dupes.push(p.name + ' (' + p.email + ') is already registered with ' + existing.group_name);
      }
    }
  }
  if (dupes.length > 0) {
    return res.render('register', { settings, closed: false, success: false, title: 'Register', error: dupes.join('. ') + '.' });
  }

  // Create group
  const teamName = group_name?.trim() || players.map(p => p.name.split(' ')[0]).join(' / ');
  const result = Groups.create(teamName);
  const groupId = result.lastInsertRowid;

  // Add players
  const playerNames = [];
  const emails = [];
  for (const p of players) {
    Players.create({ ...p, group_id: groupId });
    playerNames.push(p.name);
    if (p.email) emails.push(p.email);
  }

  // Update group status
  Groups.updateStatus(groupId);

  // Add players to distribution list
  for (const p of players) {
    if (p.email) {
      const nameParts = p.name.trim().split(/\s+/);
      const firstName = nameParts[0] || null;
      const lastName = nameParts.slice(1).join(' ') || null;
      try {
        db.prepare(`INSERT INTO distribution_list (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET
            first_name = COALESCE(excluded.first_name, first_name),
            last_name = COALESCE(excluded.last_name, last_name),
            phone = COALESCE(excluded.phone, phone)`)
          .run(firstName, lastName, p.email, p.phone);
      } catch (err) { /* ignore */ }
    }
  }

  // Send confirmation emails
  const group = Groups.getById(groupId);
  for (const email of emails) {
    try {
      await EmailService.sendConfirmation(email, playerNames, group.name);
    } catch (err) {
      console.error('[Register] Failed to send confirmation to', email, err.message);
    }
  }

  res.redirect('/register?success=1');
});

// Groups page
router.get('/groups', (req, res) => {
  const settings = getSettings();
  const groups = Groups.getAllWithPlayers();
  const complete = groups.filter(g => g.status === 'complete');
  const looking = groups.filter(g => g.status === 'looking');

  // Calculate strokes and tee boxes for each group
  for (const g of [...complete, ...looking]) {
    g.strokeInfo = calculateTeamStrokes(g.players);
    g.players.forEach(p => {
      p.teeBox = getTeeBox(p);
      p.teeColor = TEE_COLORS[p.teeBox];
    });
  }

  res.render('groups', { settings, complete, looking, title: 'Groups' });
});

// Donate page
router.get('/donate', (req, res) => {
  const settings = getSettings();
  res.render('donate', {
    settings,
    title: 'Donate',
    stripeKey: StripeService.getPublishableKey(),
    stripeConfigured: StripeService.isConfigured(),
    success: req.query.success,
  });
});

router.get('/donate/success', (req, res) => {
  res.redirect('/donate?success=1');
});

router.post('/donate/checkout', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const amount = Math.round(parseFloat(req.body.amount) * 100);
    if (!amount || amount < 100) {
      return res.redirect('/donate');
    }
    const session = await StripeService.createCheckoutSession(amount, req.body.email);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('[Donate] Checkout error:', err.message);
    res.redirect('/donate');
  }
});

// Leaderboard
router.get('/leaderboard', (req, res) => {
  const settings = getSettings();
  const published = settings.results_published === 'true';
  const teeSheetPublished = settings.tee_sheet_published === 'true';
  let netLeaderboard = [];
  let grossLeaderboard = [];
  let highNet = null;
  let contests = {};
  let teeSheet = [];
  if (published) {
    netLeaderboard = Scores.getLeaderboardNet();
    grossLeaderboard = Scores.getLeaderboardGross();
    highNet = Scores.getHighNet();
    contests = Scores.getContests();
  }
  if (teeSheetPublished) {
    teeSheet = Groups.getAllByTeeOrder();
    for (const g of teeSheet) {
      // Per-player tee box colors
      for (const p of g.players) {
        p.teeBox = getTeeBox(p);
        p.teeColor = TEE_COLORS[p.teeBox];
      }
      // Starting score = team stroke handicap (capped, negative)
      g.strokeInfo = calculateTeamStrokes(g.players);
      // Ending score = net total, once scores have been entered
      const score = Scores.getByGroup(g.id);
      g.netTotal = score && score.net_total != null ? score.net_total : null;
    }
  }
  res.render('leaderboard', { settings, published, netLeaderboard, grossLeaderboard, highNet, contests, teeSheetPublished, teeSheet, title: 'Leaderboard' });
});

// Gallery
router.get('/gallery', (req, res) => {
  const settings = getSettings();
  const media = Gallery.getApproved();
  const photos = media.filter(m => m.media_type === 'photo');
  const videos = media.filter(m => m.media_type === 'video');
  res.render('gallery', { settings, photos, videos, success: req.query.success, title: 'Gallery' });
});

router.post('/gallery/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.redirect('/gallery');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);
  Gallery.add(
    req.file.filename,
    req.file.originalname,
    isVideo ? 'video' : 'photo',
    req.body.caption || null,
    req.body.uploaded_by || null
  );
  res.redirect('/gallery?success=1');
});

// Privacy policy
router.get('/privacy', (req, res) => {
  const settings = getSettings();
  res.render('privacy', { settings, title: 'Privacy Policy' });
});

// Questions page
router.get('/questions', (req, res) => {
  const settings = getSettings();
  res.render('questions', { settings, title: 'Questions' });
});

// Questions chatbot API
router.post('/api/ask', express.json(), async (req, res) => {
  let chatMessages = req.body.messages;
  if (!chatMessages || !Array.isArray(chatMessages) || chatMessages.length === 0) {
    return res.json({ answer: 'You gotta actually ask something.' });
  }

  // Limit history to last 20 messages to keep costs down
  if (chatMessages.length > 20) chatMessages = chatMessages.slice(-20);

  // Sanitize — only allow user/assistant roles, text content
  chatMessages = chatMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 1000) }));

  if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
    return res.json({ answer: 'You gotta actually ask something.' });
  }

  // Give each browser session a stable conversation id so we can group
  // multi-turn chats together in the admin log.
  if (!req.session.chat_conversation_id) {
    req.session.chat_conversation_id = crypto.randomBytes(8).toString('hex');
  }
  const conversationId = req.session.chat_conversation_id;
  const lastQuestion = chatMessages[chatMessages.length - 1].content;
  const logTurn = (answer, isFallback) => {
    try {
      db.prepare('INSERT INTO chat_log (conversation_id, question, answer, is_fallback) VALUES (?, ?, ?, ?)')
        .run(conversationId, lastQuestion, answer, isFallback ? 1 : 0);
    } catch (err) { console.error('[Chat log] insert error:', err.message); }
  };

  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    if (!process.env.ANTHROPIC_API_KEY) {
      const answer = "The brain isn't plugged in right now. Email us at rulescommittee@claryvilleopen.com and a real human will get back to you.";
      logTurn(answer, true);
      return res.json({ answer });
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const systemPrompt = AutoReplyService.buildTournamentContext() + `

IMPORTANT INSTRUCTIONS FOR ANSWERING:
- You are the Claryville Open's AI caddy. Warm, friendly, and helpful — like a neighbor who knows all the tournament details.
- Keep answers concise (2-5 sentences usually).
- Be casual and conversational. Light humor is fine but don't try too hard to be funny.
- The tournament is a family affair — keep it welcoming.
- If you truly don't know the answer or it's not about the tournament, say: "I'm not sure about that one. Email rulescommittee@claryvilleopen.com and the Rules Committee can help you out."
- Never make up rules or info that isn't in your context.
- Don't use emojis.

STROKE CALCULATION — VERY IMPORTANT:
When someone asks about strokes, handicaps, or how many strokes they get, you MUST walk them through it by asking specific questions one at a time. Ask:
1. How many players on the team? (and their names if they want)
2. For EACH player ask: age, gender, and then the qualifying factors:
   - Ever played on a golf course before?
   - Current or former U.S. military?
   - Heart attack, stroke, or brain tumor survivor?
   - Post-partum (within 1 year)?
   - Played high school golf (and are under 55)?
   - Played college golf (and are under 55)?
   - Played PGA/LPGA tour?
Ask these naturally in conversation, not as a big dump. Once you have the info for all players, calculate the total strokes step by step showing the math, and remind them of the Sandbagger Rule (max -10 per team). Also tell each player their tee box assignment.`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: chatMessages,
    });

    const modelAnswer = msg.content[0]?.text;
    const answer = modelAnswer || "Something went sideways. Email rulescommittee@claryvilleopen.com instead.";
    logTurn(answer, !modelAnswer);
    res.json({ answer });
  } catch (err) {
    console.error('[Questions] AI error:', err.message);
    const answer = "The AI caddy took a lunch break. Email rulescommittee@claryvilleopen.com and a human will help you out.";
    logTurn(answer, true);
    res.json({ answer });
  }
});

// Contact lookup by email (for registration auto-fill)
router.get('/api/lookup-contact', (req, res) => {
  const email = req.query.email?.trim().toLowerCase();
  if (!email) return res.json({ found: false });

  // Check distribution list first
  const contact = db.prepare(
    'SELECT first_name, last_name, phone FROM distribution_list WHERE lower(email) = ?'
  ).get(email);

  if (contact && (contact.first_name || contact.last_name)) {
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
    return res.json({ found: true, name, phone: contact.phone || '' });
  }

  // Fall back to players table (returning players from previous registrations)
  const player = db.prepare(
    'SELECT name, display_name, phone FROM players WHERE lower(email) = ? ORDER BY id DESC LIMIT 1'
  ).get(email);

  if (player) {
    return res.json({ found: true, name: player.name, display_name: player.display_name || '', phone: player.phone || '' });
  }

  res.json({ found: false });
});

// Footer email signup
// Careers — internship listing + application form
router.get('/careers', (req, res) => {
  const settings = getSettings();
  res.render('careers', { settings, title: 'Careers', success: req.query.success === '1' });
});

router.post('/careers/apply', express.urlencoded({ extended: true }), (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const phone = (req.body.phone || '').trim() || null;
  const whyInterested = (req.body.why_interested || '').trim();
  if (!name || !email || !whyInterested) {
    return res.redirect('/careers');
  }
  try {
    db.prepare(
      'INSERT INTO careers_applications (name, email, phone, why_interested) VALUES (?, ?, ?, ?)'
    ).run(name, email, phone, whyInterested);
  } catch (err) {
    console.error('[Careers] insert error:', err.message);
  }
  res.redirect('/careers?success=1');
});

// Newsletter signup — uses double opt-in: the POST inserts a pending row
// and emails the address a confirmation link. The address only joins the
// distribution_list when the link is clicked.
router.post('/subscribe', express.urlencoded({ extended: true }), async (req, res) => {
  const refererBack = (req.get('referer') || '/');
  const redirectWith = key => res.redirect(refererBack + (refererBack.includes('?') ? '&' : '?') + key);

  // Honeypot: bots fill in any input they see; the visible form omits this
  // field, so a non-empty value means a bot. Silently accept (return success
  // page) to avoid teaching the bot what worked.
  if (req.body.website && String(req.body.website).trim() !== '') {
    return redirectWith('check_email=1');
  }

  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return redirectWith('subscribe_error=1');
  }

  // Already on the distribution list? Treat as success, no email sent.
  const existing = db.prepare('SELECT 1 FROM distribution_list WHERE lower(email) = ?').get(email);
  if (existing) return redirectWith('check_email=1');

  // Upsert pending row with a fresh token, then send the confirmation email.
  const token = crypto.randomBytes(32).toString('hex');
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  try {
    db.prepare(
      "INSERT INTO pending_subscriptions (email, token, ip) VALUES (?, ?, ?) " +
      "ON CONFLICT(email) DO UPDATE SET token = excluded.token, ip = excluded.ip, created_at = datetime('now')"
    ).run(email, token, ip);
  } catch (err) {
    console.error('[Subscribe] insert error:', err.message);
    return redirectWith('subscribe_error=1');
  }

  const base = process.env.BASE_URL || 'https://claryvilleopen.com';
  const confirmUrl = `${base}/subscribe/confirm?token=${token}`;
  try {
    await EmailService.sendOne(
      email,
      'Confirm your Claryville Open subscription',
      `<p style="margin:0 0 1em 0;">Thanks for signing up to get Claryville Open updates! Click the link below to confirm your subscription:</p>
       <p style="margin:0 0 1em 0;"><a href="${confirmUrl}" style="background:#0f1d3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Confirm subscription</a></p>
       <p style="margin:0 0 1em 0;color:#6b7280;font-size:13px">Or copy and paste this link into your browser:<br><a href="${confirmUrl}">${confirmUrl}</a></p>
       <p style="margin:0;color:#6b7280;font-size:13px">If you didn't sign up, you can safely ignore this email — without clicking, you won't get added.</p>`
    );
  } catch (err) {
    console.error('[Subscribe] confirmation email failed:', err.message);
    // Still redirect to "check your email" — don't reveal API failures to the visitor
  }
  return redirectWith('check_email=1');
});

router.get('/subscribe/confirm', (req, res) => {
  const token = (req.query.token || '').toString().trim();
  if (!token) return res.status(400).send('Missing confirmation token.');

  const pending = db.prepare('SELECT email, created_at FROM pending_subscriptions WHERE token = ?').get(token);
  if (!pending) return res.status(400).send('This confirmation link is invalid or expired. Please sign up again.');

  // Expired? (7-day TTL)
  const ageMs = Date.now() - new Date(pending.created_at + (pending.created_at.endsWith('Z') ? '' : 'Z')).getTime();
  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    db.prepare('DELETE FROM pending_subscriptions WHERE token = ?').run(token);
    return res.status(400).send('This confirmation link has expired. Please sign up again.');
  }

  // Idempotent: if already on list, just delete pending row and show success.
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO distribution_list (email) VALUES (?)').run(pending.email);
    db.prepare('DELETE FROM pending_subscriptions WHERE token = ?').run(token);
  });
  tx();

  res.redirect('/?subscribed=1');
});

module.exports = router;
