const db = require('./db');

const Donations = {
  create(stripeSessionId, donorName, donorEmail, amount) {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO donations (stripe_session_id, donor_name, donor_email, amount) VALUES (?, ?, ?, ?)'
    );
    return stmt.run(stripeSessionId, donorName, donorEmail, amount);
  },

  getAll() {
    return db.prepare('SELECT * FROM donations ORDER BY created_at DESC').all();
  },

  total() {
    const row = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM donations').get();
    return row.total;
  },

  count() {
    return db.prepare('SELECT COUNT(*) as c FROM donations').get().c;
  },
};

module.exports = Donations;
