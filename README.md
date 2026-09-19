# Football Fact-First Research v7.0.1 — Search Rescue Hotfix

This hotfix addresses a failure discovered on **Chungnam Asan FC vs Cheonan City FC (19 Sep 2026)** where the app reported that it could not recover public evidence even though multiple public fixture/statistics pages existed.

## Root cause
Cloud-hosted Render IPs cannot be trusted to scrape normal Google/Bing/DuckDuckGo HTML consistently. v7.0 treated those best-effort scrapers as if they were a reliable research backbone.

## v7.0.1 fix
- Keeps Google/Bing/DuckDuckGo HTML only as best-effort discovery.
- Keeps Tavily when `TAVILY_API_KEY` is configured.
- Adds a **bounded Gemini Google Search grounding rescue** (maximum four rescue research questions, and only when the ordinary warehouse has zero usable sources).
- Adds **Setup → Test Web Research** so search failures are visible before starting a long research job.
- Error messages report provider diagnostics instead of saying a genuine fixture has no public evidence.
- Preserves the v7 independent-model AI Council and prediction-result tracking.

## Recommended setup
For the most dependable search layer, configure at least one of:

1. `TAVILY_API_KEY` (preferred dedicated search API; Tavily has a free monthly allowance), or
2. `GEMINI_API_KEY` (v7.0.1 can use Gemini Google Search grounding as a rescue path).

Raw HTML search alone should be treated as degraded mode.

## Deployment
Root: `server.js`, `package.json`, `env.example`

Inside `public/`: `index.html`, `service-worker.js`, `manifest.webmanifest`, icons.

Render: `npm install` (or `npm ci` when a lock file is present), then `npm start`.
