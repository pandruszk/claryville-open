/**
 * Claryville Open Team Stroke Calculator
 *
 * Calculates stroke adjustments per player based on tournament rules,
 * then sums for the team (capped at 10 strokes max — Sandbagger Rule).
 *
 * Only competing players count — no strokes for absent team members.
 */

function calculatePlayerStrokes(player) {
  const age = player.age || 0;
  let strokes = 0;
  const breakdown = [];

  // Age-based reductions (cumulative — a 92-year-old gets 1+1+1+1+1 = 5)
  if (age > 90) {
    strokes -= 1;
    breakdown.push('-1: over 90');
  }
  if (age > 85) {
    strokes -= 1;
    breakdown.push('-1: over 85');
  }
  if (age > 80) {
    strokes -= 1;
    breakdown.push('-1: over 80');
  }
  if (age > 75) {
    strokes -= 1;
    breakdown.push('-1: over 75');
  }
  if (age > 65) {
    strokes -= 1;
    breakdown.push('-1: over 65');
  }

  // Under 16
  if (age > 0 && age < 16) {
    strokes -= 1;
    breakdown.push('-1: under 16');
  }

  // Under 10
  if (age > 0 && age < 10) {
    strokes -= 1;
    breakdown.push('-1: under 10');
  }

  // Gender
  if (player.gender === 'female') {
    strokes -= 2;
    breakdown.push('-2: female');
  }

  // Military
  if (player.is_military) {
    strokes -= 1;
    breakdown.push('-1: military');
  }

  // Never played on a course
  if (player.never_played_course) {
    strokes -= 1;
    breakdown.push('-1: never played on a course');
  }

  // Heart attack, stroke, or brain tumor
  if (player.heart_attack_stroke_tumor) {
    strokes -= 1;
    breakdown.push('-1: heart attack/stroke/brain tumor');
  }

  // Post-partum (up to one year after delivery)
  if (player.is_post_partum) {
    strokes -= 1;
    breakdown.push('-1: post-partum');
  }

  // High school golf (penalty until age 55)
  if (player.played_high_school_golf && age < 55) {
    strokes += 1;
    breakdown.push('+1: high school golf team (under 55)');
  }

  // College golf (penalty until age 55)
  if (player.played_college_golf && age < 55) {
    strokes += 1;
    breakdown.push('+1: college golf team (under 55)');
  }

  // PGA/LPGA
  if (player.played_pga_lpga) {
    strokes += 10;
    breakdown.push('+10: PGA/LPGA tour');
  }

  return { strokes, breakdown };
}

function calculateTeamStrokes(players) {
  const playerResults = players.map(p => ({
    name: p.name,
    ...calculatePlayerStrokes(p),
  }));

  let rawTotal = playerResults.reduce((sum, p) => sum + p.strokes, 0);

  // Sandbagger Rule: no more than 10 strokes reduced per team
  // (strokes are negative for reductions, so cap at -10)
  const capped = Math.max(rawTotal, -10);

  return {
    players: playerResults,
    rawTotal,
    capped,
    wasCapped: rawTotal < -10,
    // Net = gross + capped (capped is negative, so this subtracts)
    // e.g., gross 72, capped -8 → net 64
  };
}

function getTeeBox(player) {
  const age = player.age || 0;
  const gender = player.gender;
  const ghin = player.ghin_index;

  if (player.only_plays_claryville) return 'Orange';

  if (age > 0 && age < 10) return 'Orange';

  if (gender === 'female') {
    if (age > 80) return 'Orange';
    return 'Yellow';
  }

  // Male
  if (age > 90) return 'Orange';
  if (age > 80) return 'Gold';
  if (ghin != null && ghin < 10) return 'Black';
  return 'Green';
}

const TEE_COLORS = {
  Black: '#1a1a1a',
  Green: '#2d5016',
  Gold: '#c9a84c',
  Orange: '#e87a2a',
  Yellow: '#d4b800',
};

module.exports = { calculatePlayerStrokes, calculateTeamStrokes, getTeeBox, TEE_COLORS };
