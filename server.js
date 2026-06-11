const express = require('express');
const cors = require('cors');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Templates ────────────────────────────────────────────────────────────────
// A template seeds an event with a starter set of contestants + markets so the
// app is immediately usable. Everything seeded is fully editable afterwards.

const TEMPLATES = {
  racing: {
    label: 'Race Day',
    emoji: '🏁',
    accent: 'cyan',
    blurb: 'Dogs, horses, drones, anything with a finish line.',
    contestants: [
      { name: 'Rocket', emoji: '🐕', subtitle: 'Lane 1' },
      { name: 'Biscuit', emoji: '🐕', subtitle: 'Lane 2' },
      { name: 'Turbo', emoji: '🐕', subtitle: 'Lane 3' },
      { name: 'Noodle', emoji: '🐕', subtitle: 'Lane 4' },
      { name: 'Pickles', emoji: '🐕', subtitle: 'Lane 5' },
      { name: 'Zoom', emoji: '🐕', subtitle: 'Lane 6' },
    ],
    markets: [
      { name: 'Win', type: 'win', top_n: 1 },
      { name: 'Place (Top 2)', type: 'topn', top_n: 2 },
      { name: 'Show (Top 3)', type: 'topn', top_n: 3 },
    ],
  },
  tournament: {
    label: 'Tournament',
    emoji: '⛳',
    accent: 'emerald',
    blurb: 'Golf, poker, bracket play — crown a champion.',
    contestants: [
      { name: 'Player 1', emoji: '🏌️', subtitle: '' },
      { name: 'Player 2', emoji: '🏌️', subtitle: '' },
      { name: 'Player 3', emoji: '🏌️', subtitle: '' },
      { name: 'Player 4', emoji: '🏌️', subtitle: '' },
    ],
    markets: [
      { name: 'Overall Winner', type: 'win', top_n: 1 },
      { name: 'Podium (Top 3)', type: 'topn', top_n: 3 },
    ],
  },
  h2h: {
    label: 'Head-to-Head',
    emoji: '🥊',
    accent: 'rose',
    blurb: 'Two sides enter. Pick who comes out on top.',
    contestants: [
      { name: 'Side A', emoji: '🔴', subtitle: '' },
      { name: 'Side B', emoji: '🔵', subtitle: '' },
    ],
    markets: [
      { name: 'Winner', type: 'h2h', top_n: 1, all: true },
    ],
  },
  custom: {
    label: 'Custom',
    emoji: '✨',
    accent: 'violet',
    blurb: 'A blank canvas. Add your own contestants and pools.',
    contestants: [],
    markets: [],
  },
};

const ACCENTS = ['emerald', 'cyan', 'violet', 'rose', 'amber', 'blue'];

// ─── Admin auth ───────────────────────────────────────────────────────────────

function requireAdminPin(req, res, next) {
  const pin = process.env.ADMIN_PIN;
  if (!pin) return next();
  if (req.headers['x-admin-pin'] !== pin) return res.status(401).json({ error: 'Invalid admin PIN' });
  next();
}

app.use('/api/admin', requireAdminPin);

// ─── Data helpers ─────────────────────────────────────────────────────────────

function getActiveEvent() {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
}

function getContestants(eventId) {
  return db.prepare('SELECT * FROM contestants WHERE event_id = ? ORDER BY sort_order, id').all(eventId);
}

function getMarketContestantIds(marketId) {
  return db.prepare('SELECT contestant_id FROM market_contestants WHERE market_id = ?')
    .all(marketId).map(r => r.contestant_id);
}

// Returns the list of contestant ids eligible in a market. Empty restriction =
// every contestant in the event.
function eligibleContestantIds(market, eventContestantIds) {
  const restricted = getMarketContestantIds(market.id);
  return restricted.length ? restricted : eventContestantIds.slice();
}

// ─── Odds + pool math ─────────────────────────────────────────────────────────

function americanOdds(profitRatio) {
  if (!isFinite(profitRatio) || profitRatio <= 0) return null;
  return profitRatio >= 1 ? Math.round(profitRatio * 100) : -Math.round(100 / profitRatio);
}

// Builds a display-ready market: pool totals, per-contestant backing, live odds.
function enrichMarket(market, eventContestantIds, rakePct) {
  const bets = db.prepare('SELECT * FROM bets WHERE market_id = ?').all(market.id);
  const pool = bets.reduce((s, b) => s + b.amount, 0);
  const distributable = pool * (1 - rakePct / 100);

  const byContestant = {};
  for (const b of bets) byContestant[b.contestant_id] = (byContestant[b.contestant_id] || 0) + b.amount;

  const eligible = eligibleContestantIds(market, eventContestantIds);
  const lines = eligible.map(cid => {
    const backed = byContestant[cid] || 0;
    const share = pool > 0 ? backed / pool : 0;
    // For win / h2h we can quote true pari-mutuel odds: if this contestant wins,
    // its backers split the whole distributable pool. top-N payouts depend on the
    // other in-the-money finishers, so we quote pool share instead.
    let odds = null;
    if ((market.type === 'win' || market.type === 'h2h') && backed > 0 && pool > backed) {
      odds = americanOdds((distributable - backed) / backed);
    } else if ((market.type === 'win' || market.type === 'h2h') && backed > 0) {
      odds = -99999; // sole backer / nobody else in pool
    }
    return { contestant_id: cid, backed: round2(backed), share: Math.round(share * 100), odds };
  });

  const results = db.prepare('SELECT contestant_id, rank FROM market_results WHERE market_id = ? ORDER BY rank').all(market.id);
  const out = { ...market, pool: round2(pool), eligible, lines, bets, results };
  if (market.status === 'settled') out.payouts = settleMarket(market, bets, eventContestantIds, rakePct);
  return out;
}

// The core pari-mutuel engine. Winners split the distributable pool in
// proportion to their stake. Push or no-winner ⇒ full refunds.
function settleMarket(market, bets, eventContestantIds, rakePct) {
  if (!bets) bets = db.prepare('SELECT * FROM bets WHERE market_id = ?').all(market.id);
  const pool = bets.reduce((s, b) => s + b.amount, 0);
  const distributable = pool * (1 - rakePct / 100);

  if (market.is_push) {
    return bets.map(b => ({ bet: b, payout: 0, refund: round2(b.amount) }));
  }

  const ranked = db.prepare('SELECT contestant_id, rank FROM market_results WHERE market_id = ?').all(market.id);
  const cutoff = market.type === 'topn' ? market.top_n : 1;
  const winners = new Set(ranked.filter(r => r.rank <= cutoff).map(r => r.contestant_id));

  const winningBets = bets.filter(b => winners.has(b.contestant_id));
  const winnerTotal = winningBets.reduce((s, b) => s + b.amount, 0);

  // Nobody backed a winner ⇒ refund everyone (no house windfall in a friendly pool).
  if (winnerTotal === 0) {
    return bets.map(b => ({ bet: b, payout: 0, refund: round2(b.amount) }));
  }

  return bets.map(b => {
    if (winners.has(b.contestant_id)) {
      return { bet: b, payout: round2(distributable * (b.amount / winnerTotal)), refund: 0 };
    }
    return { bet: b, payout: 0, refund: 0 };
  });
}

function round2(n) { return Math.round(n * 100) / 100; }

// ─── Stats across settled events ──────────────────────────────────────────────

function computeBettorStats(filterName) {
  const events = db.prepare("SELECT * FROM events WHERE status = 'settled'").all();
  const map = {};
  const ensure = name => (map[name] || (map[name] = { name, wagered: 0, returned: 0, bets: 0, wins: 0 }));

  for (const ev of events) {
    const cids = getContestants(ev.id).map(c => c.id);
    const markets = db.prepare("SELECT * FROM markets WHERE event_id = ? AND status = 'settled'").all(ev.id);
    for (const m of markets) {
      for (const { bet, payout, refund } of settleMarket(m, null, cids, ev.rake_pct)) {
        const b = ensure(bet.bettor_name);
        b.wagered += bet.amount;
        b.bets++;
        const got = payout || refund;
        b.returned += got;
        if (got > bet.amount) b.wins++;
      }
    }
  }

  let rows = Object.values(map).map(b => ({
    name: b.name,
    wagered: round2(b.wagered),
    returned: round2(b.returned),
    net: round2(b.returned - b.wagered),
    bets: b.bets,
    winRate: b.bets ? Math.round((b.wins / b.bets) * 100) : 0,
  }));

  if (filterName) {
    const q = filterName.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(q));
  }
  return rows.sort((a, b) => b.net - a.net);
}

// ─── Public routes ────────────────────────────────────────────────────────────

// Full snapshot of the active event for the bettor app.
app.get('/api/event', (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.json({ event: null });

  const contestants = getContestants(ev.id);
  const cids = contestants.map(c => c.id);
  const marketRows = db.prepare('SELECT * FROM markets WHERE event_id = ? ORDER BY sort_order, id').all(ev.id);
  const markets = marketRows.map(m => enrichMarket(m, cids, ev.rake_pct));
  const poolTotal = markets.reduce((s, m) => s + m.pool, 0);

  res.json({ event: ev, contestants, markets, poolTotal: round2(poolTotal) });
});

app.get('/api/templates', (req, res) => {
  res.json(Object.entries(TEMPLATES).map(([id, t]) => ({
    id, label: t.label, emoji: t.emoji, accent: t.accent, blurb: t.blurb,
  })));
});

app.get('/api/stats', (req, res) => {
  res.json({ bettors: computeBettorStats(req.query.bettor || null) });
});

// Place a bet (public).
app.post('/api/bet', (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(404).json({ error: 'No active event' });
  if (ev.status !== 'open') return res.status(400).json({ error: 'Betting is not open' });

  const { market_id, bettor, contestant_id, amount } = req.body;
  if (!market_id || !bettor || !contestant_id || amount == null) {
    return res.status(400).json({ error: 'market_id, bettor, contestant_id, amount required' });
  }
  if (amount < ev.min_bet) return res.status(400).json({ error: `Minimum bet is ${ev.currency}${ev.min_bet}` });

  const market = db.prepare('SELECT * FROM markets WHERE id = ? AND event_id = ?').get(market_id, ev.id);
  if (!market) return res.status(404).json({ error: 'Market not found' });
  if (market.status !== 'open') return res.status(400).json({ error: 'This pool is closed' });

  const cids = getContestants(ev.id).map(c => c.id);
  const eligible = eligibleContestantIds(market, cids);
  if (!eligible.includes(Number(contestant_id))) {
    return res.status(400).json({ error: 'That pick is not in this pool' });
  }

  const id = randomUUID();
  db.prepare('INSERT INTO bets (id, market_id, bettor_name, contestant_id, amount) VALUES (?, ?, ?, ?, ?)')
    .run(id, market_id, String(bettor).trim(), contestant_id, amount);
  res.json({ id });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

app.get('/api/admin/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC').all());
});

// Create an event, optionally seeded from a template.
app.post('/api/admin/event', (req, res) => {
  const { name, venue = '', date = '', template = 'custom', currency = '$', rake_pct = 0, min_bet = 1 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const tpl = TEMPLATES[template] || TEMPLATES.custom;
  const emoji = req.body.emoji || tpl.emoji;
  const accent = req.body.accent || tpl.accent;

  const info = db.prepare(`INSERT INTO events (name, venue, date, emoji, accent, currency, rake_pct, min_bet, template, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'setup')`)
    .run(name, venue, date, emoji, accent, currency, rake_pct, min_bet, template);
  const eventId = info.lastInsertRowid;

  const insContestant = db.prepare('INSERT INTO contestants (event_id, name, emoji, subtitle, sort_order) VALUES (?, ?, ?, ?, ?)');
  const seededIds = [];
  tpl.contestants.forEach((c, i) => {
    const r = insContestant.run(eventId, c.name, c.emoji || '', c.subtitle || '', i);
    seededIds.push(r.lastInsertRowid);
  });

  const insMarket = db.prepare('INSERT INTO markets (event_id, name, type, top_n, sort_order, status) VALUES (?, ?, ?, ?, ?, \'open\')');
  const insMC = db.prepare('INSERT INTO market_contestants (market_id, contestant_id) VALUES (?, ?)');
  tpl.markets.forEach((m, i) => {
    const r = insMarket.run(eventId, m.name, m.type, m.top_n || 1, i);
    if (m.all) for (const cid of seededIds) insMC.run(r.lastInsertRowid, cid);
  });

  res.json({ id: eventId });
});

app.put('/api/admin/event', (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(404).json({ error: 'No event' });
  const f = req.body;
  db.prepare(`UPDATE events SET
      name = COALESCE(?, name), venue = COALESCE(?, venue), date = COALESCE(?, date),
      emoji = COALESCE(?, emoji), accent = COALESCE(?, accent), currency = COALESCE(?, currency),
      rake_pct = COALESCE(?, rake_pct), min_bet = COALESCE(?, min_bet)
    WHERE id = ?`)
    .run(f.name ?? null, f.venue ?? null, f.date ?? null, f.emoji ?? null,
      f.accent ?? null, f.currency ?? null, f.rake_pct ?? null, f.min_bet ?? null, ev.id);
  res.json({ ok: true });
});

app.post('/api/admin/event/status', (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(404).json({ error: 'No event' });
  const { status } = req.body;
  if (!['setup', 'open', 'closed', 'settled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, ev.id);
  res.json({ ok: true });
});

app.post('/api/admin/event/reset', (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(404).json({ error: 'No event' });
  const markets = db.prepare('SELECT id FROM markets WHERE event_id = ?').all(ev.id).map(m => m.id);
  for (const mid of markets) {
    db.prepare('DELETE FROM bets WHERE market_id = ?').run(mid);
    db.prepare('DELETE FROM market_results WHERE market_id = ?').run(mid);
  }
  db.prepare("UPDATE markets SET status = 'open', is_push = 0 WHERE event_id = ?").run(ev.id);
  db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(ev.id);
  res.json({ ok: true });
});

app.delete('/api/admin/event/:id', (req, res) => {
  const id = req.params.id;
  const markets = db.prepare('SELECT id FROM markets WHERE event_id = ?').all(id).map(m => m.id);
  for (const mid of markets) {
    db.prepare('DELETE FROM bets WHERE market_id = ?').run(mid);
    db.prepare('DELETE FROM market_results WHERE market_id = ?').run(mid);
    db.prepare('DELETE FROM market_contestants WHERE market_id = ?').run(mid);
  }
  db.prepare('DELETE FROM markets WHERE event_id = ?').run(id);
  db.prepare('DELETE FROM contestants WHERE event_id = ?').run(id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── Contestants ──
app.post('/api/admin/contestant', (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(404).json({ error: 'No event' });
  const { name, emoji = '', subtitle = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const max = db.prepare('SELECT MAX(sort_order) AS m FROM contestants WHERE event_id = ?').get(ev.id).m || 0;
  const r = db.prepare('INSERT INTO contestants (event_id, name, emoji, subtitle, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(ev.id, name, emoji, subtitle, max + 1);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/admin/contestant/:id', (req, res) => {
  const { name, emoji, subtitle, sort_order } = req.body;
  db.prepare(`UPDATE contestants SET name = COALESCE(?, name), emoji = COALESCE(?, emoji),
      subtitle = COALESCE(?, subtitle), sort_order = COALESCE(?, sort_order) WHERE id = ?`)
    .run(name ?? null, emoji ?? null, subtitle ?? null, sort_order ?? null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/contestant/:id', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM bets WHERE contestant_id = ?').run(id);
  db.prepare('DELETE FROM market_contestants WHERE contestant_id = ?').run(id);
  db.prepare('DELETE FROM market_results WHERE contestant_id = ?').run(id);
  db.prepare('DELETE FROM contestants WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── Markets ──
app.post('/api/admin/market', (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(404).json({ error: 'No event' });
  const { name, type = 'win', top_n = 1, contestant_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!['win', 'topn', 'h2h'].includes(type)) return res.status(400).json({ error: 'Invalid market type' });
  const max = db.prepare('SELECT MAX(sort_order) AS m FROM markets WHERE event_id = ?').get(ev.id).m || 0;
  const r = db.prepare('INSERT INTO markets (event_id, name, type, top_n, sort_order, status) VALUES (?, ?, ?, ?, ?, \'open\')')
    .run(ev.id, name, type, top_n, max + 1);
  const mid = r.lastInsertRowid;
  if (Array.isArray(contestant_ids) && contestant_ids.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO market_contestants (market_id, contestant_id) VALUES (?, ?)');
    for (const cid of contestant_ids) ins.run(mid, cid);
  }
  res.json({ id: mid });
});

app.put('/api/admin/market/:id', (req, res) => {
  const { name, type, top_n, contestant_ids } = req.body;
  db.prepare('UPDATE markets SET name = COALESCE(?, name), type = COALESCE(?, type), top_n = COALESCE(?, top_n) WHERE id = ?')
    .run(name ?? null, type ?? null, top_n ?? null, req.params.id);
  if (Array.isArray(contestant_ids)) {
    db.prepare('DELETE FROM market_contestants WHERE market_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT OR IGNORE INTO market_contestants (market_id, contestant_id) VALUES (?, ?)');
    for (const cid of contestant_ids) ins.run(req.params.id, cid);
  }
  res.json({ ok: true });
});

app.post('/api/admin/market/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be open or closed' });
  db.prepare('UPDATE markets SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// Settle a market with a finishing order. ranks: [{ contestant_id, rank }].
app.post('/api/admin/market/:id/result', (req, res) => {
  const mid = req.params.id;
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(mid);
  if (!market) return res.status(404).json({ error: 'Market not found' });
  const { ranks, is_push } = req.body;

  db.prepare('DELETE FROM market_results WHERE market_id = ?').run(mid);
  if (!is_push && Array.isArray(ranks)) {
    const ins = db.prepare('INSERT OR REPLACE INTO market_results (market_id, contestant_id, rank) VALUES (?, ?, ?)');
    for (const r of ranks) {
      if (r.contestant_id != null && r.rank != null) ins.run(mid, r.contestant_id, r.rank);
    }
  }
  db.prepare("UPDATE markets SET status = 'settled', is_push = ? WHERE id = ?").run(is_push ? 1 : 0, mid);
  res.json({ ok: true });
});

app.post('/api/admin/market/:id/reopen', (req, res) => {
  const mid = req.params.id;
  db.prepare('DELETE FROM market_results WHERE market_id = ?').run(mid);
  db.prepare("UPDATE markets SET status = 'open', is_push = 0 WHERE id = ?").run(mid);
  res.json({ ok: true });
});

app.delete('/api/admin/market/:id', (req, res) => {
  const mid = req.params.id;
  db.prepare('DELETE FROM bets WHERE market_id = ?').run(mid);
  db.prepare('DELETE FROM market_results WHERE market_id = ?').run(mid);
  db.prepare('DELETE FROM market_contestants WHERE market_id = ?').run(mid);
  db.prepare('DELETE FROM markets WHERE id = ?').run(mid);
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SideBet listening on port ${PORT}`));
