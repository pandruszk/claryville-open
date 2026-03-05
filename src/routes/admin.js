const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../models/db');
const Players = require('../models/players');
const Groups = require('../models/groups');
const Scores = require('../models/scores');
const Donations = require('../models/donations');
const Gallery = require('../models/gallery');
const EmailService = require('../services/email');
const InboxService = require('../services/inbox');
const AutoReplyService = require('../services/auto-reply');
const { calculateTeamStrokes, getTeeBox, TEE_COLORS } = require('../services/handicap');
const { extractScores } = require('../services/scorecard-ocr');

// Multer for temp scorecard uploads
const ocrUpload = multer({ dest: path.join(__dirname, '../../data/tmp') });

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
  const draftStats = AutoReplyService.getStats();
  const settings = getSettings();
  res.render('admin/dashboard', {
    playerCount, groupCount, donationTotal, donationCount, emailStats, draftStats, settings
  });
});

// Settings
router.post('/settings', express.urlencoded({ extended: true }), (req, res) => {
  const allowed = ['tournament_name', 'tournament_year', 'tournament_date', 'course_name', 'registration_open', 'results_published', 'tee_sheet_published'];
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const txn = db.transaction(() => {
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        stmt.run(key, req.body[key]);
      }
    }
    if (!req.body.registration_open) stmt.run('registration_open', 'false');
    if (!req.body.results_published) stmt.run('results_published', 'false');
    if (!req.body.tee_sheet_published) stmt.run('tee_sheet_published', 'false');
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
  const draftStats = AutoReplyService.getStats();
  // Attach draft to each message
  for (const msg of messages) {
    msg.draft = AutoReplyService.getDraftByMessageId(msg.id);
  }
  res.render('admin/inbox', { messages, draftStats });
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

// Draft review
router.get('/inbox/:id/draft', (req, res) => {
  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(req.params.id);
  if (!message) return res.redirect('/admin/inbox');
  const draft = AutoReplyService.getDraftByMessageId(message.id);
  res.render('admin/draft-review', { message, draft });
});

router.post('/inbox/:id/draft/edit', express.urlencoded({ extended: true }), (req, res) => {
  const draft = AutoReplyService.getDraftByMessageId(req.params.id);
  if (draft) {
    AutoReplyService.updateDraftBody(draft.id, req.body.edited_body);
  }
  res.redirect(`/admin/inbox/${req.params.id}/draft`);
});

router.post('/inbox/:id/draft/send', async (req, res) => {
  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(req.params.id);
  const draft = AutoReplyService.getDraftByMessageId(req.params.id);
  if (!message || !draft) return res.redirect('/admin/inbox');

  try {
    const bodyToSend = draft.edited_body || draft.draft_body;
    // Extract email address from "Name <email>" format
    const emailMatch = message.from_addr.match(/<([^>]+)>/);
    const toAddr = emailMatch ? emailMatch[1] : message.from_addr;
    await EmailService.sendReply(toAddr, draft.draft_subject, bodyToSend);
    AutoReplyService.markSent(draft.id);
    InboxService.markProcessed(message.id);
  } catch (err) {
    console.error('[Admin] Error sending reply:', err.message);
  }
  res.redirect('/admin/inbox');
});

router.post('/inbox/:id/draft/dismiss', (req, res) => {
  const draft = AutoReplyService.getDraftByMessageId(req.params.id);
  if (draft) AutoReplyService.markDismissed(draft.id);
  res.redirect('/admin/inbox');
});

router.post('/inbox/:id/draft/regenerate', async (req, res) => {
  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(req.params.id);
  if (!message) return res.redirect('/admin/inbox');

  const existingDraft = AutoReplyService.getDraftByMessageId(message.id);
  if (existingDraft) AutoReplyService.deleteDraft(existingDraft.id);

  try {
    const draft = await AutoReplyService.generateDraft(message);
    if (draft) {
      db.prepare(`
        INSERT INTO draft_replies (inbox_message_id, draft_subject, draft_body, is_rule_suggestion, suggested_rule_text)
        VALUES (?, ?, ?, ?, ?)
      `).run(message.id, draft.subject, draft.body, draft.isRuleSuggestion, draft.suggestedRuleText);
    }
  } catch (err) {
    console.error('[Admin] Error regenerating draft:', err.message);
  }
  res.redirect(`/admin/inbox/${req.params.id}/draft`);
});

// Manual reply (admin-composed)
router.post('/inbox/:id/reply', express.urlencoded({ extended: true }), async (req, res) => {
  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(req.params.id);
  if (!message) return res.redirect('/admin/inbox');

  try {
    const { reply_subject, reply_body } = req.body;
    const emailMatch = message.from_addr.match(/<([^>]+)>/);
    const toAddr = emailMatch ? emailMatch[1] : message.from_addr;
    await EmailService.sendReply(toAddr, reply_subject, reply_body);
    InboxService.markProcessed(message.id);
    // Dismiss AI draft if one exists
    const draft = AutoReplyService.getDraftByMessageId(message.id);
    if (draft && draft.status === 'pending') AutoReplyService.markDismissed(draft.id);
  } catch (err) {
    console.error('[Admin] Error sending manual reply:', err.message);
  }
  res.redirect('/admin/inbox');
});

// Rules suggestions
router.get('/rules-suggestions', (req, res) => {
  const suggestions = AutoReplyService.getRuleSuggestions();
  const rules = AutoReplyService.getTournamentRules();
  res.render('admin/rules-suggestions', { suggestions, rules });
});

router.post('/rules-suggestions/:draftId/accept', express.urlencoded({ extended: true }), (req, res) => {
  const draft = AutoReplyService.getDraftById(req.params.draftId);
  if (draft && draft.suggested_rule_text) {
    const ruleText = req.body.rule_text || draft.suggested_rule_text;
    const category = req.body.category || 'general';
    AutoReplyService.addTournamentRule(ruleText, category, 1);
  }
  res.redirect('/admin/rules-suggestions');
});

router.post('/tournament-rules/:id/delete', (req, res) => {
  AutoReplyService.deleteTournamentRule(req.params.id);
  res.redirect('/admin/rules-suggestions');
});

// Email compose
router.get('/email', (req, res) => {
  const sentEmails = EmailService.getSentEmails();
  const emailCount = db.prepare('SELECT COUNT(*) as c FROM distribution_list').get().c;
  res.render('admin/email-compose', { sentEmails, emailCount });
});

// Distribution list / Contacts
router.get('/contacts', (req, res) => {
  const distList = db.prepare('SELECT * FROM distribution_list ORDER BY clan, last_name, first_name').all();
  const clans = [...new Set(distList.filter(d => d.clan).map(d => d.clan))].sort();
  res.render('admin/contacts', { distList, clans });
});

router.post('/email/send', express.urlencoded({ extended: true }), async (req, res) => {
  const { subject, body } = req.body;
  const recipients = db.prepare('SELECT email FROM distribution_list').all().map(r => r.email);
  if (recipients.length === 0) {
    return res.redirect('/admin/email');
  }
  const sent = await EmailService.sendBulk(recipients, subject, body);
  res.redirect('/admin/email');
});

// Distribution list management
router.post('/contacts/add', express.urlencoded({ extended: true }), (req, res) => {
  const { first_name, last_name, email, clan } = req.body;
  if (!email) return res.redirect('/admin/contacts');
  try {
    db.prepare('INSERT INTO distribution_list (first_name, last_name, email, clan) VALUES (?, ?, ?, ?)')
      .run(first_name || null, last_name || null, email, clan || null);
  } catch (err) {
    console.error('[Admin] Error adding contact:', err.message);
  }
  res.redirect('/admin/contacts');
});

router.post('/contacts/:id/edit', express.urlencoded({ extended: true }), (req, res) => {
  const { first_name, last_name, email, clan } = req.body;
  db.prepare('UPDATE distribution_list SET first_name = ?, last_name = ?, email = ?, clan = ? WHERE id = ?')
    .run(first_name || null, last_name || null, email, clan || null, req.params.id);
  res.redirect('/admin/contacts');
});

router.post('/contacts/:id/delete', (req, res) => {
  db.prepare('DELETE FROM distribution_list WHERE id = ?').run(req.params.id);
  res.redirect('/admin/contacts');
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
  const settings = getSettings();
  res.render('admin/scores', { groups, allScores, contests, settings });
});

// Tee order — save drag-and-drop ordering
router.post('/tee-order', express.json(), (req, res) => {
  const order = req.body.order; // [{id, position}]
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order' });
  const txn = db.transaction(() => {
    for (const item of order) {
      Groups.setTeeOrder(parseInt(item.id), parseInt(item.position));
    }
  });
  txn();
  res.json({ ok: true });
});

// Tee settings — save start time + interval (dedicated route)
router.post('/tee-settings', express.urlencoded({ extended: true }), (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  if (req.body.tee_start_time) stmt.run('tee_start_time', req.body.tee_start_time);
  if (req.body.tee_interval) stmt.run('tee_interval', req.body.tee_interval);
  res.redirect('/admin/scores');
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

// OCR scorecard scan
router.post('/scores/:groupId/ocr', ocrUpload.single('scorecard'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await extractScores(req.file.path);
    res.json(result);
  } catch (err) {
    console.error('[Admin] OCR error:', err.message);
    res.status(500).json({ error: 'Failed to read scorecard: ' + err.message });
  } finally {
    // Clean up temp file
    fs.unlink(req.file.path, () => {});
  }
});

// Gallery management
router.get('/gallery', (req, res) => {
  const pending = Gallery.getPending();
  const approved = Gallery.getApproved();
  res.render('admin/gallery', { pending, approved });
});

router.post('/gallery/:id/approve', (req, res) => {
  Gallery.approve(req.params.id);
  res.redirect('/admin/gallery');
});

router.post('/gallery/:id/caption', express.urlencoded({ extended: true }), (req, res) => {
  Gallery.updateCaption(req.params.id, req.body.caption?.trim());
  res.redirect('/admin/gallery');
});

router.post('/gallery/:id/delete', (req, res) => {
  const row = Gallery.delete(req.params.id);
  if (row?.filename) {
    const filePath = path.join(__dirname, '../public/media/uploads', row.filename);
    fs.unlink(filePath, () => {});
  }
  res.redirect('/admin/gallery');
});

// Past Winners
router.get('/past-winners', (req, res) => {
  const winners = db.prepare('SELECT * FROM past_winners ORDER BY year DESC, id DESC').all();
  const contacts = db.prepare('SELECT id, first_name, last_name, email, clan FROM distribution_list ORDER BY last_name, first_name').all();

  for (const w of winners) {
    w.players = db.prepare(`
      SELECT pwp.*, dl.first_name AS contact_first, dl.last_name AS contact_last, dl.clan AS contact_clan
      FROM past_winner_players pwp
      LEFT JOIN distribution_list dl ON pwp.contact_id = dl.id
      WHERE pwp.past_winner_id = ? ORDER BY pwp.id
    `).all(w.id);
  }

  res.render('admin/past-winners', { winners, contacts });
});

router.post('/past-winners/add', express.urlencoded({ extended: true }), (req, res) => {
  const { year } = req.body;
  let names = req.body.display_name || [];
  let contactIds = req.body.contact_id || [];
  if (!Array.isArray(names)) names = [names];
  if (!Array.isArray(contactIds)) contactIds = [contactIds];
  const cleanNames = names.map(n => (n || '').trim()).filter(Boolean);
  if (!year || cleanNames.length === 0) return res.redirect('/admin/past-winners');

  const teamDisplay = cleanNames.join(', ');
  const result = db.prepare('INSERT INTO past_winners (year, team_display) VALUES (?, ?)').run(parseInt(year), teamDisplay);
  const winnerId = result.lastInsertRowid;
  const ins = db.prepare('INSERT INTO past_winner_players (past_winner_id, display_name, contact_id) VALUES (?, ?, ?)');
  for (let i = 0; i < names.length; i++) {
    const name = (names[i] || '').trim();
    if (!name) continue;
    const cid = contactIds[i] ? parseInt(contactIds[i]) : null;
    ins.run(winnerId, name, cid);
  }
  res.redirect('/admin/past-winners');
});

router.post('/past-winners/:id/edit', express.urlencoded({ extended: true }), (req, res) => {
  const { year } = req.body;
  let names = req.body.display_name || [];
  let contactIds = req.body.contact_id || [];
  if (!Array.isArray(names)) names = [names];
  if (!Array.isArray(contactIds)) contactIds = [contactIds];

  db.transaction(() => {
    const cleanNames = names.map(n => (n || '').trim()).filter(Boolean);
    const teamDisplay = cleanNames.join(', ');
    db.prepare('UPDATE past_winners SET year = ?, team_display = ? WHERE id = ?').run(parseInt(year), teamDisplay, req.params.id);
    db.prepare('DELETE FROM past_winner_players WHERE past_winner_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT INTO past_winner_players (past_winner_id, display_name, contact_id) VALUES (?, ?, ?)');
    for (let i = 0; i < names.length; i++) {
      const name = (names[i] || '').trim();
      if (!name) continue;
      const cid = contactIds[i] ? parseInt(contactIds[i]) : null;
      ins.run(req.params.id, name, cid);
    }
  })();
  res.redirect('/admin/past-winners');
});

router.post('/past-winners/:id/delete', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM past_winner_players WHERE past_winner_id = ?').run(req.params.id);
    db.prepare('DELETE FROM past_winners WHERE id = ?').run(req.params.id);
  })();
  res.redirect('/admin/past-winners');
});

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

module.exports = router;
