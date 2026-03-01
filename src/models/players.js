const db = require('./db');

const PLAYER_FIELDS = [
  'name', 'email', 'age', 'gender', 'ghin_index', 'group_id',
  'is_military', 'never_played_course', 'heart_attack_stroke_tumor',
  'played_high_school_golf', 'played_college_golf', 'played_pga_lpga',
  'is_post_partum', 'only_plays_claryville',
];

const Players = {
  create(data) {
    const fields = [];
    const placeholders = [];
    const values = [];
    for (const key of PLAYER_FIELDS) {
      if (data[key] !== undefined) {
        fields.push(key);
        placeholders.push('?');
        values.push(data[key]);
      }
    }
    const stmt = db.prepare(
      `INSERT INTO players (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`
    );
    return stmt.run(...values);
  },

  getById(id) {
    return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  },

  getAll() {
    return db.prepare(`
      SELECT p.*, g.name as group_name
      FROM players p
      LEFT JOIN groups g ON p.group_id = g.id
      ORDER BY p.created_at DESC
    `).all();
  },

  getByGroup(groupId) {
    return db.prepare('SELECT * FROM players WHERE group_id = ? ORDER BY id').all(groupId);
  },

  getUngrouped() {
    return db.prepare('SELECT * FROM players WHERE group_id IS NULL ORDER BY created_at DESC').all();
  },

  getAllEmails() {
    return db.prepare("SELECT DISTINCT email FROM players WHERE email IS NOT NULL AND email != ''").all()
      .map(r => r.email);
  },

  update(id, fields) {
    const sets = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (PLAYER_FIELDS.includes(key)) {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  },

  delete(id) {
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
  },

  count() {
    return db.prepare('SELECT COUNT(*) as c FROM players').get().c;
  },
};

module.exports = Players;
