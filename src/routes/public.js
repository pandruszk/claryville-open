const express = require('express');
const router = express.Router();
const path = require('path');
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
  res.render('register', { settings, closed: false, success: req.query.success, title: 'Register' });
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
        email: req.body[`p${i}_email`]?.trim() || null,
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
        db.prepare('INSERT OR IGNORE INTO distribution_list (first_name, last_name, email) VALUES (?, ?, ?)')
          .run(firstName, lastName, p.email);
      } catch (err) { /* duplicate email, ignore */ }
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
  let netLeaderboard = [];
  let grossLeaderboard = [];
  let highNet = null;
  let contests = {};
  if (published) {
    netLeaderboard = Scores.getLeaderboardNet();
    grossLeaderboard = Scores.getLeaderboardGross();
    highNet = Scores.getHighNet();
    contests = Scores.getContests();
  }
  res.render('leaderboard', { settings, published, netLeaderboard, grossLeaderboard, highNet, contests, title: 'Leaderboard' });
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

// Questions page
router.get('/questions', (req, res) => {
  const settings = getSettings();
  res.render('questions', { settings, title: 'Questions' });
});

// Questions chatbot API
router.post('/api/ask', express.json(), async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) return res.json({ answer: 'You gotta actually ask something.' });

  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ answer: "The brain isn't plugged in right now. Email us at rulescommittee@claryvilleopen.com and a real human will get back to you." });
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const systemPrompt = AutoReplyService.buildTournamentContext() + `

IMPORTANT INSTRUCTIONS FOR ANSWERING:
- You are the Claryville Open's sarcastic but helpful AI caddy.
- Keep answers SHORT (2-4 sentences max).
- Be funny, a little snarky, but always give the actual answer.
- The tournament is a family affair — keep it PG-13.
- If you truly don't know the answer or it's not about the tournament, say something like: "That's above my pay grade. Shoot an email to rulescommittee@claryvilleopen.com and the Rules Committee will sort you out."
- Never make up rules or info that isn't in your context.
- Don't use emojis.`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    });

    const answer = msg.content[0]?.text || "Something went sideways. Email rulescommittee@claryvilleopen.com instead.";
    res.json({ answer });
  } catch (err) {
    console.error('[Questions] AI error:', err.message);
    res.json({ answer: "The AI caddy took a lunch break. Email rulescommittee@claryvilleopen.com and a human will help you out." });
  }
});

// Footer email signup
router.post('/subscribe', express.urlencoded({ extended: true }), (req, res) => {
  const email = req.body.email?.trim();
  if (!email) return res.redirect(req.get('referer') || '/');
  try {
    db.prepare('INSERT OR IGNORE INTO distribution_list (email) VALUES (?)').run(email);
  } catch (err) { /* duplicate, ignore */ }
  res.redirect((req.get('referer') || '/') + (req.get('referer')?.includes('?') ? '&' : '?') + 'subscribed=1');
});

module.exports = router;
