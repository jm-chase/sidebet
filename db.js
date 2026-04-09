const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'golf.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    course TEXT NOT NULL,
    date TEXT NOT NULL,
    rounds INTEGER NOT NULL DEFAULT 2,
    hcp_allowance INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'setup',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    handicap_index REAL NOT NULL DEFAULT 0,
    course_handicap INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
  );

  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    tournament_id INTEGER NOT NULL,
    bettor_name TEXT NOT NULL,
    player_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS tournament_results (
    tournament_id INTEGER PRIMARY KEY,
    first_player_id INTEGER,
    second_player_id INTEGER,
    third_player_id INTEGER,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    gross_score INTEGER NOT NULL,
    UNIQUE(tournament_id, player_id, round),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS hole_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    hole INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'locked',
    winner_player_id INTEGER,
    is_push INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tournament_id, round, hole),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
  );

  CREATE TABLE IF NOT EXISTS hole_bets (
    id TEXT PRIMARY KEY,
    tournament_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    hole INTEGER NOT NULL,
    bettor_name TEXT NOT NULL,
    player_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS pvp_matchups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    player1_id INTEGER NOT NULL,
    player2_id INTEGER NOT NULL,
    scoring_type TEXT NOT NULL DEFAULT 'net',
    status TEXT NOT NULL DEFAULT 'open',
    winner_player_id INTEGER,
    is_push INTEGER NOT NULL DEFAULT 0,
    proposed_by TEXT NOT NULL,
    use_custom_stakes INTEGER NOT NULL DEFAULT 0,
    min_bet REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY (player1_id) REFERENCES players(id),
    FOREIGN KEY (player2_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS pvp_bets (
    id TEXT PRIMARY KEY,
    matchup_id INTEGER NOT NULL,
    bettor_name TEXT NOT NULL,
    player_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (matchup_id) REFERENCES pvp_matchups(id),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );
`);

module.exports = db;
