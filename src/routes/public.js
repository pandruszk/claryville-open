const express = require('express');
const router = express.Router();
const db = require('../models/db');
const Players = require('../models/players');
const Groups = require('../models/groups');
const Scores = require('../models/scores');
const EmailService = require('../services/email');
const StripeService = require('../services/stripe');
const { calculateTeamStrokes, getTeeBox, TEE_COLORS } = require('../services/handicap');

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
  res.render('rules', { settings });
});

// Register page
router.get('/register', (req, res) => {
  const settings = getSettings();
  if (settings.registration_open !== 'true') {
    return res.render('register', { settings, closed: true });
  }
  res.render('register', { settings, closed: false, success: req.query.success });
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

  res.render('groups', { settings, complete, looking });
});

// Donate page
router.get('/donate', (req, res) => {
  const settings = getSettings();
  res.render('donate', {
    settings,
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
  res.render('leaderboard', { settings, published, netLeaderboard, grossLeaderboard, highNet, contests });
});

module.exports = router;
