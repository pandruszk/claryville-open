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

router.post('/players/:id/edit', express.urlencoded({ extended: true }), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.redirect('/admin/groups');
  const fields = {
    name: (req.body.name || '').trim() || null,
    email: (req.body.email || '').trim() || null,
    phone: (req.body.phone || '').trim() || null,
    age: req.body.age ? parseInt(req.body.age, 10) : null,
    gender: (req.body.gender === 'male' || req.body.gender === 'female') ? req.body.gender : null,
    ghin_index: req.body.ghin_index !== '' && req.body.ghin_index !== undefined ? parseFloat(req.body.ghin_index) : null,
    is_military: req.body.is_military ? 1 : 0,
    never_played_course: req.body.never_played_course ? 1 : 0,
    heart_attack_stroke_tumor: req.body.heart_attack_stroke_tumor ? 1 : 0,
    played_high_school_golf: req.body.played_high_school_golf ? 1 : 0,
    played_college_golf: req.body.played_college_golf ? 1 : 0,
    played_pga_lpga: req.body.played_pga_lpga ? 1 : 0,
    is_post_partum: req.body.is_post_partum ? 1 : 0,
    only_plays_claryville: req.body.only_plays_claryville ? 1 : 0,
  };
  Players.update(id, fields);
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
  // Attach draft and pending AI-proposed actions to each message
  const pendingActions = db.prepare(
    "SELECT id, inbox_message_id, action_type, payload_json, rationale, created_at FROM pending_actions WHERE status = 'pending' ORDER BY id"
  ).all();
  const actionsByMsg = new Map();
  for (const a of pendingActions) {
    try { a.payload = JSON.parse(a.payload_json); } catch { a.payload = {}; }
    if (!actionsByMsg.has(a.inbox_message_id)) actionsByMsg.set(a.inbox_message_id, []);
    actionsByMsg.get(a.inbox_message_id).push(a);
  }
  for (const msg of messages) {
    msg.draft = AutoReplyService.getDraftByMessageId(msg.id);
    msg.pendingActions = actionsByMsg.get(msg.id) || [];
  }
  const pendingActionsCount = pendingActions.length;
  res.render('admin/inbox', { messages, draftStats, pendingActionsCount });
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
  const distList = db.prepare('SELECT clan, rules_committee FROM distribution_list').all();
  const total = distList.length;
  const committee = distList.filter(c => c.rules_committee).length;
  const byClan = {};
  for (const c of distList) {
    if (c.clan) byClan[c.clan] = (byClan[c.clan] || 0) + 1;
  }
  const audienceOptions = [
    { value: 'all', label: `All (${total})`, count: total },
    { value: 'committee', label: `Rules Committee (${committee})`, count: committee },
    ...Object.keys(byClan).sort().map(name => ({
      value: `clan:${name}`,
      label: `Clan: ${name} (${byClan[name]})`,
      count: byClan[name],
    })),
  ];
  const recentEvents = db.prepare(
    "SELECT event_type, recipient, subject, occurred_at FROM email_events ORDER BY occurred_at DESC LIMIT 30"
  ).all();
  const eventStats = db.prepare(
    "SELECT event_type, COUNT(*) AS c FROM email_events WHERE received_at >= datetime('now', '-30 days') GROUP BY event_type"
  ).all().reduce((a, r) => (a[r.event_type] = r.c, a), {});
  res.render('admin/email-compose', { sentEmails, emailCount: total, audienceOptions, recentEvents, eventStats });
});

// Distribution list / Contacts
router.get('/contacts', (req, res) => {
  const distList = db.prepare('SELECT id, first_name, last_name, email, clan, rules_committee FROM distribution_list ORDER BY last_name, first_name').all();
  const clans = [...new Set(distList.map(c => c.clan).filter(Boolean))].sort();
  const committeeCount = distList.filter(c => c.rules_committee).length;
  res.render('admin/contacts', { distList, clans, committeeCount });
});

// Generate a broadcast email subject + body from rough notes the admin
// pastes into the compose page. Calls Anthropic with a tool-use shape so
// the response is always { subject, body_html }.
router.post('/email/generate', express.json(), async (req, res) => {
  const notes = (req.body && typeof req.body.notes === 'string' ? req.body.notes : '').trim();
  if (!notes) return res.status(400).json({ error: 'notes required' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing)' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const settings = getSettings();
    const tournamentDate = settings.tournament_date || 'Friday, July 3, 2026';
    const courseName = settings.course_name || 'Tarry Brae Golf Course';

    const systemPrompt = `You write broadcast emails for the Claryville Open, an annual family golf tournament held ${tournamentDate} at ${courseName}. The audience is the family + friends distribution list — ~55 people who have been part of this tournament for 30+ years.

TONE
- Warm, casual, family-friendly. Light humor is fine but don't try too hard.
- Keep it short — typically 2 to 5 short paragraphs.
- Sign off with "— Pete" for friendly updates, or "— The Claryville Open Committee" for official announcements. Choose based on the content.

FORMAT
- Output the body as HTML.
- Wrap each paragraph in <p style="margin:0 0 1em 0;"> so spacing renders in email clients (which often strip stylesheets).
- Use <strong> for emphasis and <a href="..."> for links.
- Use <ul><li>...</li></ul> for short bullet lists when appropriate. Style the <ul> with margin:0 0 1em 0.
- Do NOT include <html>, <body>, or <h1> tags — the email service wraps the body.
- Do NOT put quotes around the subject. Subject is plain text.

WHAT YOU GET
- The user pastes rough notes, a forwarded message, or a few bullet points. Turn it into a polished email. Paraphrase forwarded text rather than quoting verbatim. If the notes mention a deadline or call to action, surface it clearly. If a URL is mentioned, include it as a clickable link.`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      tools: [{
        name: 'compose_email',
        description: 'Compose a broadcast email subject and body for the Claryville Open distribution list.',
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Concise subject line. No surrounding quotes.' },
            body_html: { type: 'string', description: 'HTML body using inline <p style="margin:0 0 1em 0;"> for paragraphs.' },
          },
          required: ['subject', 'body_html'],
        },
      }],
      tool_choice: { type: 'tool', name: 'compose_email' },
      messages: [{ role: 'user', content: notes }],
    });

    const toolUse = msg.content.find(c => c.type === 'tool_use');
    if (!toolUse) return res.status(500).json({ error: 'AI returned no draft' });
    res.json({ subject: toolUse.input.subject, body_html: toolUse.input.body_html });
  } catch (err) {
    console.error('[Admin/email/generate] error:', err.message || err);
    res.status(500).json({ error: err.message || 'AI error' });
  }
});

router.post('/email/send', express.urlencoded({ extended: true }), async (req, res) => {
  const { subject, body } = req.body;
  const audience = req.body.audience || 'all';
  const scheduledAtRaw = (req.body.scheduled_at || '').trim();

  // Validate scheduled_at if present — must be a parseable ISO timestamp at
  // least a minute in the future.
  let scheduledAt = null;
  if (scheduledAtRaw) {
    const d = new Date(scheduledAtRaw);
    if (isNaN(d.getTime())) {
      return res.status(400).send('Invalid scheduled time.');
    }
    if (d.getTime() < Date.now() + 60_000) {
      return res.status(400).send('Scheduled time must be at least a minute in the future.');
    }
    scheduledAt = d.toISOString();
  }

  let rows;
  if (audience === 'all') {
    rows = db.prepare('SELECT email FROM distribution_list').all();
  } else if (audience === 'committee') {
    rows = db.prepare('SELECT email FROM distribution_list WHERE rules_committee = 1').all();
  } else if (audience.startsWith('clan:')) {
    const clanName = audience.slice('clan:'.length);
    rows = db.prepare('SELECT email FROM distribution_list WHERE clan = ?').all(clanName);
  } else {
    return res.status(400).send('Invalid audience');
  }

  const recipients = rows.map(r => r.email);
  if (recipients.length === 0) {
    return res.status(400).send('No recipients match the selected audience.');
  }

  // Rules committee: send one email with everyone visible to each other so
  // reply-all loops in the whole committee. Broadcasts (all, clan) stay
  // per-recipient so addresses aren't exposed across the distribution list.
  if (audience === 'committee') {
    await EmailService.sendGroup(recipients, subject, body, { scheduledAt });
  } else {
    await EmailService.sendBulk(recipients, subject, body, { scheduledAt });
  }
  res.redirect('/admin/email');
});

// Distribution list management
router.post('/contacts/add', express.urlencoded({ extended: true }), (req, res) => {
  const { first_name, last_name, email, clan } = req.body;
  const rules_committee = req.body.rules_committee ? 1 : 0;
  if (!email) return res.redirect('/admin/contacts');
  try {
    db.prepare('INSERT OR IGNORE INTO distribution_list (first_name, last_name, email, clan, rules_committee) VALUES (?, ?, ?, ?, ?)')
      .run(first_name || null, last_name || null, email, clan || null, rules_committee);
  } catch (err) {
    console.error('[Admin] Error adding contact:', err.message);
  }
  res.redirect('/admin/contacts');
});

router.post('/contacts/:id/edit', express.urlencoded({ extended: true }), (req, res) => {
  const { first_name, last_name, email, clan } = req.body;
  const rules_committee = req.body.rules_committee ? 1 : 0;
  db.prepare('UPDATE distribution_list SET first_name = ?, last_name = ?, email = ?, clan = ?, rules_committee = ? WHERE id = ?')
    .run(first_name || null, last_name || null, email, clan || null, rules_committee, req.params.id);
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

// Careers — list applications submitted via /careers/apply
router.get('/careers', (req, res) => {
  const applications = db.prepare(
    'SELECT id, name, email, phone, why_interested, reviewed, created_at FROM careers_applications ORDER BY created_at DESC'
  ).all();
  const newCount = applications.filter(a => !a.reviewed).length;
  res.render('admin/careers', { applications, newCount });
});

router.post('/careers/:id/reviewed', (req, res) => {
  db.prepare('UPDATE careers_applications SET reviewed = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/careers');
});

router.post('/careers/:id/delete', (req, res) => {
  db.prepare('DELETE FROM careers_applications WHERE id = ?').run(req.params.id);
  res.redirect('/admin/careers');
});

// Pending actions — proposals the AI extractor made from inbound emails.
// One-click approve actually mutates the relevant table; reject just marks it.
router.post('/actions/:id/approve', (req, res) => {
  const action = db.prepare('SELECT * FROM pending_actions WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!action) return res.redirect('/admin/inbox');
  try {
    const payload = JSON.parse(action.payload_json);
    if (action.action_type === 'add_contact') {
      const email = (payload.email || '').trim();
      if (!email) throw new Error('action payload missing email');
      // Idempotent insert — INSERT OR IGNORE on the unique email constraint
      db.prepare(
        'INSERT OR IGNORE INTO distribution_list (first_name, last_name, email, clan, rules_committee) VALUES (?, ?, ?, ?, ?)'
      ).run(
        payload.first_name || null,
        payload.last_name || null,
        email,
        payload.clan || null,
        payload.rules_committee ? 1 : 0
      );
    } else {
      throw new Error('unknown action_type: ' + action.action_type);
    }
    db.prepare("UPDATE pending_actions SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(action.id);
  } catch (err) {
    console.error('[Admin] approve action error:', err.message);
  }
  res.redirect('/admin/inbox');
});

router.post('/actions/:id/reject', (req, res) => {
  db.prepare("UPDATE pending_actions SET status = 'rejected', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'").run(req.params.id);
  res.redirect('/admin/inbox');
});

// Re-run the AI extractor against a specific inbox message — useful for
// messages that came in before this feature existed, or to retry after
// fixing context.
router.post('/inbox/:id/extract-actions', async (req, res) => {
  const message = db.prepare('SELECT id, from_addr, subject, body FROM inbox_messages WHERE id = ?').get(req.params.id);
  if (!message) return res.redirect('/admin/inbox');
  try {
    const { extractActions } = require('../services/action-extractor');
    await extractActions(message);
  } catch (err) {
    console.error('[Admin] extract-actions error:', err.message);
  }
  res.redirect('/admin/inbox');
});

// Chat log — shows questions asked of the AI caddy on /questions
router.get('/chat-log', (req, res) => {
  const turns = db.prepare(
    'SELECT id, conversation_id, question, answer, is_fallback, created_at FROM chat_log ORDER BY created_at DESC LIMIT 500'
  ).all();
  // Group consecutive turns by conversation, newest first
  const conversations = [];
  const byId = new Map();
  for (const t of turns) {
    if (!byId.has(t.conversation_id)) {
      const conv = { id: t.conversation_id, turns: [], first_at: t.created_at, last_at: t.created_at };
      byId.set(t.conversation_id, conv);
      conversations.push(conv);
    }
    const conv = byId.get(t.conversation_id);
    conv.turns.push(t);
    if (t.created_at < conv.first_at) conv.first_at = t.created_at;
    if (t.created_at > conv.last_at) conv.last_at = t.created_at;
  }
  // Display oldest-to-newest within each conversation
  for (const c of conversations) c.turns.reverse();
  const totalTurns = db.prepare('SELECT COUNT(*) AS c FROM chat_log').get().c;
  const fallbackTurns = db.prepare('SELECT COUNT(*) AS c FROM chat_log WHERE is_fallback = 1').get().c;
  res.render('admin/chat-log', { conversations, totalTurns, fallbackTurns });
});

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

module.exports = router;
