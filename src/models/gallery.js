const db = require('./db');

const Gallery = {
  add(filename, originalName, mediaType, caption, uploadedBy) {
    return db.prepare(
      'INSERT INTO gallery (filename, original_name, media_type, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)'
    ).run(filename, originalName, mediaType, caption || null, uploadedBy || null);
  },

  getApproved() {
    return db.prepare('SELECT * FROM gallery WHERE approved = 1 ORDER BY created_at DESC').all();
  },

  getPending() {
    return db.prepare('SELECT * FROM gallery WHERE approved = 0 ORDER BY created_at DESC').all();
  },

  getAll() {
    return db.prepare('SELECT * FROM gallery ORDER BY created_at DESC').all();
  },

  approve(id) {
    db.prepare('UPDATE gallery SET approved = 1 WHERE id = ?').run(id);
  },

  updateCaption(id, caption) {
    db.prepare('UPDATE gallery SET caption = ? WHERE id = ?').run(caption || null, id);
  },

  delete(id) {
    return db.prepare('DELETE FROM gallery WHERE id = ? RETURNING filename').get(id);
  },
};

module.exports = Gallery;
