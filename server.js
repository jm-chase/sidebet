const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// ENTRANT CONFIG — edit names and handicaps here
// ============================================================
const ENTRANTS = [
  { name: "James Chase",       handicap: 11 },
  { name: "Dustin Hatcher",    handicap: 9  },
  { name: "Stephen Culpepper", handicap: 11 },
  { name: "Braxton Smith",     handicap: 11 },
  { name: "Fleet Jernigan",    handicap: 13 },
  { name: "Jack Konstanzer",   handicap: 11 },
  { name: "Max Konstanzer",    handicap: 16 },
  { name: "Carter Baum",       handicap: 17 },
  { name: "Tommy Taylor",      handicap: 23 },
  { name: "Aaron Stroker",     handicap: 16 },
  { name: "Thomas Nader",      handicap: 17 },
  { name: "Nick Graham",       handicap: 19 },
];
// ============================================================

// --- Storage (JSON file) ---
const DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

function loadState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { bets: [], results: null, status: 'open', scores: { r1: {}, r2: {} } };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // backfill scores field if missing (older state files)
  if (!state.scores) state.scores = { r1: {}, r2: {} };
  return state;
}

function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: write to temp file then rename to avoid corruption
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// --- Pari-mutuel logic ---
function computeOdds(bets) {
  const winPool  = bets.filter(b => b.type === 'win').reduce((s, b) => s + b.amount, 0);
  const showPool = bets.filter(b => b.type === 'show').reduce((s, b) => s + b.amount, 0);

  const oddsMap = {};
  for (const { name } of ENTRANTS) {
    const winBets  = bets.filter(b => b.type === 'win'  && b.entrant === name).reduce((s, b) => s + b.amount, 0);
    const showBets = bets.filter(b => b.type === 'show' && b.entrant === name).reduce((s, b) => s + b.amount, 0);
    oddsMap[name] = {
      winBets,
      showBets,
      winPayout:  winBets  > 0 ? winPool  / winBets        : null,
      showPayout: showBets > 0 ? (showPool / 3) / showBets : null,
    };
  }
  return { winPool, showPool, oddsMap };
}

function computePayouts(bets, results) {
  if (!results || results.length < 3) return null;

  const [first, second, third] = results;
  const showPlaces = [first, second, third];

  const winPool  = bets.filter(b => b.type === 'win').reduce((s, b) => s + b.amount, 0);
  const showPool = bets.filter(b => b.type === 'show').reduce((s, b) => s + b.amount, 0);

  // --- Win pool ---
  const totalWinOnWinner = bets
    .filter(b => b.type === 'win' && b.entrant === first)
    .reduce((s, b) => s + b.amount, 0);
  // If nobody bet on the winner, refund all win bets.
  const winRefund = winPool > 0 && totalWinOnWinner === 0;

  // --- Show pool ---
  // Of the top-3 finishers, which ones actually received show bets?
  // Finishers with no show bets have their share redistributed to the covered places.
  const coveredShowPlaces = showPlaces.filter(entrant =>
    bets.some(b => b.type === 'show' && b.entrant === entrant)
  );
  // If none of the top-3 finishers received show bets, refund all show bets.
  const showRefund = showPool > 0 && coveredShowPlaces.length === 0;
  const showSharePerPlace = coveredShowPlaces.length > 0
    ? showPool / coveredShowPlaces.length
    : 0;

  return bets.map(bet => {
    let payout = 0;
    let refund  = false;

    if (bet.type === 'win') {
      if (winRefund) {
        // Nobody picked the winner — return everyone's stake
        payout = bet.amount;
        refund  = true;
      } else if (bet.entrant === first) {
        payout = (bet.amount / totalWinOnWinner) * winPool;
      }
    } else if (bet.type === 'show') {
      if (showRefund) {
        // None of top-3 were backed to show — return everyone's stake
        payout = bet.amount;
        refund  = true;
      } else if (coveredShowPlaces.includes(bet.entrant)) {
        const entrantShowTotal = bets
          .filter(b => b.type === 'show' && b.entrant === bet.entrant)
          .reduce((s, b) => s + b.amount, 0);
        payout = (bet.amount / entrantShowTotal) * showSharePerPlace;
      }
    }

    return { ...bet, payout: Math.round(payout * 100) / 100, refund };
  });
}

// --- Standings (net score leaderboard) ---
function computeStandings(scores) {
  const rows = ENTRANTS.map(e => {
    const r1Gross = scores.r1[e.name] ?? null;
    const r2Gross = scores.r2[e.name] ?? null;
    const r1Net   = r1Gross !== null ? r1Gross - e.handicap : null;
    const r2Net   = r2Gross !== null ? r2Gross - e.handicap : null;

    let totalNet = null;
    if (r1Net !== null && r2Net !== null) totalNet = r1Net + r2Net;
    else if (r1Net !== null)              totalNet = r1Net;
    // r2 without r1 treated as no score (shouldn't happen in practice)

    return { name: e.name, handicap: e.handicap, r1Gross, r1Net, r2Gross, r2Net, totalNet };
  });

  rows.sort((a, b) => {
    const aHas = a.totalNet !== null;
    const bHas = b.totalNet !== null;
    if (aHas && bHas) return a.totalNet - b.totalNet;
    if (aHas)  return -1;
    if (bHas)  return  1;
    return 0;
  });

  // assign position (ties share same position, next non-tied player skips numbers)
  const scored = rows.filter(r => r.totalNet !== null);
  scored.forEach((row, i) => {
    if (i === 0 || row.totalNet !== scored[i - 1].totalNet) {
      row.pos = i + 1;
    } else {
      row.pos = scored[i - 1].pos;
    }
  });
  rows.filter(r => r.totalNet === null).forEach(r => { r.pos = null; });

  return rows;
}

// --- Express ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const state = loadState();
  const { winPool, showPool, oddsMap } = computeOdds(state.bets);
  res.json({
    entrants:  ENTRANTS,
    bets:      state.bets,
    status:    state.status,
    results:   state.results,
    winPool,
    showPool,
    oddsMap,
    payouts:   state.results ? computePayouts(state.bets, state.results) : null,
    scores:    state.scores,
    standings: computeStandings(state.scores),
  });
});

app.post('/api/bet', (req, res) => {
  const state = loadState();
  if (state.status !== 'open') return res.status(400).json({ error: 'Betting is currently closed.' });

  let { bettor, entrant, type, amount } = req.body;

  if (!bettor?.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!['win', 'show'].includes(type)) return res.status(400).json({ error: 'Invalid bet type.' });
  if (!ENTRANTS.find(e => e.name === entrant)) return res.status(400).json({ error: 'Invalid entrant.' });

  amount = parseFloat(amount);
  if (isNaN(amount) || amount < 1) return res.status(400).json({ error: 'Minimum bet is $1.' });

  const bet = {
    id:        crypto.randomUUID(),
    bettor:    bettor.trim(),
    entrant,
    type,
    amount,
    timestamp: new Date().toISOString(),
  };

  state.bets.push(bet);
  saveState(state);
  res.json({ success: true, bet });
});

app.post('/api/results', (req, res) => {
  const { first, second, third } = req.body;
  if (!first || !second || !third) return res.status(400).json({ error: 'Must provide 1st, 2nd, and 3rd place.' });
  if (new Set([first, second, third]).size !== 3) return res.status(400).json({ error: 'All 3 places must be different players.' });
  if (![first, second, third].every(n => ENTRANTS.find(e => e.name === n)))
    return res.status(400).json({ error: 'One or more player names not recognized.' });

  const state = loadState();
  state.results = [first, second, third];
  state.status  = 'final';
  saveState(state);
  res.json({ success: true });
});

app.post('/api/admin/status', (req, res) => {
  const { status } = req.body;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const state = loadState();
  state.status = status;
  saveState(state);
  res.json({ success: true });
});

app.post('/api/admin/scores', (req, res) => {
  const { round, scores } = req.body;
  const r = Number(round);
  if (![1, 2].includes(r)) return res.status(400).json({ error: 'Round must be 1 or 2.' });
  if (!scores || typeof scores !== 'object' || Array.isArray(scores))
    return res.status(400).json({ error: 'scores must be an object mapping name to gross score.' });

  const state = loadState();
  const key = `r${r}`;
  const errors = [];

  for (const [entrant, gross] of Object.entries(scores)) {
    if (!ENTRANTS.find(e => e.name === entrant)) { errors.push(`Unknown entrant: ${entrant}`); continue; }
    const g = Number(gross);
    if (isNaN(g) || g < 50 || g > 150) { errors.push(`Invalid score for ${entrant}: ${gross}`); continue; }
    state.scores[key][entrant] = g;
  }

  saveState(state);
  if (errors.length) return res.status(207).json({ success: true, warnings: errors });
  res.json({ success: true });
});

app.post('/api/admin/scores/clear', (req, res) => {
  const { round } = req.body;
  const r = Number(round);
  if (![1, 2].includes(r)) return res.status(400).json({ error: 'Round must be 1 or 2.' });
  const state = loadState();
  state.scores[`r${r}`] = {};
  saveState(state);
  res.json({ success: true });
});

app.post('/api/admin/reset', (req, res) => {
  const state = loadState();
  state.bets    = [];
  state.results = null;
  state.status  = 'open';
  state.scores  = { r1: {}, r2: {} };
  saveState(state);
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGolf Betting App running at http://localhost:${PORT}\n`);
});
