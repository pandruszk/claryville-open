const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../data/claryville.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'looking' CHECK(status IN ('complete', 'looking')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    age INTEGER,
    gender TEXT CHECK(gender IN ('male', 'female')),
    ghin_index REAL,
    is_military INTEGER NOT NULL DEFAULT 0,
    never_played_course INTEGER NOT NULL DEFAULT 0,
    heart_attack_stroke_tumor INTEGER NOT NULL DEFAULT 0,
    played_high_school_golf INTEGER NOT NULL DEFAULT 0,
    played_college_golf INTEGER NOT NULL DEFAULT 0,
    played_pga_lpga INTEGER NOT NULL DEFAULT 0,
    is_post_partum INTEGER NOT NULL DEFAULT 0,
    only_plays_claryville INTEGER NOT NULL DEFAULT 0,
    group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    hole_1 INTEGER, hole_2 INTEGER, hole_3 INTEGER, hole_4 INTEGER,
    hole_5 INTEGER, hole_6 INTEGER, hole_7 INTEGER, hole_8 INTEGER,
    hole_9 INTEGER, hole_10 INTEGER, hole_11 INTEGER, hole_12 INTEGER,
    hole_13 INTEGER, hole_14 INTEGER, hole_15 INTEGER, hole_16 INTEGER,
    hole_17 INTEGER, hole_18 INTEGER,
    gross_total INTEGER,
    team_strokes REAL,
    net_total REAL,
    UNIQUE(group_id)
  );

  CREATE TABLE IF NOT EXISTS contests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contest_type TEXT NOT NULL CHECK(contest_type IN (
      'closest_pin_male', 'closest_pin_female',
      'longest_drive_male', 'longest_drive_female'
    )),
    player_name TEXT NOT NULL,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id TEXT UNIQUE,
    donor_name TEXT,
    donor_email TEXT,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS emails_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    recipient_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS inbox_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_addr TEXT,
    subject TEXT,
    body TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Seed default settings if empty
const settingsCount = db.prepare('SELECT COUNT(*) as c FROM settings').get();
if (settingsCount.c === 0) {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const defaults = [
    ['tournament_name', 'The Claryville Open'],
    ['tournament_year', '2026'],
    ['tournament_date', 'Friday, July 3rd, 2026'],
    ['course_name', 'Lochmor Golf Club'],
    ['results_published', 'false'],
    ['registration_open', 'true'],
  ];
  const seedAll = db.transaction(() => {
    for (const [key, value] of defaults) insert.run(key, value);
  });
  seedAll();
}

module.exports = db;
