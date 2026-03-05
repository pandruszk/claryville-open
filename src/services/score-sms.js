const db = require('../models/db');
const Scores = require('../models/scores');
const Players = require('../models/players');
const { calculateTeamStrokes } = require('./handicap');

/**
 * Normalize a phone number to E.164 (+1XXXXXXXXXX) for matching.
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '+' + digits;
}

/**
 * Find a group by matching the sender's phone to a registered player.
 * Returns { groupId, groupName, playerName } or null.
 */
function findGroupByPhone(from) {
  const fromNorm = normalizePhone(from);
  if (!fromNorm) return null;

  // Get all players with phones
  const players = db.prepare(
    "SELECT p.id, p.name, p.phone, p.group_id, g.name as group_name FROM players p JOIN groups g ON p.group_id = g.id WHERE p.phone IS NOT NULL AND p.phone != ''"
  ).all();

  for (const p of players) {
    if (normalizePhone(p.phone) === fromNorm) {
      return { groupId: p.group_id, groupName: p.group_name, playerName: p.name };
    }
  }
  return null;
}

/**
 * Parse "SCORE 5 4" → { hole: 5, score: 4 }
 */
function parseScoreCommand(body) {
  const match = body.trim().match(/^SCORE\s+(\d{1,2})\s+(\d{1,2})$/i);
  if (!match) return null;
  const hole = parseInt(match[1]);
  const score = parseInt(match[2]);
  if (hole < 1 || hole > 18) return null;
  if (score < 1 || score > 15) return null;
  return { hole, score };
}

/**
 * Parse "SCORECARD 4 3 5 4 3 5 4 3 4 5 4 3 5 4 3 5 4 3" → { holes: [4,3,5,...] }
 */
function parseScorecardCommand(body) {
  const match = body.trim().match(/^SCORECARD\s+(.+)$/i);
  if (!match) return null;
  const nums = match[1].trim().split(/[\s,]+/).map(Number);
  if (nums.length !== 18) return null;
  if (nums.some(n => isNaN(n) || n < 1 || n > 15)) return null;
  return { holes: nums };
}

/**
 * Handle an incoming SMS score update.
 * Returns a text reply string.
 */
function handleScoreSms(from, body) {
  const lookup = findGroupByPhone(from);
  if (!lookup) {
    return "Couldn't find a registered team for this phone number. Make sure your phone is on file at claryvilleopen.com/register.";
  }

  const { groupId, groupName, playerName } = lookup;

  // Try single hole score
  const single = parseScoreCommand(body);
  if (single) {
    // Get existing scores or start fresh
    const existing = Scores.getByGroup(groupId);
    const holes = [];
    for (let i = 1; i <= 18; i++) {
      holes.push(existing ? (existing['hole_' + i] || 0) : 0);
    }
    holes[single.hole - 1] = single.score;

    // Recalculate team strokes
    const players = Players.getByGroup(groupId);
    const strokeInfo = calculateTeamStrokes(players);
    Scores.upsert(groupId, holes, strokeInfo.capped);

    return groupName + ': Hole ' + single.hole + ' = ' + single.score + '. Got it! Text SCORE [hole] [strokes] for more updates.';
  }

  // Try full scorecard
  const full = parseScorecardCommand(body);
  if (full) {
    const players = Players.getByGroup(groupId);
    const strokeInfo = calculateTeamStrokes(players);
    Scores.upsert(groupId, full.holes, strokeInfo.capped);

    const gross = full.holes.reduce((s, h) => s + h, 0);
    const net = gross + strokeInfo.capped;
    return groupName + ': Full scorecard saved! Gross ' + gross + ', Net ' + net + '.';
  }

  return null; // Not a score command — let it fall through to chatbot
}

module.exports = { normalizePhone, findGroupByPhone, parseScoreCommand, parseScorecardCommand, handleScoreSms };
