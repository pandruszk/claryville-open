const express = require('express');
const router = express.Router();
const db = require('../models/db');
const Players = require('../models/players');
const Groups = require('../models/groups');
const Scores = require('../models/scores');
const Donations = require('../models/donations');
const EmailService = require('../services/email');
const InboxService = require('../services/inbox');
const { calculateTeamStrokes, getTeeBox, TEE_COLORS } = require('../services/handicap');

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  if (req.path === '/login') return next();
  res.redirect('/admin/login');
}

router.use(requireAuth);

// Login
router.get('/login', (req, res) => {
  res.render('admin/login', { error: req.query.error });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  if (req.body.password && process.env.ADMIN_PASSWORD && req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
router.get('/', (req, res) => {
  const playerCount = Players.count();
  const groupCount = Groups.count();
  const donationTotal = Donations.total();
  const donationCount = Donations.count();
  const emailStats = EmailService.getEmailStats();
  const settings = getSettings();
  res.render('admin/dashboard', {
    playerCount, groupCount, donationTotal, donationCount, emailStats, settings
  });
});

// Settings
router.post('/settings', express.urlencoded({ extended: true }), (req, res) => {
  const allowed = ['tournament_name', 'tournament_year', 'tournament_date', 'course_name', 'registration_open', 'results_published'];
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const txn = db.transaction(() => {
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        stmt.run(key, req.body[key]);
      }
    }
    if (!req.body.registration_open) stmt.run('registration_open', 'false');
    if (!req.body.results_published) stmt.run('results_published', 'false');
  });
  txn();
  res.redirect('/admin');
});

// Groups management
router.get('/groups', (req, res) => {
  const groups = Groups.getAllWithPlayers();
  const ungrouped = Players.getUngrouped();

  // Add stroke info and tee boxes
  for (const g of groups) {
    g.strokeInfo = calculateTeamStrokes(g.players);
    g.players.forEach(p => {
      p.teeBox = getTeeBox(p);
      p.teeColor = TEE_COLORS[p.teeBox];
    });
  }
  ungrouped.forEach(p => {
    p.teeBox = getTeeBox(p);
    p.teeColor = TEE_COLORS[p.teeBox];
  });

  res.render('admin/groups', { groups, ungrouped });
});

router.post('/groups/create', express.urlencoded({ extended: true }), (req, res) => {
  Groups.create(req.body.name || 'New Group');
  res.redirect('/admin/groups');
});

router.post('/groups/:id/rename', express.urlencoded({ extended: true }), (req, res) => {
  Groups.rename(req.params.id, req.body.name);
  res.redirect('/admin/groups');
});

router.post('/groups/:id/delete', (req, res) => {
  Groups.delete(req.params.id);
  res.redirect('/admin/groups');
});

router.post('/players/move', express.urlencoded({ extended: true }), (req, res) => {
  const { player_id, group_id } = req.body;
  Groups.movePlayer(parseInt(player_id), group_id ? parseInt(group_id) : null);
  res.redirect('/admin/groups');
});

router.post('/players/add', express.urlencoded({ extended: true }), (req, res) => {
  const groupId = req.body.group_id ? parseInt(req.body.group_id) : null;
  Players.create({
    name: req.body.name,
    email: req.body.email || null,
    age: req.body.age ? parseInt(req.body.age) : null,
    gender: req.body.gender || null,
    ghin_index: req.body.ghin_index ? parseFloat(req.body.ghin_index) : null,
    is_military: req.body.is_military ? 1 : 0,
    never_played_course: req.body.never_played_course ? 1 : 0,
    heart_attack_stroke_tumor: req.body.heart_attack_stroke_tumor ? 1 : 0,
    played_high_school_golf: req.body.played_high_school_golf ? 1 : 0,
    played_college_golf: req.body.played_college_golf ? 1 : 0,
    played_pga_lpga: req.body.played_pga_lpga ? 1 : 0,
    is_post_partum: req.body.is_post_partum ? 1 : 0,
    only_plays_claryville: req.body.only_plays_claryville ? 1 : 0,
    group_id: groupId,
  });
  if (groupId) Groups.updateStatus(groupId);
  res.redirect('/admin/groups');
});

router.post('/players/:id/delete', (req, res) => {
  const player = Players.getById(req.params.id);
  Players.delete(req.params.id);
  if (player?.group_id) Groups.updateStatus(player.group_id);
  res.redirect('/admin/groups');
});

// Inbox
router.get('/inbox', (req, res) => {
  const messages = InboxService.getAll();
  res.render('admin/inbox', { messages });
});

router.post('/inbox/:id/process', (req, res) => {
  InboxService.markProcessed(req.params.id);
  res.redirect('/admin/inbox');
});

router.post('/inbox/:id/delete', (req, res) => {
  InboxService.delete(req.params.id);
  res.redirect('/admin/inbox');
});

router.post('/inbox/poll', async (req, res) => {
  await InboxService.poll();
  res.redirect('/admin/inbox');
});

// Email compose
router.get('/email', (req, res) => {
  const sentEmails = EmailService.getSentEmails();
  const playerCount = Players.count();
  const emails = Players.getAllEmails();
  res.render('admin/email-compose', { sentEmails, playerCount, emailCount: emails.length });
});

router.post('/email/send', express.urlencoded({ extended: true }), async (req, res) => {
  const { subject, body } = req.body;
  const recipients = Players.getAllEmails();
  if (recipients.length === 0) {
    return res.redirect('/admin/email');
  }
  const sent = await EmailService.sendBulk(recipients, subject, body);
  res.redirect('/admin/email');
});

// Scores
router.get('/scores', (req, res) => {
  const groups = Groups.getAllWithPlayers();
  const allScores = {};
  for (const g of groups) {
    g.strokeInfo = calculateTeamStrokes(g.players);
    const score = Scores.getByGroup(g.id);
    if (score) allScores[g.id] = score;
  }
  const contests = Scores.getContests();
  res.render('admin/scores', { groups, allScores, contests });
});

router.post('/scores/:groupId', express.urlencoded({ extended: true }), (req, res) => {
  const groupId = parseInt(req.params.groupId);
  const holes = [];
  for (let i = 1; i <= 18; i++) {
    holes.push(parseInt(req.body[`hole_${i}`]) || 0);
  }

  // Auto-calculate team strokes from player attributes
  const players = Players.getByGroup(groupId);
  const strokeInfo = calculateTeamStrokes(players);

  Scores.upsert(groupId, holes, strokeInfo.capped);
  res.redirect('/admin/scores');
});

// Contest winners
router.post('/contests', express.urlencoded({ extended: true }), (req, res) => {
  const types = ['closest_pin_male', 'closest_pin_female', 'longest_drive_male', 'longest_drive_female'];
  for (const type of types) {
    const name = req.body[`${type}_name`]?.trim();
    const value = req.body[`${type}_value`]?.trim();
    if (name) {
      Scores.setContest(type, name, value);
    }
  }
  res.redirect('/admin/scores');
});

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

module.exports = router;
