# Ejo

A 3D Nokia-style snake game set in the Nigerian bush. It is one self-contained `index.html` that loads three.js from cdnjs.

## Play locally

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## What is in it

- 9 levels across open forests and labyrinths, including two boss levels (Mongoose King, Oga Ratel)
- 5 snakes, each with its own strengths, weaknesses and XP levels
- Endless Bush, a daily challenge, a pass-and-play duel and friend challenge links
- Talking animals, cowries, missions, login streaks, weather and festive events
- A shop priced in naira and cowries: boosts, skins, the Bush Pass, gift codes and rewarded ads

## Settings to change before going live

All of these are near the top of the script in `index.html`.

| Setting | What it does |
|---|---|
| `PAY.publicKey` | Your Paystack public key (`pk_live_...`). Empty means demo mode: purchases are free. |
| `PAY.verifyUrl` | An endpoint on your server that checks a Paystack reference with your secret key and returns `{"ok":true}`. Never put the secret key in this file. |
| `CONFIG.gameUrl` | The address used in share and challenge links. Defaults to the page's own address. |
| `CONFIG.sponsor` | Sponsor name and tagline for the in-game billboards. Empty shows "Your brand here". |
| `CONFIG.giftSalt` | Secret used to check gift codes. Change it, because this repo is public. |

## Things that need a server

- **Leaderboards**: online boards use the Claude artifact database. On your own hosting the game falls back to each player's own bests until you connect a backend.
- **Payments**: verify every Paystack payment on your server before granting items.
- **Gift codes**: they are checked in the browser; record redeemed codes on your server to stop reuse.
- **Rewarded ads**: the game calls Google's H5 Games Ads `adBreak()` when that script is on the page; otherwise it shows a placeholder.

Player progress (cowries, purchases, unlocks) is saved in the browser's local storage.
