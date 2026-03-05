const db = require('./db');

const Groups = {
  create(name) {
    const stmt = db.prepare('INSERT INTO groups (name, status) VALUES (?, ?)');
    return stmt.run(name, 'looking');
  },

  getById(id) {
    return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  },

  getAll() {
    return db.prepare('SELECT * FROM groups ORDER BY created_at').all();
  },

  getAllWithPlayers() {
    const groups = db.prepare('SELECT * FROM groups ORDER BY created_at').all();
    const playersByGroup = db.prepare('SELECT * FROM players WHERE group_id = ? ORDER BY id');
    return groups.map(g => ({
      ...g,
      players: playersByGroup.all(g.id),
    }));
  },

  getComplete() {
    return this.getAllWithPlayers().filter(g => g.status === 'complete');
  },

  getLooking() {
    return this.getAllWithPlayers().filter(g => g.status === 'looking');
  },

  updateStatus(id) {
    const count = db.prepare('SELECT COUNT(*) as c FROM players WHERE group_id = ?').get(id).c;
    const status = count >= 4 ? 'complete' : 'looking';
    db.prepare('UPDATE groups SET status = ? WHERE id = ?').run(status, id);
    return status;
  },

  rename(id, name) {
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
  },

  delete(id) {
    db.prepare('UPDATE players SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM scores WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  },

  movePlayer(playerId, toGroupId) {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!player) return;
    const oldGroupId = player.group_id;

    db.prepare('UPDATE players SET group_id = ? WHERE id = ?').run(toGroupId, playerId);

    // Update status of both groups
    if (oldGroupId) this.updateStatus(oldGroupId);
    if (toGroupId) this.updateStatus(toGroupId);
  },

  count() {
    return db.prepare('SELECT COUNT(*) as c FROM groups').get().c;
  },

  setTeeOrder(id, order) {
    db.prepare('UPDATE groups SET tee_order = ? WHERE id = ?').run(order, id);
  },

  getAllByTeeOrder() {
    return db.prepare('SELECT * FROM groups WHERE tee_order IS NOT NULL ORDER BY tee_order ASC').all();
  },
};

module.exports = Groups;
