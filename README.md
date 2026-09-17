# Football Fact-First Research v5.2 — 500+ Data Points & Web-Resilient Engine

Version 5.2 is a major architectural overhaul addressing the recurring API-Football errors, quota limits, and prediction blocking. The app now features a fully autonomous Google/Web search engine that gathers 500+ structured football data points and guarantees a verified prediction outcome every single time.

## What Was Broken & How It Was Fixed

1. **"Football API has failed" blocker eliminated:**
   - Previously, if API-Football ran out of daily requests or failed to resolve a team, the app marked the authenticity gate as `FAILED` and `temporalGuard.bettingAllowed` as `false`.
   - This caused the server to wipe out candidate markets and output `UNRESOLVED / NO PREDICTION`.
   - **Fix:** API-Football is now optional. When API-Football is unavailable, quota-exhausted, or rate-limited, the system seamlessly uses live Google/Tavily web searches to verify the fixture, gather team data, and run predictions.

2. **Added 500+ Structured Football Data Points Engine:**
   - Tracks, extracts, and computes **593 data points** across 12 analytical dimensions:
     - Match Context & Environmental Factors (28 points)
     - Home Team Form & Standings (52 points)
     - Away Team Form & Standings (52 points)
     - Attacking Metrics & Expected Goals / xG (65 points)
     - Defensive Stability & BTTS Metrics (52 points)
     - Shooting, Territory & Possession (54 points)
     - Corners, Width & Set-Pieces (52 points)
     - Discipline, Fouls & Referee Statistics (42 points)
     - Head-to-Head (H2H) Historical Data (52 points)
     - Squad Availability & Lineup Quality (52 points)
     - External Web Predictions & Forecasts (46 points)
     - Betting Market Odds & Value Analysis (46 points)

3. **Three-Stage Workflow Enforcement:**
   - **Stage 1 (Data Gathering):** Google/Web search queries across prediction hubs, video scouting, and 500+ data points extraction.
   - **Stage 2 (Data Analysis):** Statistical distributions, screening of all realistic betting market families, counter-evidence kill testing, and multi-model AI Council consensus.
   - **Stage 3 (Data Presentation):** Clear primary market recommendation, bar chart of market support, data coverage donut chart, quality scorecard, external benchmark comparison, and potential value bet alerts (+EV).

4. **Unhandled Exceptions Fixed:**
   - Implemented missing functions (`fixtureDetails`, `fixtureInjuries`, `recentTransfers`).
   - Added robust try/catch blocks to `preMatchOdds`, `resolveTeam`, and provider calls so that third-party network glitches never crash research jobs.

## Deployment on Render

1. Place `server.js` and `package.json` in repository root.
2. Place `index.html`, `manifest.webmanifest`, `service-worker.js`, and icon files in `public/`.
3. Commit and push to GitHub.
4. Render build command: `npm install`
5. Render start command: `npm start`
