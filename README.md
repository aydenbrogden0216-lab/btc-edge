# BTC 15m Edge

A phone page for Polymarket US's BTC 15-minute Up/Down markets.

**Live tab**
- Polymarket US odds for the current window (Up buy price; Down = 1 − Up's bid)
- The official price to beat and the live BRTI index, which is what these markets settle on
- Fair chance of Up from a volatility model that weights recent minutes more, allows for sudden jumps, and accounts for the close being a 60-second average
- Edge on each side after the taker fee, flagged "Worth a look" above your threshold (3¢ by default)

**Record tab**: once windows you watched settle, shows how flagged bets would have done after fees, whether the model's percentages match reality, and whether it beats the market's own odds.

**Bets tab**: log the bets you actually place; results and profit/loss fill in automatically, split by flagged vs. not flagged.

Everything is saved on your phone only. "Download CSV" exports the readings.

## Deploy

1. Upload these files to a new GitHub repo, keeping the `api` folder.
2. Vercel → Add New → Project → import the repo → Deploy. No keys needed.
3. On iPhone, Share → Add to Home Screen.

## Notes

- If the US market can't be reached, the page falls back to the global Polymarket book and says so in yellow. Don't bet off fallback numbers.
- The fee rate defaults to Polymarket US's standard taker rate (Θ = 0.0695). Change it in Settings if the app charges something different on these markets.
- The model hasn't been tested on real past windows yet. Trust the Record tab, not the flags, once it has a few hundred results.
