# Sleeper Trade Tracker

Every trade in the league, with traded draft picks followed to the actual pick and player, graded three ways (Production, Dynasty Value, Blended), plus trade trees, awards, report cards and trade anniversaries.

## How it works

- `scripts/build-data.mjs` pulls the league's full history from the Sleeper API (following `previous_league_id` back to the first season), plus dynasty values from FantasyCalc. It writes `site/data/league.json`.
- `site/` is a static page with no build step that reads that file. All grading happens in the browser, so the metric toggle and blend slider are instant.
- `.github/workflows/deploy.yml` rebuilds the data every morning and on every push, then publishes `site/` to GitHub Pages. Nothing gets committed back to the repo.

To point it at a different league or format, edit `config.json`.

## Local preview

```bash
npm run dev
```

Then open http://localhost:5173.

## Publishing to GitHub Pages (one-time)

1. Create a new **public** repo on github.com (for example `die-nasty-trades`), with no README.
2. Push this folder:
   ```bash
   git init -b main
   git add .
   git commit -m "Trade tracker"
   git remote add origin https://github.com/<you>/die-nasty-trades.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Actions → Refresh data & deploy → Run workflow**. In about a minute the site is live at `https://<you>.github.io/die-nasty-trades/`.

After that it refreshes itself daily. To refresh right away (for example after a big trade), click **Run workflow** again.

## Tuning

The grading knobs live at the top of `site/js/grade.js`:
- replacement-level PPG by position
- minimum games
- star premium for value
- how long production takes to phase in
