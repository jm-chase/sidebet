# SideBet 🎲

**Customizable pari-mutuel betting pools for any event.** Dog races, golf tournaments, chili cook-offs, fantasy drafts, office bracket — if you can name contestants and an outcome, SideBet runs the pool.

No real money, no bookie. It's a **pari-mutuel** system: everyone's stakes go into a shared pool, and when the result is in, the winners split the pool in proportion to what they bet. The app just does the bookkeeping and the live odds.

---

## Why it's flexible

Every kind of bet collapses into one primitive: a **market** (a pool) where people back a **contestant** for an outcome. SideBet has three market types, and they cover essentially everything:

| Market type | What it means | Examples |
|---|---|---|
| **Winner takes pool** (`win`) | One winner. Backers of the winner split the whole pool. | Race winner, tournament champion, "who finishes the hot wings first" |
| **Top N share** (`topn`) | The top N finishers are all winners; everyone who backed an in-the-money contestant shares the pool. | Podium (top 3), Place/Show in racing, "top 2 chili entries" |
| **Head to head** (`h2h`) | A pool restricted to a subset of contestants (usually 2). | Player A vs Player B, Team Red vs Team Blue |

An event can run **many markets at once** — e.g. a race day with a Win pool, a Place pool, and a couple of grudge-match head-to-heads, all live simultaneously.

## Two pricing modes

Each Win or Head-to-Head market can run in one of two modes:

- **Pool (pari-mutuel)** — the default. No odds are fixed; the pool is split among the winners by stake at settlement. Can never be short, but you don't know your exact payout until betting closes.
- **Fixed odds (line)** — the host pastes a real book's American odds (e.g. `-150 / +130`); SideBet **strips the juice** (de-vigs to fair odds that sum to 100%) and bets lock those fixed odds. Settlement uses **match-then-pool**:
  - Winners are paid their locked fixed odds, funded by the losing money.
  - If the winner was *over-backed* (losing money can't cover full fixed odds), winner profits scale down pro-rata so the pool clears exactly — never a shortfall.
  - If the winner was *under-backed* (leftover losing money), the surplus is refunded to losers pro-rata — no juice is kept.

  Each line chip shows a live **coverage %** — how much of that pick's fixed-odds winnings the opposing money currently covers. The rest pools/scales at settlement. This is how you get fixed Vegas-style numbers among friends without a bookmaker holding the risk.

## Templates

Creating an event from a template seeds example contestants and the right pools so you're live in seconds. Everything is editable afterward.

- 🏁 **Race Day** — Win / Place / Show, six racers pre-loaded
- ⛳ **Tournament** — Overall Winner + Podium (top 3)
- 🥊 **Head-to-Head** — a single A-vs-B pool
- ✨ **Custom** — blank canvas, build your own

---

## Architecture

```
public/index.html   Bettor app  (mobile-first, no build step, vanilla JS)
public/admin.html   Host console (PIN-gated)
public/icon.svg     Brand mark — source for store icons
server.js           Express API + pari-mutuel payout engine + templates
db.js               SQLite schema (events, contestants, markets, bets…)
android/ ios/       Capacitor native shells (App Store / Play wrappers)
.github/workflows/  CI builds for signed Android AAB and iOS IPA
```

The frontend is plain HTML/CSS/JS served statically — it talks to the API over `fetch`. The native apps are the same web app wrapped by Capacitor, pointed at a hosted backend via `public/config.js`.

## Running locally

```bash
npm install
npm start            # serves on http://localhost:3000
```

- Bettors: `http://localhost:3000/`
- Host console: `http://localhost:3000/admin.html`

No `ADMIN_PIN` set ⇒ the host console is open (fine for local testing). Set one to lock it (see below).

## Configuration

| Env var | Purpose |
|---|---|
| `ADMIN_PIN` | If set, every `/api/admin/*` call and the host console require this PIN. **Set this in production.** |
| `PORT` | Server port (default 3000). |
| `RAILWAY_VOLUME_MOUNT_PATH` | Where the SQLite file lives. Set automatically on Railway; defaults to `./data`. |

For the **mobile apps**, set the backend URL in `public/config.js` (or via the `API_BASE_URL` GitHub secret, which the CI injects at build time):

```js
window.API_BASE = 'https://your-backend.up.railway.app';
```

## Deploying the backend (Railway)

1. New Project → Deploy from GitHub → this repo.
2. Add a **Volume** mounted at `/data` so the database survives deploys.
3. Add env var `ADMIN_PIN`.
4. Railway gives you a public URL — that's your `API_BASE_URL`.

## Building the apps

Push to `main` triggers the GitHub Actions workflows (`.github/workflows/`), which run `cap sync`, sign, and upload the artifacts. Required secrets are listed in **GUIDE.md**.

---

See **[GUIDE.md](GUIDE.md)** for the host walkthrough and the full store-submission checklist.
