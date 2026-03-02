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

  CREATE TABLE IF NOT EXISTS gallery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT,
    media_type TEXT NOT NULL CHECK(media_type IN ('photo', 'video')),
    caption TEXT,
    uploaded_by TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS draft_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_message_id INTEGER NOT NULL REFERENCES inbox_messages(id),
    draft_subject TEXT NOT NULL,
    draft_body TEXT NOT NULL,
    is_rule_suggestion INTEGER DEFAULT 0,
    suggested_rule_text TEXT,
    status TEXT DEFAULT 'pending',
    edited_body TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  );

  CREATE TABLE IF NOT EXISTS tournament_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_text TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    added_from_suggestion INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS distribution_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT,
    last_name TEXT,
    email TEXT NOT NULL UNIQUE,
    clan TEXT,
    created_at TEXT DEFAULT (datetime('now'))
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

// Seed gallery with initial photos/video if empty
const galleryCount = db.prepare('SELECT COUNT(*) as c FROM gallery').get();
if (galleryCount.c === 0) {
  const insertGallery = db.prepare(
    'INSERT INTO gallery (filename, original_name, media_type, caption, approved) VALUES (?, ?, ?, ?, 1)'
  );
  insertGallery.run('IMG_2020.jpg', 'IMG_2020.jpg', 'photo', 'On the course', );
  insertGallery.run('IMG_4703.jpg', 'IMG_4703.jpg', 'photo', 'On the green');
  insertGallery.run('IMG_6812.mp4', 'IMG_6812.MOV', 'video', 'Claryville Open highlights');
}

// Seed distribution list if empty
const distCount = db.prepare('SELECT COUNT(*) as c FROM distribution_list').get();
if (distCount.c === 0) {
  const insertDist = db.prepare(
    'INSERT INTO distribution_list (first_name, last_name, email, clan) VALUES (?, ?, ?, ?)'
  );
  const contacts = [
    ['Peter', 'Andruszkiewicz', 'petera191@gmail.com', 'Andruszkiewicz'],
    ['Matt', 'Quinn', 'Mattq@kraftse.com', 'Quinn'],
    ['Geoff', 'Walsh', 'geoff61@hvc.rr.com', 'Walsh'],
    ['Tim', 'Allan', 'timothy.g.allan@gmail.com', 'Allan'],
    ['Lisa', 'Guerrero', 'lguerrero333@gmail.com', 'Guerrero'],
    ['Russell', 'Turner', 'turner25.rt@gmail.com', 'Turner'],
    [null, null, 'menuadore@gmail.com', null],
    ['Derek', 'Frome', 'defrome@gmail.com', 'Frome'],
    ['Doug', 'Hamilton', 'doham97@yahoo.com', 'Hamilton'],
    ['Eily', 'Andruszkiewicz Allan', 'eaa326@gmail.com', 'Andruszkiewicz'],
    ['Danielle', 'Andruszkiewicz', 'Dannygirl10@gmail.com', 'Andruszkiewicz'],
    ['Nicholas', 'Freeh', 'nicholasfreeh@gmail.com', 'Freeh'],
    ['Judy', 'Hafner', 'judyhafner@yahoo.com', 'Hafner'],
    ['Conor', 'Quinn', 'conorquinn22@gmail.com', 'Quinn'],
    ['Jenny', 'Freeh', 'jsfreeh@gmail.com', 'Freeh'],
    ['Mike', 'Schiffer', 'mikeschiffer37@gmail.com', 'Schiffer'],
    ['John', 'Sopp', 'jsopp62@gmail.com', 'Sopp'],
    ['Meaghan', 'Quinn', 'meaghan.quinn92@gmail.com', 'Quinn'],
    ['Will', 'Breaden', 'will.breaden@gmail.com', 'Breaden'],
    ['John', 'Quinn', 'JJQuinn62@gmail.com', 'Quinn'],
    ['Kelly', 'Jones', 'kjones@segalco.com', 'Jones'],
    ['Ellen', 'Quinn', 'ellensquinn@gmail.com', 'Quinn'],
    ['Kathy', 'Schiffer', 'ktschiffer1124@gmail.com', 'Schiffer'],
    ['Buff', 'Creek', 'buffcreek01@gmail.com', 'Creek'],
    ['James', 'Caldwell', 'jamie.caldwell.ct@gmail.com', 'Caldwell'],
    ['Jerry', 'Huncosky', 'gsh1958@gmail.com', 'Huncosky'],
    ['Andrew', 'Hafner', 'andrewhafner@optonline.net', 'Hafner'],
    ['Pete', 'Andruszkiewicz', 'pandruszk@gmail.com', 'Andruszkiewicz'],
    ['Andrew', 'Schiffer', 'ajs9113@gmail.com', 'Schiffer'],
    ['Bobby', 'Poillucci', 'bpoillucci@gmail.com', 'Poillucci'],
    ['Scott', 'Wellington', 'well1369@bellsouth.net', 'Wellington'],
    ['Pat', 'Jones', 'patjones310@gmail.com', 'Jones'],
    ['Peter', 'Sayadoff', 'PSayadoff@uniland.com', 'Sayadoff'],
    ['Les', 'Brehm', 'lbrehm12@gmail.com', 'Brehm'],
    ['Bob', 'Quackenbush', 'bobquackenbush@gmail.com', 'Quackenbush'],
    ['Evan', 'Flanagan', 'indgaco@ptd.net', 'Flanagan'],
    ['Keith', 'Zanetti', 'kzsercen@hotmail.com', 'Zanetti'],
    ['Bob', 'Quackenbush', 'randmquack@verizon.net', 'Quackenbush'],
    ['Brad', 'Jones', 'brad.s.jones24@gmail.com', 'Jones'],
    ['Doug', 'Harlow', 'harlowdj@yahoo.com', 'Harlow'],
    ['Riel', 'Peerbooms', 'rpeerbooms@frostvalley.org', 'Peerbooms'],
    ['Bob', 'Eddings', 'beddings@frostvalley.org', 'Eddings'],
    ['Dan', 'Quinn', 'danquinn66@yahoo.com', 'Quinn'],
    ['Julie', 'Climer', 'julieclimer@hotmail.com', 'Climer'],
    ['Grace', 'Andruszkiewicz', 'graceandruszkiewicz@gmail.com', 'Andruszkiewicz'],
    ['Pat', 'Wellington', 'DPWELLI@aol.com', 'Wellington'],
    ['Vince', 'Freeh', 'vwfreeh@gmail.com', 'Freeh'],
    ['Thom', 'Reeves', 'cartercreagh1@gmail.com', 'Reeves'],
    ['Therese', 'Brehm', 'tbrehm86@gmail.com', 'Brehm'],
    ['Gordy', 'Jones', 'GJones@gryphongroup.us', 'Jones'],
    ['Molly', 'Andruszkiewicz Frome', 'mollyafrome@gmail.com', 'Andruszkiewicz'],
    ['Pat', 'Quinn', 'patrick.quinn6492@gmail.com', 'Quinn'],
  ];
  const seedDist = db.transaction(() => {
    for (const [first, last, email, clan] of contacts) {
      insertDist.run(first, last, email, clan);
    }
  });
  seedDist();
}

module.exports = db;
