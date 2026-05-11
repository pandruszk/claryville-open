// Reads an inbound inbox message and asks Claude to propose structured
// actions (currently: add_contact) using tool-use. Proposals land in the
// pending_actions table for admin approval — nothing executes automatically.
const db = require('../models/db');

const SYSTEM_PROMPT = `You read inbound emails to the Claryville Open Rules Committee and identify NEW CONTACTS that should be added to the distribution list.

WHAT COUNTS AS A NEW CONTACT
- A person mentioned in the email along with an email address that looks like a real address (name + email@domain).
- Typical sources: forwarded chains where someone says "please add these people", recipient lists ("Cc: Name <email>"), or explicit requests like "Add Joe Smith joe@example.com".

WHAT TO IGNORE
- The Rules Committee admin address (rulescommittee@claryvilleopen.com)
- The current sender's own address (they're already a contact or are emailing the committee)
- Addresses that are clearly automated (notifications@, no-reply@, postmaster@)
- Generic forwarded headers without a name (just an address with no person attached)

FOR EACH NEW CONTACT
- Use first_name and last_name as parsed from the display name. If only one name is given, put it in first_name and leave last_name null.
- Infer clan = last_name when it looks like a family surname (e.g., Breaden, Quinn). Skip clan if it's unclear.
- rules_committee should be false unless the email explicitly says the person is on the rules committee.
- rationale: one short sentence on why you're proposing this (e.g., "Mentioned in forwarded Breaden family CC list").

If no new contacts are mentioned in the email, do not call the tool — return an empty message.`;

async function extractActions(inboxMessage) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { proposed: 0, error: 'ANTHROPIC_API_KEY not configured' };
  }
  if (!inboxMessage || !inboxMessage.body || !inboxMessage.body.trim()) {
    return { proposed: 0 };
  }

  // Build a dedup set of emails already on file (lowercased)
  const existingEmails = new Set(
    db.prepare('SELECT lower(email) AS e FROM distribution_list').all().map(r => r.e)
  );

  // Build the user prompt — include the sender so the model knows whose address to skip
  const userText = `Inbox message:
From: ${inboxMessage.from_addr || '(unknown)'}
Subject: ${inboxMessage.subject || '(no subject)'}

Body:
${inboxMessage.body.slice(0, 12000)}`;

  let response;
  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: [{
        name: 'propose_add_contact',
        description: 'Propose adding one new contact to the Claryville Open distribution list. Will be queued for admin approval — NOT executed automatically. Call once per distinct person you want to add.',
        input_schema: {
          type: 'object',
          properties: {
            first_name: { type: 'string', description: "Person's first name. Required." },
            last_name: { type: ['string', 'null'], description: "Last name, or null if only one name is given." },
            email: { type: 'string', description: 'Email address. Required.' },
            clan: { type: ['string', 'null'], description: "Family clan name (typically the last name)." },
            rules_committee: { type: 'boolean', description: 'True only if the email explicitly says this person is on the rules committee.' },
            rationale: { type: 'string', description: 'One short sentence about why this contact is being proposed.' },
          },
          required: ['first_name', 'email', 'rationale'],
        },
      }],
      messages: [{ role: 'user', content: userText }],
    });
  } catch (err) {
    console.error('[ActionExtractor] AI call failed:', err.message);
    return { proposed: 0, error: err.message };
  }

  const toolCalls = (response.content || []).filter(c => c.type === 'tool_use' && c.name === 'propose_add_contact');
  let proposed = 0;
  let skipped = 0;
  const insert = db.prepare(
    "INSERT INTO pending_actions (inbox_message_id, action_type, payload_json, rationale) VALUES (?, 'add_contact', ?, ?)"
  );

  for (const tc of toolCalls) {
    const input = tc.input || {};
    const email = (input.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
    if (existingEmails.has(email)) { skipped++; continue; }
    // Also skip if we already have a pending proposal for the same email + inbox row
    const dup = db.prepare(
      "SELECT 1 FROM pending_actions WHERE inbox_message_id = ? AND action_type = 'add_contact' AND lower(json_extract(payload_json, '$.email')) = ? AND status = 'pending'"
    ).get(inboxMessage.id, email);
    if (dup) { skipped++; continue; }

    const payload = {
      first_name: (input.first_name || '').trim() || null,
      last_name: input.last_name ? String(input.last_name).trim() : null,
      email,
      clan: input.clan ? String(input.clan).trim() : null,
      rules_committee: !!input.rules_committee,
    };
    insert.run(inboxMessage.id, JSON.stringify(payload), input.rationale || null);
    proposed++;
  }

  if (proposed || skipped) {
    console.log(`[ActionExtractor] inbox ${inboxMessage.id}: proposed ${proposed}, skipped ${skipped}`);
  }
  return { proposed, skipped };
}

module.exports = { extractActions };
