const Anthropic = require('@anthropic-ai/sdk').default;
const db = require('../models/db');

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function buildTournamentContext() {
  // Pull live settings
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;

  // Pull custom tournament rules
  const customRules = db.prepare('SELECT rule_text, category FROM tournament_rules ORDER BY category, id').all();

  // Registration stats
  const playerCount = db.prepare('SELECT COUNT(*) as c FROM players').get().c;
  const groupCount = db.prepare('SELECT COUNT(*) as c FROM groups').get().c;

  let context = `You are the friendly Rules Committee for The Claryville Open, an annual family golf scramble tournament.

TOURNAMENT DETAILS:
- Event: ${settings.tournament_name || 'The Claryville Open'}
- Year: ${settings.tournament_year || '2026'}
- Date: ${settings.tournament_date || 'TBD'}
- Course: ${settings.course_name || 'TBD'}
- Format: 4-person best ball scramble
- Registration: ${settings.registration_open === 'true' ? 'OPEN' : 'CLOSED'}
- Currently registered: ${playerCount} players in ${groupCount} groups
- All proceeds benefit the Claryville Fire Department
- Est. 1993 — over 30 years of tradition

FORMAT RULES:
- Each team member hits a drive. Choose the best drive. All hit from that spot. Continue until ball is in the hole.
- At least 2 drives must be used per team member under 65.
- Teams of 3 may have 4 attempts per shot, rotating the extra.
- No gimmes, no mulligans, no cheating.
- Turn in cards at the Firehouse BBQ.

TEAM STROKE RULES:
- Over 65: -1 per player (cumulative with other age brackets)
- Over 75: -1 per player
- Over 80: -1 per player
- Over 85: -1 per player
- Over 90: -1 per player
- Female: -2 per player
- Under 16: -1 per player
- Under 10: -1 per player (cumulative with under 16)
- Never played on a course: -1
- Heart attack/stroke/brain tumor: -1
- Current/former U.S. military: -1
- Post-partum (up to 1 year): -1
- High school golf team (under 55): +1
- College golf team (under 55): +1
- PGA/LPGA tour: +10
- Sandbagger Rule: max 10 strokes reduced per team
- No strokes for team members who don't compete

TEE BOX ASSIGNMENTS:
- Men with GHIN < 10: Black tees
- Men: Green tees
- Men over 80: Gold tees
- Men over 90: Orange tees
- Women: Yellow tees
- Women over 80: Orange tees
- Kids under 10: Orange tees
- Only plays golf at Claryville Open: Orange tees

PRIZES:
- Low Net Team Score
- Low Gross Team
- High Net Team Score
- Closest to the Pin (Male & Female)
- Longest Drive (Male & Female)
- Tiebreaker: reverse scorecard comparison from 18th hole

WEBSITE: https://claryvilleopen.com
REGISTER: https://claryvilleopen.com/register
RULES: https://claryvilleopen.com/rules`;

  if (customRules.length > 0) {
    context += '\n\nADDITIONAL CUSTOM RULES:';
    for (const rule of customRules) {
      context += `\n- [${rule.category}] ${rule.rule_text}`;
    }
  }

  // Registered groups and players
  const groups = db.prepare('SELECT id, name, status FROM groups ORDER BY id').all();
  if (groups.length > 0) {
    context += '\n\nREGISTERED GROUPS & PLAYERS:';
    for (const g of groups) {
      const players = db.prepare('SELECT name, age, gender, ghin_index FROM players WHERE group_id = ? ORDER BY id').all(g.id);
      const playerList = players.map(p => {
        let desc = p.name;
        const details = [];
        if (p.age) details.push(`age ${p.age}`);
        if (p.gender) details.push(p.gender);
        if (p.ghin_index !== null) details.push(`GHIN ${p.ghin_index}`);
        if (details.length) desc += ` (${details.join(', ')})`;
        return desc;
      }).join(', ');
      context += `\n- ${g.name} [${g.status}]: ${playerList || 'no players yet'}`;
    }
  }

  // Past winners
  const winners = db.prepare("SELECT pw.year, GROUP_CONCAT(pwp.display_name, ', ') AS team FROM past_winners pw LEFT JOIN past_winner_players pwp ON pwp.past_winner_id = pw.id GROUP BY pw.id ORDER BY pw.year ASC").all();
  if (winners.length > 0) {
    context += '\n\nPAST WINNERS:';
    for (const w of winners) {
      context += `\n- ${w.year}: ${w.team || 'Unknown'}`;
    }
  }

  return context;
}

async function generateDraft(inboxMessage) {
  const anthropic = getClient();
  if (!anthropic) {
    console.log('[AutoReply] No API key configured, skipping draft generation');
    return null;
  }

  const systemPrompt = buildTournamentContext();

  const userPrompt = `Analyze this incoming email and respond with a JSON object.

FROM: ${inboxMessage.from_addr}
SUBJECT: ${inboxMessage.subject}
BODY:
${inboxMessage.body}

---

Instructions:
1. Classify this email as either "RULE_SUGGESTION" (the sender is proposing a new rule, rule change, or stroke adjustment for the tournament) or "GENERAL_INQUIRY" (anything else — questions, registration help, logistics, etc.)
2. If it's a RULE_SUGGESTION, extract the specific proposed rule text in a clear, concise form.
3. Draft a friendly, helpful HTML reply from the Rules Committee. Use <p> tags for paragraphs. Be warm but professional. Sign off as "The Claryville Open Rules Committee". Include relevant links to the website when helpful.
4. For rule suggestions, acknowledge the suggestion warmly and let them know the Rules Committee will review it. Do NOT commit to accepting it.
5. For general inquiries, answer as helpfully as possible using the tournament information above.
6. Keep replies concise — 2-4 short paragraphs max.

Respond ONLY with valid JSON (no markdown fencing):
{
  "classification": "RULE_SUGGESTION" or "GENERAL_INQUIRY",
  "subject": "Re: <appropriate subject>",
  "body": "<html reply body>",
  "suggestedRuleText": "<extracted rule text or null>"
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      system: systemPrompt,
    });

    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text);

    return {
      subject: parsed.subject || `Re: ${inboxMessage.subject}`,
      body: parsed.body,
      isRuleSuggestion: parsed.classification === 'RULE_SUGGESTION' ? 1 : 0,
      suggestedRuleText: parsed.suggestedRuleText || null,
    };
  } catch (err) {
    console.error('[AutoReply] Draft generation error:', err.message);
    return null;
  }
}

async function processNewMessages() {
  // Find inbox messages without a draft
  const messages = db.prepare(`
    SELECT im.* FROM inbox_messages im
    LEFT JOIN draft_replies dr ON dr.inbox_message_id = im.id
    WHERE dr.id IS NULL
    ORDER BY im.received_at ASC
  `).all();

  if (messages.length === 0) return;

  console.log(`[AutoReply] Processing ${messages.length} new message(s)`);

  const insertStmt = db.prepare(`
    INSERT INTO draft_replies (inbox_message_id, draft_subject, draft_body, is_rule_suggestion, suggested_rule_text)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const msg of messages) {
    try {
      const draft = await generateDraft(msg);
      if (draft) {
        insertStmt.run(msg.id, draft.subject, draft.body, draft.isRuleSuggestion, draft.suggestedRuleText);
        console.log(`[AutoReply] Draft created for message ${msg.id} (${draft.isRuleSuggestion ? 'rule suggestion' : 'general'})`);
      }
    } catch (err) {
      console.error(`[AutoReply] Error processing message ${msg.id}:`, err.message);
    }
  }
}

// CRUD helpers

function getDraftByMessageId(messageId) {
  return db.prepare('SELECT * FROM draft_replies WHERE inbox_message_id = ?').get(messageId);
}

function getDraftById(id) {
  return db.prepare('SELECT * FROM draft_replies WHERE id = ?').get(id);
}

function getAllPending() {
  return db.prepare(`
    SELECT dr.*, im.from_addr, im.subject as original_subject
    FROM draft_replies dr
    JOIN inbox_messages im ON im.id = dr.inbox_message_id
    WHERE dr.status = 'pending'
    ORDER BY dr.created_at DESC
  `).all();
}

function getRuleSuggestions() {
  return db.prepare(`
    SELECT dr.*, im.from_addr, im.subject as original_subject
    FROM draft_replies dr
    JOIN inbox_messages im ON im.id = dr.inbox_message_id
    WHERE dr.is_rule_suggestion = 1 AND dr.status = 'pending'
    ORDER BY dr.created_at DESC
  `).all();
}

function updateDraftBody(id, editedBody) {
  db.prepare('UPDATE draft_replies SET edited_body = ? WHERE id = ?').run(editedBody, id);
}

function markSent(id) {
  db.prepare("UPDATE draft_replies SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(id);
}

function markDismissed(id) {
  db.prepare("UPDATE draft_replies SET status = 'dismissed' WHERE id = ?").run(id);
}

function deleteDraft(id) {
  db.prepare('DELETE FROM draft_replies WHERE id = ?').run(id);
}

function getStats() {
  const pending = db.prepare("SELECT COUNT(*) as c FROM draft_replies WHERE status = 'pending'").get().c;
  const ruleSuggestions = db.prepare("SELECT COUNT(*) as c FROM draft_replies WHERE is_rule_suggestion = 1 AND status = 'pending'").get().c;
  const sent = db.prepare("SELECT COUNT(*) as c FROM draft_replies WHERE status = 'sent'").get().c;
  return { pending, ruleSuggestions, sent };
}

// Rule management

function addTournamentRule(ruleText, category = 'general', fromSuggestion = 0) {
  return db.prepare('INSERT INTO tournament_rules (rule_text, category, added_from_suggestion) VALUES (?, ?, ?)')
    .run(ruleText, category, fromSuggestion);
}

function getTournamentRules() {
  return db.prepare('SELECT * FROM tournament_rules ORDER BY category, id').all();
}

function deleteTournamentRule(id) {
  db.prepare('DELETE FROM tournament_rules WHERE id = ?').run(id);
}

module.exports = {
  buildTournamentContext,
  generateDraft,
  processNewMessages,
  getDraftByMessageId,
  getDraftById,
  getAllPending,
  getRuleSuggestions,
  updateDraftBody,
  markSent,
  markDismissed,
  deleteDraft,
  getStats,
  addTournamentRule,
  getTournamentRules,
  deleteTournamentRule,
};
