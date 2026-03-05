const db = require('./db');

const Scores = {
  upsert(groupId, holes, teamStrokes) {
    const grossTotal = holes.reduce((sum, h) => sum + (h || 0), 0);
    const netTotal = grossTotal + teamStrokes; // teamStrokes is negative for reductions

    const existing = db.prepare('SELECT id FROM scores WHERE group_id = ?').get(groupId);
    if (existing) {
      db.prepare(`
        UPDATE scores SET
          hole_1=?, hole_2=?, hole_3=?, hole_4=?, hole_5=?, hole_6=?,
          hole_7=?, hole_8=?, hole_9=?, hole_10=?, hole_11=?, hole_12=?,
          hole_13=?, hole_14=?, hole_15=?, hole_16=?, hole_17=?, hole_18=?,
          gross_total=?, team_strokes=?, net_total=?
        WHERE group_id = ?
      `).run(...holes, grossTotal, teamStrokes, netTotal, groupId);
    } else {
      db.prepare(`
        INSERT INTO scores (group_id,
          hole_1, hole_2, hole_3, hole_4, hole_5, hole_6,
          hole_7, hole_8, hole_9, hole_10, hole_11, hole_12,
          hole_13, hole_14, hole_15, hole_16, hole_17, hole_18,
          gross_total, team_strokes, net_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(groupId, ...holes, grossTotal, teamStrokes, netTotal);
    }
  },

  getByGroup(groupId) {
    return db.prepare('SELECT * FROM scores WHERE group_id = ?').get(groupId);
  },

  /**
   * Tiebreaker: compare scorecards in reverse order from hole 18.
   * Build a tiebreaker key from cumulative reverse-hole scores.
   */
  _tiebreakerKey(score) {
    const holes = [];
    for (let i = 18; i >= 1; i--) {
      holes.push(score[`hole_${i}`] || 0);
    }
    // Cumulative sum going backwards — first value is hole 18,
    // second is hole 18 + hole 17, etc.
    let cum = 0;
    return holes.map(h => { cum += h; return cum; });
  },

  _sortWithTiebreaker(rows, field) {
    return rows.sort((a, b) => {
      if (a[field] !== b[field]) return a[field] - b[field];
      // Tiebreaker: reverse scorecard comparison
      const aKey = this._tiebreakerKey(a);
      const bKey = this._tiebreakerKey(b);
      for (let i = 0; i < aKey.length; i++) {
        if (aKey[i] !== bKey[i]) return aKey[i] - bKey[i];
      }
      return 0;
    });
  },

  getLeaderboardNet() {
    const rows = db.prepare(`
      SELECT s.*, g.name as group_name, g.tee_order
      FROM scores s JOIN groups g ON s.group_id = g.id
    `).all();
    return this._sortWithTiebreaker(rows, 'net_total');
  },

  getLeaderboardGross() {
    const rows = db.prepare(`
      SELECT s.*, g.name as group_name, g.tee_order
      FROM scores s JOIN groups g ON s.group_id = g.id
    `).all();
    return this._sortWithTiebreaker(rows, 'gross_total');
  },

  getHighNet() {
    const rows = db.prepare(`
      SELECT s.*, g.name as group_name
      FROM scores s JOIN groups g ON s.group_id = g.id
      ORDER BY s.net_total DESC
      LIMIT 1
    `).get();
    return rows;
  },

  getAll() {
    return db.prepare(`
      SELECT s.*, g.name as group_name
      FROM scores s JOIN groups g ON s.group_id = g.id
      ORDER BY s.gross_total ASC
    `).all();
  },

  // Contest winners (closest to pin, longest drive)
  setContest(contestType, playerName, value) {
    const existing = db.prepare('SELECT id FROM contests WHERE contest_type = ?').get(contestType);
    if (existing) {
      db.prepare('UPDATE contests SET player_name = ?, value = ? WHERE contest_type = ?')
        .run(playerName, value || null, contestType);
    } else {
      db.prepare('INSERT INTO contests (contest_type, player_name, value) VALUES (?, ?, ?)')
        .run(contestType, playerName, value || null);
    }
  },

  getContests() {
    const rows = db.prepare('SELECT * FROM contests').all();
    const result = {};
    for (const r of rows) result[r.contest_type] = r;
    return result;
  },
};

module.exports = Scores;
