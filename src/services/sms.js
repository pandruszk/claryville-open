const Anthropic = require('@anthropic-ai/sdk').default;
const AutoReplyService = require('./auto-reply');
const { handleScoreSms } = require('./score-sms');

// In-memory conversation history per phone number (clears on restart)
const conversations = new Map();
const HISTORY_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES = 10;

// Opted-out numbers (persists in memory only — resets on restart)
const optedOut = new Set();

function getHistory(phone) {
  const entry = conversations.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.lastActive > HISTORY_TTL) {
    conversations.delete(phone);
    return [];
  }
  return entry.messages;
}

function addToHistory(phone, role, content) {
  let entry = conversations.get(phone);
  if (!entry || Date.now() - entry.lastActive > HISTORY_TTL) {
    entry = { messages: [], lastActive: Date.now() };
  }
  entry.messages.push({ role, content });
  if (entry.messages.length > MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-MAX_MESSAGES);
  }
  entry.lastActive = Date.now();
  conversations.set(phone, entry);
}

async function handleIncoming(from, body) {
  const cmd = body.toUpperCase().trim();

  // STOP — opt out
  if (cmd === 'STOP' || cmd === 'UNSUBSCRIBE' || cmd === 'CANCEL' || cmd === 'QUIT') {
    optedOut.add(from);
    conversations.delete(from);
    return 'You have been opted out of Claryville Open SMS. You will not receive any more messages. Text START to opt back in.';
  }

  // START — opt back in
  if (cmd === 'START' || cmd === 'SUBSCRIBE') {
    optedOut.delete(from);
    return 'Welcome back to the Claryville Open SMS chatbot! Text any question about the tournament. Msg&data rates may apply. Msg frequency varies. Reply STOP to cancel, HELP for help. Privacy policy: claryvilleopen.com/privacy';
  }

  // HELP
  if (cmd === 'HELP' || cmd === 'INFO') {
    return 'Claryville Open SMS Chatbot. Text any question about the tournament. For support email admin@claryvilleopen.com. Msg&data rates may apply. Reply STOP to opt out.';
  }

  // If opted out, don't respond
  if (optedOut.has(from)) {
    return null;
  }

  // Score commands — SCORE or SCORECARD
  if (/^SCORE(CARD)?\s/i.test(cmd)) {
    try {
      const scoreReply = handleScoreSms(from, body);
      if (scoreReply) return scoreReply;
    } catch (err) {
      console.error('[SMS] Score error:', err.message);
      return 'Error updating score. Try again or text HELP for format instructions.';
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return "The AI caddy is offline. Visit claryvilleopen.com/questions or email rulescommittee@claryvilleopen.com";
  }

  // First-time texter — send welcome + answer
  const isFirstMessage = !conversations.has(from);

  const history = getHistory(from);
  addToHistory(from, 'user', body);

  const systemPrompt = AutoReplyService.buildTournamentContext() + `

IMPORTANT INSTRUCTIONS FOR SMS REPLIES:
- You are the Claryville Open's AI caddy, responding via text message.
- Keep answers SHORT — 2-3 sentences max. People are reading on their phones.
- Be warm, friendly, casual. Like texting with a buddy who knows everything about the tournament.
- No emojis. No markdown formatting. Plain text only.
- If you don't know, say: "Not sure about that one. Visit claryvilleopen.com or email rulescommittee@claryvilleopen.com"
- Never make up rules or info not in your context.
- For stroke calculations, keep it brief but accurate. Ask follow-up questions if needed.
- WEBSITE: claryvilleopen.com

LIVE SCORING VIA TEXT:
- Players can text in scores during the tournament for live leaderboard updates.
- Single hole: "SCORE 5 4" means hole 5, score of 4.
- Full scorecard: "SCORECARD 4 3 5 4 3 5 4 3 4 5 4 3 5 4 3 5 4 3" — all 18 holes in order.
- The player's phone must be registered with their team for it to work.
- If someone asks about texting scores, explain these formats.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const messages = [...history, { role: 'user', content: body }].slice(-MAX_MESSAGES);

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages,
    });

    let answer = msg.content[0]?.text || "Something went wrong. Visit claryvilleopen.com/questions instead.";
    addToHistory(from, 'assistant', answer);

    if (isFirstMessage) {
      answer = 'Welcome to the Claryville Open SMS chatbot! Msg&data rates may apply. Msg frequency varies. Reply STOP to cancel, HELP for help. Privacy: claryvilleopen.com/privacy\n\n' + answer;
    }

    return answer;
  } catch (err) {
    console.error('[SMS] AI error:', err.message);
    return "AI caddy hit a tree. Visit claryvilleopen.com/questions or email rulescommittee@claryvilleopen.com";
  }
}

async function sendReply(to, text) {
  if (!process.env.TELNYX_API_KEY || !process.env.TELNYX_PHONE_NUMBER) {
    console.error('[SMS] Telnyx not configured');
    return;
  }
  const resp = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.TELNYX_PHONE_NUMBER,
      to,
      text,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telnyx send failed (${resp.status}): ${err}`);
  }
  return resp.json();
}

module.exports = { handleIncoming, sendReply };
