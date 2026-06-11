# SideBet — Host Guide & Launch Checklist

## Part 1 — Running an event (host)

Open `/admin.html`. If a PIN is set on the server, enter it once (cached for the session).

### 1. Create the event
**Event tab → New event.**
1. Pick a template (Race Day, Tournament, Head-to-Head, or Custom).
2. Name it, set venue/date, currency, and minimum bet.
3. Choose an accent color — it themes the whole bettor app.
4. **Create event.** Templates drop in example contestants and pools.

### 2. Set the lineup
**Contestants tab.** Add/edit/remove the things people bet on — each has an emoji, name, and optional subtitle (e.g. "Lane 3 · 3yo greyhound"). Delete the template's examples if you don't need them.

### 3. Set up the pools
**Pools tab.** Create as many markets as you want:
- **Winner takes pool** — one winner takes all.
- **Top N share** — set N; the top N finishers' backers share the pool.
- **Head to head** — check exactly the contestants who are in this matchup.

You can open/close or delete each pool independently.

### 4. Open betting
**Event tab → Open betting.** Guests can now place bets from the main app. Watch pools fill and odds move in real time. Hit **Close betting** to freeze everything (e.g. when the race starts).

### 5. Settle & pay out
**Settle tab.** For each pool, enter the finishing order (just the winner for a Win pool; the top N for a Top-N pool) and **Settle & pay out**. The pari-mutuel engine splits the pool by stake and the results appear instantly in everyone's app. Use **Push** to refund a pool (cancelled, tie, void). Made a mistake? **Reopen** clears the result.

When everything's done, set the event status to **Settled** so it counts toward the all-time leaderboard.

### House cut (optional)
The event's "house cut %" skims a percentage off each pool before paying winners (default 0 — friendly games take nothing). Winners split what remains.

---

## Part 2 — What guests see

Guests just open the app URL — no login, they pick a display name (stored on their device). Four tabs:
- **Pools** — live markets; tap a contestant to open the bet slip.
- **My Bets** — their wagers with live status and net once settled.
- **Results** — settled pools, winners, and their own net.
- **Board** — the full odds board across every pool.

Odds for Win/H2H pools are shown as American odds; Top-N pools show pool share %, because a top-N payout depends on which other contestants land in the money.

---

## Part 3 — Store submission checklist

### Backend
- [ ] Deploy `server.js` to Railway (Volume at `/data`, set `ADMIN_PIN`).
- [ ] Note the public URL → this is `API_BASE_URL`.

### GitHub secrets (Settings → Secrets → Actions)
- [ ] `API_BASE_URL` — your Railway URL.

**Android:**
- [ ] `ANDROID_KEYSTORE_BASE64` — base64 of your release keystore.
- [ ] `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

Generate the keystore once:
```bash
keytool -genkey -v -keystore sidebet.keystore -alias sidebet -keyalg RSA -keysize 2048 -validity 10000
# then base64-encode it for the secret:
#   macOS/Linux: base64 -i sidebet.keystore
#   Windows:     certutil -encode sidebet.keystore sidebet.keystore.b64
```

**iOS** (needs an Apple Developer account, $99/yr):
- [ ] `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD` — distribution cert (.p12).
- [ ] `IOS_PROVISIONING_PROFILE_BASE64` — App Store provisioning profile.
- [ ] `IOS_KEYCHAIN_PASSWORD` — any throwaway string.
- [ ] `APPLE_TEAM_ID` — from your Apple Developer account.

### Build
- [ ] Push to `main` (or run the workflow manually). Download the AAB / IPA from the Actions run.

### App icon
The current launcher icons are still the Capacitor placeholders. Generate real ones from `public/icon.svg`:
- Easiest: `npx @capacitor/assets generate` with a 1024×1024 PNG export of `icon.svg` at `assets/icon.png`. It produces every Android mipmap and iOS icon size.

### Store listings (both stores)
- [ ] App name: **SideBet**
- [ ] Short description, full description (lead with "pari-mutuel pools for any event — no real money").
- [ ] At least 2 phone screenshots (Play) / 3 (App Store). Capture from the running app.
- [ ] **Privacy policy URL** (required by both). The app stores only a device-local display name and bets tied to it — no accounts, no personal data collected server-side. A short policy stating that is enough.
- [ ] **Content rating / gambling**: SideBet is for entertainment with no real-money wagering or payouts. Declare it as *simulated gambling* in the IARC questionnaire (Play) and set the appropriate age rating (App Store). Do **not** describe it as real-money gambling, or it triggers a far stricter review.

### Bundle identifier
The app's bundle ID is `com.sidebet.app` (Android `applicationId` + namespace and iOS `PRODUCT_BUNDLE_IDENTIFIER`). This is permanent once published — change it before first submission if you want a different reverse-domain (e.g. one matching a domain you own).
