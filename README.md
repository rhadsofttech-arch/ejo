# Ejo

A 3D Nokia-style snake game set in the Nigerian bush. It is one self-contained `index.html` that loads three.js from cdnjs.

## Play locally

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Deploy

`npm run build` copies the game into `dist/`. Any static host can serve that folder.

On ZevCloud: Add Service → Web Application → Import from GitHub → this repo, branch `main`, tick **Static site**, publish directory `dist`, build command `npm run build`.

## What is in it

- 9 levels across open forests and labyrinths, including two boss levels (Mongoose King, Oga Ratel)
- A wide forest with no fence: a laterite road crosses each level and leaves through a checkpoint toward the Lagos skyline. Eat enough to lift the barrier, then slither out along the road to finish
- 5 snakes, each with its own strengths, weaknesses and XP levels
- Endless Bush, a daily challenge, a pass-and-play duel and friend challenge links
- Talking animals, cowries, missions, login streaks, weather and festive events
- A shop priced in naira and cowries: boosts, skins, the Bush Pass, gift codes and rewarded ads

## Settings to change before going live

All of these are near the top of the script in `index.html`.

| Setting | What it does |
|---|---|
| `PAY.publicKey` | Your Paystack public key (`pk_live_...`). Empty means demo mode: purchases are free. |
| `PAY.verifyUrl` | An endpoint that checks a Paystack reference and returns `{"ok":true}`. When you run `server.js` with `PAYSTACK_SECRET_KEY`, set this to `/api/paystack/verify`. Never put the secret key in this file. |
| `CONFIG.gameUrl` | The address used in share and challenge links. Defaults to the page's own address. |
| `CONFIG.sponsor` | Sponsor name and tagline for the in-game billboards. Empty shows "Your brand here". |
| `CONFIG.giftSalt` | Secret used to check gift codes. Change it, because this repo is public. |

## Live scores

`npm start` runs `server.js`, which serves the game and a small scores API:

- `GET /api/scores?board=endless|daily|l0..l8|all&date=YYYY-MM-DD` returns the top scores
- `POST /api/scores` saves a player's bests (each player gets a private key, so nobody can overwrite someone else's scores)

The game finds the API at `/api` on the same site automatically, and shows "Top players right now" on the menu, a "score to beat" before each level and a live ranking while you play. To use one API from another site (for example GitHub Pages), set `CONFIG.scoresApi` to its full URL; CORS is open.

Scores are saved to `DATA_DIR/scores.json` (default `./data`). Point `DATA_DIR` at a persistent disk, or scores reset when the server restarts. Scores are reported by the browser, so a determined player could fake one.

## Sign-up and the admin dashboard

Before their first game, players sign up with their name and a username (email is optional). On a host running `server.js`, usernames are checked so no two players share one. Without a server (GitHub Pages, the Claude artifact), sign-up is saved in the player's browser only.

Open `/admin` on your server to see:

- players online now and what they are doing, total players, sign-ups today and this week
- daily active players, sign-ups, runs and revenue for the last 30 days, and the hours people play
- revenue: confirmed with Paystack, unconfirmed, by item, paying players and average spend
- a level funnel (started, finished, clear rate, the most common way to lose), favourite snakes, game modes and areas
- recent sign-ups, recent purchases and top players, plus a CSV download of all players

Set these environment variables on the server:

| Variable | What it does |
|---|---|
| `ADMIN_PASSWORD` | Password for `/admin`. The dashboard stays locked until it is set. Use a long one. |
| `PAYSTACK_SECRET_KEY` | Your Paystack secret key (`sk_live_...`). The server uses it to confirm each payment and its amount, so revenue counts as confirmed. |
| `DATA_DIR` | Where players, scores and events are saved (default `./data`). Point it at a persistent disk. |

The `data/` folder holds names and emails, so it is in `.gitignore`. Never commit it.

## Things that need a server

- **Payments**: verify every Paystack payment on your server before granting items.
- **Gift codes**: they are checked in the browser; record redeemed codes on your server to stop reuse.
- **Rewarded ads**: the game calls Google's H5 Games Ads `adBreak()` when that script is on the page; otherwise it shows a placeholder.

Player progress (cowries, purchases, unlocks) is saved in the browser's local storage.
