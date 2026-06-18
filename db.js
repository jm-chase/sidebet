const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'sidebet.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- An Event is anything people bet on: a race, a tournament, a cook-off.
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    venue        TEXT    NOT NULL DEFAULT '',
    date         TEXT    NOT NULL DEFAULT '',
    emoji        TEXT    NOT NULL DEFAULT '🎲',
    accent       TEXT    NOT NULL DEFAULT 'emerald',
    currency     TEXT    NOT NULL DEFAULT '$',
    rake_pct     REAL    NOT NULL DEFAULT 0,
    min_bet      REAL    NOT NULL DEFAULT 1,
    template     TEXT    NOT NULL DEFAULT 'custom',
    status       TEXT    NOT NULL DEFAULT 'setup',  -- setup | open | closed | settled
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Contestants are the things you back: dogs, golfers, chili entries, teams.
  CREATE TABLE IF NOT EXISTS contestants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    emoji        TEXT    NOT NULL DEFAULT '',
    subtitle     TEXT    NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  -- A Market is a single pari-mutuel pool with an outcome.
  -- type: 'win' (1 winner), 'topn' (top N share), 'h2h' (head-to-head subset)
  CREATE TABLE IF NOT EXISTS markets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL DEFAULT 'win',
    top_n        INTEGER NOT NULL DEFAULT 1,
    status       TEXT    NOT NULL DEFAULT 'open',   -- open | closed | settled
    is_push      INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  -- Restricts which contestants are eligible in a market (e.g. a single race,
  -- or the two sides of a head-to-head). If a market has no rows here, every
  -- contestant in the event is eligible.
  CREATE TABLE IF NOT EXISTS market_contestants (
    market_id     INTEGER NOT NULL,
    contestant_id INTEGER NOT NULL,
    UNIQUE(market_id, contestant_id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    FOREIGN KEY (contestant_id) REFERENCES contestants(id)
  );

  -- The finishing order for a settled market. rank 1 = winner.
  CREATE TABLE IF NOT EXISTS market_results (
    market_id     INTEGER NOT NULL,
    contestant_id INTEGER NOT NULL,
    rank          INTEGER NOT NULL,
    UNIQUE(market_id, contestant_id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    FOREIGN KEY (contestant_id) REFERENCES contestants(id)
  );

  CREATE TABLE IF NOT EXISTS bets (
    id            TEXT PRIMARY KEY,
    market_id     INTEGER NOT NULL,
    bettor_name   TEXT NOT NULL,
    contestant_id INTEGER NOT NULL,
    amount        REAL NOT NULL,
    odds          REAL,                     -- locked fair decimal odds (line markets); NULL for pool markets
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    FOREIGN KEY (contestant_id) REFERENCES contestants(id)
  );

  -- Fair (de-vigged) fixed odds per contestant for a line-priced market.
  CREATE TABLE IF NOT EXISTS market_lines (
    market_id     INTEGER NOT NULL,
    contestant_id INTEGER NOT NULL,
    decimal_odds  REAL NOT NULL,
    UNIQUE(market_id, contestant_id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    FOREIGN KEY (contestant_id) REFERENCES contestants(id)
  );

  CREATE INDEX IF NOT EXISTS idx_contestants_event ON contestants(event_id);
  CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
  CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
`);

// Migrations for databases created before line-pricing existed.
function ensureColumn(table, col, ddl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('markets', 'pricing', "pricing TEXT NOT NULL DEFAULT 'pool'"); // 'pool' | 'line'
ensureColumn('bets', 'odds', 'odds REAL');

module.exports = db;
