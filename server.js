const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

function getActiveTournament() {
  return db.prepare('SELECT * FROM tournaments ORDER BY id DESC LIMIT 1').get();
}

function getTournamentPlayers(tournamentId) {
  return db.prepare('SELECT * FROM players WHERE tournament_id = ?').all(tournamentId);
}

function computeEffectiveHandicap(courseHandicap, hcpAllowance) {
  return Math.round(courseHandicap * hcpAllowance / 100);
}

function computeMainOdds(tournamentId) {
  const bets = db.prepare('SELECT * FROM bets WHERE tournament_id = ?').all(tournamentId);
  let winPool = 0, showPool = 0;
  const winByPlayer = {}, showByPlayer = {};

  for (const b of bets) {
    if (b.type === 'win') {
      winPool += b.amount;
      winByPlayer[b.player_id] = (winByPlayer[b.player_id] || 0) + b.amount;
    } else if (b.type === 'show') {
      showPool += b.amount;
      showByPlayer[b.player_id] = (showByPlayer[b.player_id] || 0) + b.amount;
    }
  }

  const players = getTournamentPlayers(tournamentId);
  const oddsMap = {};
  for (const p of players) {
    const winAmt = winByPlayer[p.id] || 0;
    const showAmt = showByPlayer[p.id] || 0;
    let winOdds = null, showOdds = null;
    if (winAmt > 0 && winPool > winAmt) {
      const profit = (winPool - winAmt) / winAmt;
      winOdds = profit >= 1 ? Math.round(profit * 100) : -Math.round(100 / profit);
    } else if (winAmt > 0) {
      winOdds = -99999;
    }
    if (showAmt > 0 && showPool > showAmt) {
      const profit = (showPool - showAmt) / showAmt;
      showOdds = profit >= 1 ? Math.round(profit * 100) : -Math.round(100 / profit);
    } else if (showAmt > 0) {
      showOdds = -99999;
    }
    oddsMap[p.id] = { winOdds, showOdds, winAmount: winAmt, showAmount: showAmt };
  }

  return { winPool, showPool, oddsMap, bets };
}

function computeMainPayouts(tournamentId) {
  const results = db.prepare('SELECT * FROM tournament_results WHERE tournament_id = ?').get(tournamentId);
  if (!results) return [];

  const { winPool, showPool, bets } = computeMainOdds(tournamentId);
  const { first_player_id, second_player_id, third_player_id } = results;

  const showIds = new Set([first_player_id, second_player_id, third_player_id].filter(Boolean));

  // Win pool: only first place wins
  const winningBets = bets.filter(b => b.type === 'win' && b.player_id === first_player_id);
  const winningTotal = winningBets.reduce((s, b) => s + b.amount, 0);
  const losingWinBets = bets.filter(b => b.type === 'win' && b.player_id !== first_player_id);
  const losingWinPool = losingWinBets.reduce((s, b) => s + b.amount, 0);

  // Show pool: top 3 share proportionally among bettors of top-3 players
  const showWinningBets = bets.filter(b => b.type === 'show' && showIds.has(b.player_id));
  const showLosingBets = bets.filter(b => b.type === 'show' && !showIds.has(b.player_id));
  const showWinTotal = showWinningBets.reduce((s, b) => s + b.amount, 0);
  const showLosePool = showLosingBets.reduce((s, b) => s + b.amount, 0);

  const payouts = [];

  for (const bet of bets) {
    let payout = 0;
    let refund = 0;

    if (bet.type === 'win') {
      if (bet.player_id === first_player_id && winningTotal > 0) {
        payout = bet.amount + (bet.amount / winningTotal) * losingWinPool;
      } else if (first_player_id == null) {
        refund = bet.amount;
      }
    } else if (bet.type === 'show') {
      if (showIds.has(bet.player_id) && showWinTotal > 0) {
        payout = bet.amount + (bet.amount / showWinTotal) * showLosePool;
      } else if (showIds.size === 0) {
        refund = bet.amount;
      }
    }

    payouts.push({ bet, payout: Math.round(payout * 100) / 100, refund: Math.round(refund * 100) / 100 });
  }

  return payouts;
}

function computeStandings(tournamentId) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!t) return [];
  const players = getTournamentPlayers(tournamentId);
  const scores = db.prepare('SELECT * FROM scores WHERE tournament_id = ?').all(tournamentId);

  const scoreMap = {};
  for (const s of scores) {
    if (!scoreMap[s.player_id]) scoreMap[s.player_id] = {};
    scoreMap[s.player_id][s.round] = s.gross_score;
  }

  const standings = players.map(p => {
    const effHcp = computeEffectiveHandicap(p.course_handicap, t.hcp_allowance);
    const roundNets = [];
    let totalNet = null;
    let hasScores = false;

    for (let r = 1; r <= t.rounds; r++) {
      const gross = scoreMap[p.id] && scoreMap[p.id][r];
      if (gross != null) {
        hasScores = true;
        const net = gross - effHcp;
        roundNets.push({ round: r, gross, net });
        totalNet = (totalNet || 0) + net;
      } else {
        roundNets.push({ round: r, gross: null, net: null });
      }
    }

    return { player: p, effHcp, roundNets, totalNet, hasScores };
  });

  // Sort: players with scores first (ascending net), then no scores
  const withScores = standings.filter(s => s.hasScores).sort((a, b) => a.totalNet - b.totalNet);
  const noScores = standings.filter(s => !s.hasScores);

  // Assign positions with ties
  let pos = 1;
  for (let i = 0; i < withScores.length; i++) {
    if (i > 0 && withScores[i].totalNet !== withScores[i - 1].totalNet) {
      pos = i + 1;
    }
    withScores[i].position = pos;
  }

  return [...withScores, ...noScores.map(s => ({ ...s, position: null }))];
}

function computeHolePayouts(tournamentId, round, hole) {
  const hs = db.prepare('SELECT * FROM hole_status WHERE tournament_id = ? AND round = ? AND hole = ?').get(tournamentId, round, hole);
  if (!hs || hs.status !== 'final') return [];

  const holeBets = db.prepare('SELECT * FROM hole_bets WHERE tournament_id = ? AND round = ? AND hole = ?').all(tournamentId, round, hole);
  const totalPool = holeBets.reduce((s, b) => s + b.amount, 0);

  if (hs.is_push) {
    return holeBets.map(b => ({ bet: b, payout: 0, refund: b.amount }));
  }

  const winnerId = hs.winner_player_id;
  const winnerBets = holeBets.filter(b => b.player_id === winnerId);
  const winnerTotal = winnerBets.reduce((s, b) => s + b.amount, 0);

  return holeBets.map(b => {
    if (b.player_id === winnerId && winnerTotal > 0) {
      const payout = b.amount + (b.amount / winnerTotal) * (totalPool - winnerTotal);
      return { bet: b, payout: Math.round(payout * 100) / 100, refund: 0 };
    }
    return { bet: b, payout: 0, refund: 0 };
  });
}

function computePvpPayouts(matchupId) {
  const matchup = db.prepare('SELECT * FROM pvp_matchups WHERE id = ?').get(matchupId);
  if (!matchup || matchup.status !== 'final') return [];

  const pvpBets = db.prepare('SELECT * FROM pvp_bets WHERE matchup_id = ?').all(matchupId);

  if (matchup.is_push) {
    return pvpBets.map(b => ({ bet: b, payout: 0, refund: b.amount }));
  }

  const winnerId = matchup.winner_player_id;
  const winnerBets = pvpBets.filter(b => b.player_id === winnerId);
  const loserBets = pvpBets.filter(b => b.player_id !== winnerId);
  const winnerTotal = winnerBets.reduce((s, b) => s + b.amount, 0);
  const loserTotal = loserBets.reduce((s, b) => s + b.amount, 0);

  return pvpBets.map(b => {
    if (b.player_id === winnerId && winnerTotal > 0) {
      const payout = b.amount + (b.amount / winnerTotal) * loserTotal;
      return { bet: b, payout: Math.round(payout * 100) / 100, refund: 0 };
    }
    return { bet: b, payout: 0, refund: 0 };
  });
}

function computeBettorStats(filterName) {
  const tournaments = db.prepare("SELECT * FROM tournaments WHERE status = 'final'").all();
  const bettorMap = {};

  function ensureBettor(name) {
    if (!bettorMap[name]) {
      bettorMap[name] = { name, wagered: 0, payout: 0, betsPlaced: 0, wins: 0 };
    }
    return bettorMap[name];
  }

  for (const t of tournaments) {
    // Main bets
    const mainPayouts = computeMainPayouts(t.id);
    for (const { bet, payout, refund } of mainPayouts) {
      const btr = ensureBettor(bet.bettor_name);
      btr.wagered += bet.amount;
      btr.betsPlaced++;
      const received = payout || refund;
      btr.payout += received;
      if (received > bet.amount) btr.wins++;
    }

    // Hole bets
    const holeStatuses = db.prepare("SELECT * FROM hole_status WHERE tournament_id = ? AND status = 'final'").all(t.id);
    for (const hs of holeStatuses) {
      const payouts = computeHolePayouts(t.id, hs.round, hs.hole);
      for (const { bet, payout, refund } of payouts) {
        const btr = ensureBettor(bet.bettor_name);
        btr.wagered += bet.amount;
        btr.betsPlaced++;
        const received = payout || refund;
        btr.payout += received;
        if (received > bet.amount) btr.wins++;
      }
    }

    // PvP bets
    const matchups = db.prepare("SELECT * FROM pvp_matchups WHERE tournament_id = ? AND status = 'final'").all(t.id);
    for (const m of matchups) {
      const payouts = computePvpPayouts(m.id);
      for (const { bet, payout, refund } of payouts) {
        const btr = ensureBettor(bet.bettor_name);
        btr.wagered += bet.amount;
        btr.betsPlaced++;
        const received = payout || refund;
        btr.payout += received;
        if (received > bet.amount) btr.wins++;
      }
    }
  }

  let result = Object.values(bettorMap).map(b => ({
    name: b.name,
    wagered: Math.round(b.wagered * 100) / 100,
    payout: Math.round(b.payout * 100) / 100,
    net: Math.round((b.payout - b.wagered) * 100) / 100,
    betsPlaced: b.betsPlaced,
    wins: b.wins,
    winRate: b.betsPlaced > 0 ? Math.round((b.wins / b.betsPlaced) * 100) : 0
  }));

  if (filterName) {
    const lower = filterName.toLowerCase();
    result = result.filter(b => b.name.toLowerCase().includes(lower));
  }

  return result.sort((a, b) => b.net - a.net);
}

function computePlayerStats() {
  const tournaments = db.prepare("SELECT * FROM tournaments WHERE status = 'final'").all();
  const playerMap = {};

  function ensurePlayer(id, name) {
    if (!playerMap[id]) playerMap[id] = { id, name, tournaments: 0, wins: 0, top3: 0, netScores: [], totalBacking: 0 };
    return playerMap[id];
  }

  for (const t of tournaments) {
    const standings = computeStandings(t.id);
    const results = db.prepare('SELECT * FROM tournament_results WHERE tournament_id = ?').get(t.id);

    for (const s of standings) {
      if (!s.hasScores) continue;
      const p = ensurePlayer(s.player.id, s.player.name);
      p.tournaments++;
      if (s.totalNet != null) p.netScores.push(s.totalNet);
      if (results) {
        if (results.first_player_id === s.player.id) p.wins++;
        if ([results.first_player_id, results.second_player_id, results.third_player_id].includes(s.player.id)) p.top3++;
      }
    }

    // Backing
    const bets = db.prepare('SELECT * FROM bets WHERE tournament_id = ?').all(t.id);
    for (const b of bets) {
      if (playerMap[b.player_id]) playerMap[b.player_id].totalBacking += b.amount;
    }
  }

  return Object.values(playerMap).map(p => ({
    id: p.id,
    name: p.name,
    tournaments: p.tournaments,
    wins: p.wins,
    top3: p.top3,
    avgNet: p.netScores.length > 0 ? Math.round((p.netScores.reduce((s, n) => s + n, 0) / p.netScores.length) * 10) / 10 : null,
    totalBacking: Math.round(p.totalBacking * 100) / 100
  })).sort((a, b) => b.wins - a.wins || b.top3 - a.top3);
}

function enrichHoles(tournamentId) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!tournament) return [];

  const allHoleStatuses = db.prepare('SELECT * FROM hole_status WHERE tournament_id = ?').all(tournamentId);
  const holeBets = db.prepare('SELECT * FROM hole_bets WHERE tournament_id = ?').all(tournamentId);
  const players = getTournamentPlayers(tournamentId);
  const playerMap = {};
  for (const p of players) playerMap[p.id] = p;

  const result = [];
  for (let round = 1; round <= tournament.rounds; round++) {
    for (let hole = 1; hole <= 18; hole++) {
      const hs = allHoleStatuses.find(h => h.round === round && h.hole === hole) || { round, hole, status: 'locked', winner_player_id: null, is_push: 0 };
      const betsForHole = holeBets.filter(b => b.round === round && b.hole === hole);
      const pool = betsForHole.reduce((s, b) => s + b.amount, 0);
      const playerPools = {};
      for (const b of betsForHole) {
        playerPools[b.player_id] = (playerPools[b.player_id] || 0) + b.amount;
      }
      const entry = { ...hs, pool, playerPools, bets: betsForHole };
      if (hs.status === 'final') {
        entry.payouts = computeHolePayouts(tournamentId, round, hole);
        entry.winnerName = hs.is_push ? 'PUSH' : (playerMap[hs.winner_player_id] ? playerMap[hs.winner_player_id].name : null);
      }
      result.push(entry);
    }
  }
  return result;
}

function enrichMatchups(tournamentId) {
  const matchups = db.prepare('SELECT * FROM pvp_matchups WHERE tournament_id = ?').all(tournamentId);
  const players = getTournamentPlayers(tournamentId);
  const playerMap = {};
  for (const p of players) playerMap[p.id] = p;

  return matchups.map(m => {
    const bets = db.prepare('SELECT * FROM pvp_bets WHERE matchup_id = ?').all(m.id);
    const p1Pool = bets.filter(b => b.player_id === m.player1_id).reduce((s, b) => s + b.amount, 0);
    const p2Pool = bets.filter(b => b.player_id === m.player2_id).reduce((s, b) => s + b.amount, 0);
    const totalPool = p1Pool + p2Pool;
    const entry = { ...m, bets, p1Pool, p2Pool, totalPool, player1: playerMap[m.player1_id], player2: playerMap[m.player2_id] };
    if (m.status === 'final') {
      entry.payouts = computePvpPayouts(m.id);
      entry.winnerName = m.is_push ? 'PUSH' : (playerMap[m.winner_player_id] ? playerMap[m.winner_player_id].name : null);
    }
    return entry;
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/state
app.get('/api/state', (req, res) => {
  const tournament = getActiveTournament();
  if (!tournament) return res.json({ tournament: null });

  const players = getTournamentPlayers(tournament.id);
  const { winPool, showPool, oddsMap, bets } = computeMainOdds(tournament.id);
  const results = db.prepare('SELECT * FROM tournament_results WHERE tournament_id = ?').get(tournament.id);
  const mainPayouts = tournament.status === 'final' ? computeMainPayouts(tournament.id) : [];
  const standings = computeStandings(tournament.id);
  const holes = enrichHoles(tournament.id);
  const matchups = enrichMatchups(tournament.id);

  res.json({ tournament, players, bets, winPool, showPool, oddsMap, results, mainPayouts, standings, holes, matchups });
});

// GET /api/admin/tournaments
app.get('/api/admin/tournaments', (req, res) => {
  const tournaments = db.prepare('SELECT * FROM tournaments ORDER BY id DESC').all();
  res.json(tournaments);
});

// POST /api/admin/tournament
app.post('/api/admin/tournament', (req, res) => {
  const { name, course, date, rounds = 2, hcp_allowance = 100 } = req.body;
  if (!name || !course || !date) return res.status(400).json({ error: 'name, course, date required' });
  const info = db.prepare('INSERT INTO tournaments (name, course, date, rounds, hcp_allowance) VALUES (?, ?, ?, ?, ?)').run(name, course, date, rounds, hcp_allowance);
  res.json({ id: info.lastInsertRowid });
});

// PUT /api/admin/tournament
app.put('/api/admin/tournament', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { name, course, date, rounds, hcp_allowance } = req.body;
  db.prepare('UPDATE tournaments SET name=COALESCE(?,name), course=COALESCE(?,course), date=COALESCE(?,date), rounds=COALESCE(?,rounds), hcp_allowance=COALESCE(?,hcp_allowance) WHERE id=?')
    .run(name || null, course || null, date || null, rounds || null, hcp_allowance || null, t.id);
  res.json({ ok: true });
});

// POST /api/admin/status
app.post('/api/admin/status', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { status } = req.body;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be open or closed' });
  db.prepare('UPDATE tournaments SET status=? WHERE id=?').run(status, t.id);
  res.json({ ok: true });
});

// POST /api/admin/players
app.post('/api/admin/players', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { name, handicap_index = 0, course_handicap = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO players (tournament_id, name, handicap_index, course_handicap) VALUES (?, ?, ?, ?)').run(t.id, name, handicap_index, course_handicap);
  res.json({ id: info.lastInsertRowid });
});

// PUT /api/admin/players/:id
app.put('/api/admin/players/:id', (req, res) => {
  const { name, handicap_index, course_handicap } = req.body;
  db.prepare('UPDATE players SET name=COALESCE(?,name), handicap_index=COALESCE(?,handicap_index), course_handicap=COALESCE(?,course_handicap) WHERE id=?')
    .run(name || null, handicap_index != null ? handicap_index : null, course_handicap != null ? course_handicap : null, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/admin/players/:id
app.delete('/api/admin/players/:id', (req, res) => {
  db.prepare('DELETE FROM players WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/bet
app.post('/api/bet', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  if (t.status !== 'open') return res.status(400).json({ error: 'Betting is not open' });
  const { bettor, player_id, type, amount } = req.body;
  if (!bettor || !player_id || !type || !amount) return res.status(400).json({ error: 'bettor, player_id, type, amount required' });
  if (!['win', 'show'].includes(type)) return res.status(400).json({ error: 'type must be win or show' });
  if (amount < 1) return res.status(400).json({ error: 'minimum bet is $1' });
  const id = randomUUID();
  db.prepare('INSERT INTO bets (id, tournament_id, bettor_name, player_id, type, amount) VALUES (?, ?, ?, ?, ?, ?)').run(id, t.id, bettor, player_id, type, amount);
  res.json({ id });
});

// POST /api/admin/scores
app.post('/api/admin/scores', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { round, scores } = req.body;
  if (!round || !scores) return res.status(400).json({ error: 'round and scores required' });
  const upsert = db.prepare('INSERT INTO scores (tournament_id, player_id, round, gross_score) VALUES (?, ?, ?, ?) ON CONFLICT(tournament_id, player_id, round) DO UPDATE SET gross_score=excluded.gross_score');
  for (const [player_id, gross_score] of Object.entries(scores)) {
    if (gross_score != null && gross_score !== '') {
      upsert.run(t.id, player_id, round, gross_score);
    }
  }
  res.json({ ok: true });
});

// POST /api/admin/scores/clear
app.post('/api/admin/scores/clear', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { round } = req.body;
  if (!round) return res.status(400).json({ error: 'round required' });
  db.prepare('DELETE FROM scores WHERE tournament_id=? AND round=?').run(t.id, round);
  res.json({ ok: true });
});

// POST /api/results
app.post('/api/results', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { first, second, third } = req.body;
  db.prepare('INSERT INTO tournament_results (tournament_id, first_player_id, second_player_id, third_player_id) VALUES (?, ?, ?, ?) ON CONFLICT(tournament_id) DO UPDATE SET first_player_id=excluded.first_player_id, second_player_id=excluded.second_player_id, third_player_id=excluded.third_player_id')
    .run(t.id, first || null, second || null, third || null);
  db.prepare("UPDATE tournaments SET status='final' WHERE id=?").run(t.id);
  res.json({ ok: true });
});

// POST /api/admin/holes/unlock
app.post('/api/admin/holes/unlock', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { round, hole } = req.body;
  db.prepare("INSERT INTO hole_status (tournament_id, round, hole, status) VALUES (?, ?, ?, 'open') ON CONFLICT(tournament_id, round, hole) DO UPDATE SET status='open', winner_player_id=NULL, is_push=0").run(t.id, round, hole);
  res.json({ ok: true });
});

// POST /api/admin/holes/lock
app.post('/api/admin/holes/lock', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { round, hole } = req.body;
  db.prepare("INSERT INTO hole_status (tournament_id, round, hole, status) VALUES (?, ?, ?, 'locked') ON CONFLICT(tournament_id, round, hole) DO UPDATE SET status='locked'").run(t.id, round, hole);
  res.json({ ok: true });
});

// POST /api/admin/holes/result
app.post('/api/admin/holes/result', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { round, hole, winner_player_id, is_push } = req.body;
  db.prepare("INSERT INTO hole_status (tournament_id, round, hole, status, winner_player_id, is_push) VALUES (?, ?, ?, 'final', ?, ?) ON CONFLICT(tournament_id, round, hole) DO UPDATE SET status='final', winner_player_id=excluded.winner_player_id, is_push=excluded.is_push")
    .run(t.id, round, hole, is_push ? null : winner_player_id, is_push ? 1 : 0);
  res.json({ ok: true });
});

// POST /api/hole-bet
app.post('/api/hole-bet', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { bettor, player_id, round, hole, amount } = req.body;
  if (!bettor || !player_id || !round || !hole || !amount) return res.status(400).json({ error: 'bettor, player_id, round, hole, amount required' });
  if (amount < 1) return res.status(400).json({ error: 'minimum bet is $1' });
  const hs = db.prepare('SELECT * FROM hole_status WHERE tournament_id=? AND round=? AND hole=?').get(t.id, round, hole);
  if (!hs || hs.status !== 'open') return res.status(400).json({ error: 'Hole is not open for betting' });
  const id = randomUUID();
  db.prepare('INSERT INTO hole_bets (id, tournament_id, round, hole, bettor_name, player_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, t.id, round, hole, bettor, player_id, amount);
  res.json({ id });
});

// POST /api/pvp/propose
app.post('/api/pvp/propose', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  const { proposed_by, player1_id, player2_id, scoring_type = 'net', use_custom_stakes = 0, min_bet = 1 } = req.body;
  if (!proposed_by || !player1_id || !player2_id) return res.status(400).json({ error: 'proposed_by, player1_id, player2_id required' });
  if (String(player1_id) === String(player2_id)) return res.status(400).json({ error: 'players must be different' });
  const info = db.prepare('INSERT INTO pvp_matchups (tournament_id, player1_id, player2_id, scoring_type, proposed_by, use_custom_stakes, min_bet) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t.id, player1_id, player2_id, scoring_type, proposed_by, use_custom_stakes ? 1 : 0, min_bet);
  res.json({ id: info.lastInsertRowid });
});

// POST /api/pvp/:id/bet
app.post('/api/pvp/:id/bet', (req, res) => {
  const matchup = db.prepare('SELECT * FROM pvp_matchups WHERE id=?').get(req.params.id);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found' });
  if (matchup.status !== 'open') return res.status(400).json({ error: 'Matchup is not open for betting' });
  const { bettor, player_id, amount } = req.body;
  if (!bettor || !player_id || !amount) return res.status(400).json({ error: 'bettor, player_id, amount required' });
  if (String(player_id) !== String(matchup.player1_id) && String(player_id) !== String(matchup.player2_id)) return res.status(400).json({ error: 'player_id must be one of the matchup players' });
  const minBet = matchup.use_custom_stakes ? matchup.min_bet : 1;
  if (amount < minBet) return res.status(400).json({ error: `minimum bet is $${minBet}` });
  const id = randomUUID();
  db.prepare('INSERT INTO pvp_bets (id, matchup_id, bettor_name, player_id, amount) VALUES (?, ?, ?, ?, ?)').run(id, matchup.id, bettor, player_id, amount);
  res.json({ id });
});

// POST /api/admin/pvp/:id/close
app.post('/api/admin/pvp/:id/close', (req, res) => {
  db.prepare("UPDATE pvp_matchups SET status='closed' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/pvp/:id/result
app.post('/api/admin/pvp/:id/result', (req, res) => {
  const { winner_player_id, is_push } = req.body;
  db.prepare("UPDATE pvp_matchups SET status='final', winner_player_id=?, is_push=? WHERE id=?")
    .run(is_push ? null : winner_player_id, is_push ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const { bettor } = req.query;
  const bettors = computeBettorStats(bettor || null);
  const players = computePlayerStats();
  res.json({ bettors, players });
});

// POST /api/admin/reset
app.post('/api/admin/reset', (req, res) => {
  const t = getActiveTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  db.prepare('DELETE FROM bets WHERE tournament_id=?').run(t.id);
  db.prepare('DELETE FROM hole_bets WHERE tournament_id=?').run(t.id);
  const matchupIds = db.prepare('SELECT id FROM pvp_matchups WHERE tournament_id=?').all(t.id).map(m => m.id);
  for (const mid of matchupIds) db.prepare('DELETE FROM pvp_bets WHERE matchup_id=?').run(mid);
  db.prepare('DELETE FROM pvp_matchups WHERE tournament_id=?').run(t.id);
  db.prepare('DELETE FROM hole_status WHERE tournament_id=?').run(t.id);
  db.prepare('DELETE FROM tournament_results WHERE tournament_id=?').run(t.id);
  db.prepare('DELETE FROM scores WHERE tournament_id=?').run(t.id);
  db.prepare("UPDATE tournaments SET status='open' WHERE id=?").run(t.id);
  res.json({ ok: true });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Golf betting app listening on port ${PORT}`));
