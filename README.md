# Football Fact-First Research v3.8 — Version Handshake


This version is designed specifically to prevent stale-player mistakes such as describing a footballer as being at an old club after a transfer.

## New in v2

Before AI analysis is allowed to begin, the server:

1. Resolves both club names against API-Football.
2. Loads each club's CURRENT registered squad (`/players/squads`).
3. Finds the actual upcoming fixture between the two resolved team IDs.
4. Loads the fixture details and checks whether starting XIs are genuinely confirmed.
5. Loads fixture-specific injuries/suspensions.
6. On Relearn rounds, also checks recent transfer activity.
7. Only then runs Tavily live-web research and Gemini analysis.
8. Gemini is explicitly forbidden from treating old web articles as proof of current club membership.
9. If team/fixture identity fails, the server forcibly marks the match UNRESOLVED.

The result page shows:
- Authenticity Gate: VERIFIED / CAUTION / FAILED
- resolved club names and confidence
- fixture date/competition
- current squad counts
- confirmed-lineup availability
- current injuries/suspensions
- API-Football quota remaining
- stale player/club claims rejected
- fresh web sources used
- market shortlist + kill-the-pick test

## Recommended fixture format

`Home Team vs Away Team`

Examples:
- Real Madrid vs Barcelona
- Arsenal vs Chelsea

## Render Environment Variables

Add these under Render -> your football service -> Environment:

- `API_FOOTBALL_KEY`
- `TAVILY_API_KEY`
- `GEMINI_API_KEY`
- optional `GEMINI_MODEL` (default: `gemini-3.8-flash`)

Then save and redeploy.

## API-Football free tier

At the time this package was prepared, API-Football's official pricing page lists a $0 free plan with 100 requests/day, all endpoints, and no credit card required. The provider stops requests when quota is reached rather than overcharging.

Because the free plan also has a per-minute rate limit, this app serializes structured-data calls with conservative spacing. A verified fixture can therefore take roughly 30–60 seconds before web/AI analysis finishes. This is intentional: freshness is more important than speed.

## Relearn

Relearn is not a simple rewording. It:
- refreshes current squads/fixture information,
- refreshes injuries and lineups,
- adds a recent-transfer check,
- searches with different query angles,
- runs a fresh independent analysis round,
- reports convergence/conflict with earlier rounds.

## Important

No betting result is guaranteed.
The app does not log in to, click, scrape, or place bets on BetPawa.
You paste the fixture names; the research engine handles the evidence workflow.


## New in v2.1 — complete source audit

Every web and video-search query is retained. The final report contains:
- sources used in final synthesis;
- ALL unique links returned during scouting;
- the query that discovered each link;
- publication date when the search provider returns one.

This is intentionally more transparent than showing only the sources the AI finally cited.

## New in v2.1 — actual highlight-video review

The server searches for recent public YouTube highlights for both teams.
Up to four selected public videos are passed to Gemini's video-understanding API.

The review checks visible:
- attacking routes and movement;
- central vs wing play;
- transitions/counter attacks;
- crossing and set-piece patterns;
- chance quality visible in the selected clips;
- defensive errors/shape;
- goalkeeper actions;
- pressing, pace and physicality;
- behavior while leading/trailing when observable.

The app prominently warns that highlights are selective evidence, not full-match samples.
It never invents numerical match statistics from video.

No separate YouTube API key is required in v2.1 because the links are discovered through
the existing live-web search layer and then passed directly to Gemini for video analysis.
Public YouTube URL analysis is currently a Gemini API preview feature.


## New in v2.2 — two ways to start

### 1. I will give the games
Paste fixtures normally.

### 2. Find data-rich games for me
The app scans upcoming fixtures and ranks candidates using:
- league-season structured coverage flags;
- lineup/statistics/player/injury/prediction coverage;
- fresh public-source availability.

Bookmaker odds are EXCLUDED from discovery scoring. This prevents the app from choosing a game merely because a favourite has a short price.

The discovery engine rejects weak-public-data fixtures and shows a Data Availability Score.

## New in v2.2 — every market family must be considered

Before prices are visible, Gemini must register the status of:
1X2, Double Chance, DNB, Asian Handicap, European Handicap, totals, team totals,
BTTS, first-half/second-half goals, combinations, total/team/half corners,
corner handicaps/Corner 1X2, cards/team cards, shots/SOT where data supports them,
plus other evidence-supported bookmaker markets.

Each family is shown as CONSIDERED, ELIMINATED or DATA_UNAVAILABLE.

## New in v2.2 — Value Watch

This preserves FACTS FIRST, ODDS LAST.

1. Sporting evidence creates the exact-market shortlist.
2. Each surviving market gets a cautious model fair-probability estimate.
3. Only then does the server request pre-match bookmaker odds from API-Football.
4. The server calculates the market break-even probability as 100 / decimal odds.
5. A candidate is flagged POTENTIAL_VALUE only when the model fair probability exceeds
   break-even by at least 5 percentage points.
6. 2–5 percentage points is shown only as VALUE_WATCH, not a value declaration.

The UI uses wording such as:

"Whilst researching, I found this to be a potential value bet.
The market may be underpricing this selection according to the current evidence model."

This is deliberately not phrased as certainty. Fair probability is a model estimate, not ground truth.

## Odds availability

API-Football pre-match odds are used after analysis. Availability varies by fixture,
competition and bookmaker. The app records the number of bookmakers, bet types and selections returned.
If an exact sporting candidate cannot be mapped to a returned price, it is labelled UNPRICED_OR_UNMAPPED
instead of inventing an odds comparison.


## New in v2.3 — explicit research pipeline

The two start modes stay unchanged:

1. I will give the games.
2. Find data-rich games for me.

After a fixture enters the research engine, it now follows three mandatory stages.

### Stage 1 — Data Gathering

Collect as much relevant, current evidence as possible before forming a market opinion:
current squad, fixture identity, injuries, suspensions, transfers, confirmed/predicted XI,
rest/rotation/motivation, last 5/10, opponent strength, goals/xG/chances, shots/SOT,
possession/territory, corners, width/crossing, set pieces, cards/referee, tactics/game state,
H2H, venue/weather, recent video evidence and all source links.

### Stage 2 — Data Analysis

The model must analyze rather than simply repeat facts.

It now returns:
- overall evidence-quality score;
- structured-data score;
- public-web-evidence score;
- video-evidence score;
- freshness score;
- contradiction-risk score;
- key patterns;
- key contradictions;
- an analytical narrative;
- individual market sporting-support, data-support and contradiction-risk scores.

Opponent-strength distortion, data gaps and stale evidence must be taken into account.

### Stage 3 — Presentation

The phone/web interface now presents the completed analysis with:

- horizontal bar chart comparing shortlisted markets;
- donut/pie chart showing complete / partial / unavailable data coverage;
- evidence-quality score cards/bars;
- normal written explanation;
- complete market-family screen;
- video evidence;
- Value Watch;
- sources used and ALL sources scouted.

The charts are generated directly in the browser without an external chart library, so the presentation
stays lightweight and phone-friendly.

Charts do not create the decision. They visualize the already-completed analysis.


## v3.0 architecture

DATA COLLECTION → DATA ANALYSIS → INDEPENDENT AI COUNCIL → DATA PRESENTATION →
EXTERNAL PREDICTION BENCHMARKS → ODDS/VALUE LAST.

Council models:
- Gemini (core)
- OpenAI GPT-OSS 120B via Groq
- Qwen 3.8 27B via Groq
- Meta Llama via Cloudflare Workers AI
- OpenRouter Free Router fallback/diversity

Every council model receives the same locked evidence pack with bookmaker odds hidden.
Disagreement is preserved instead of forced.

POSTBOARD summarizes:
- completed fixtures
- STRONG classifications
- primary + council convergence
- potential value alerts
- unresolved matches
- average evidence quality
- each fixture's primary market, council consensus and value status

External prediction benchmarks are shown only after independent internal analysis:
API-Football Predictions, Forebet, PredictZ, WinDrawWin and FootyStats search results.

Important: ChatGPT Plus is not used as an API inside this application.
The OpenAI-family free council member is GPT-OSS 120B through Groq when GROQ_API_KEY is configured.


## v3.1 hotfix
Google documents HTTP 503 UNAVAILABLE as a transient overload condition and recommends exponential backoff. This build retries automatically and then falls back through Gemini 3.7 Flash, Gemini 3.6 Flash and Gemini 3.5 Flash-Lite before giving up.


## v3.2 — actual external predictions, not link lists

External benchmark sites are now processed as evidence sources rather than link directories.

For Forebet, PredictZ, WinDrawWin and FootyStats the app now:
1. searches for the exact fixture;
2. rejects search results that do not match both teams;
3. uses Tavily Extract to retrieve the actual page content;
4. asks Gemini to extract ONLY an explicitly published prediction from that source;
5. suppresses stale or unrelated match pages;
6. displays:
   - exact published prediction;
   - market/selection;
   - probability when the source publishes one;
   - correct score when published;
   - other explicit markets when present;
   - a concise paraphrase of the source's explanation/trends/reasoning when available;
   - the direct source URL;
   - fixture date and freshness status.

If the site has an exact fixture page but does not publish a clear prediction, the app says
NO VALID PREDICTION rather than inferring one from statistics.

External benchmark consensus is calculated only from successfully extracted current predictions.


## v3.3 — malformed AI JSON recovery

This hotfix addresses errors such as:

Expected ',' or ']' after array element in JSON

The research data was not necessarily wrong; the AI had returned a syntactically malformed JSON object.

v3.3 now:
- uses `jsonrepair` before rejecting an AI response;
- repairs common missing commas, quotes, brackets and other JSON syntax defects;
- applies the same repair path to primary analysis, AI Council, external-prediction parsing and video-review JSON;
- if primary Gemini analysis is still malformed after repair, automatically asks for one fresh clean-JSON response;
- no longer labels the entire session "complete" when one or more fixtures ended in an error.

GitHub update requires:
- server.js
- package.json
- public/index.html

Render will run `npm install`, install jsonrepair and redeploy automatically.


## v3.4 — fallback data and quota resilience

Added:
- football-data.org optional free fallback
- TheSportsDB V1 free fallback (key 123)
- ScoreBat optional limited free highlight feed
- automatic fallback authenticity mode if API-Football is unavailable or quota-limited
- fallback discovery for upcoming games
- provider/quota dashboard

## Expandable Council

Initial council size: 5, 8, 12, or 20 agents.
After research, use +5 AI Brains or +10 AI Brains repeatedly up to 50 agent seats.

The app distinguishes UNIQUE MODELS from SPECIALIST AGENTS.
It dynamically uses current zero-price OpenRouter models when configured, plus Gemini/Groq/Cloudflare models.
If distinct models are exhausted, specialist agents provide independent lenses such as corners, goals, tactics, lineups, opponent strength and adversarial testing.

50 is supported as an agent-seat ceiling, not a promise of 50 different model families.
Large councils can hit free-provider quotas, so the UI warns before heavy expansion.


## v3.5 critical integrity hotfix

The Everton vs Wolverhampton test exposed several important issues.

### 1. Pre-match temporal integrity
The app now determines whether the verified fixture is:
- PREMATCH
- LIVE_OR_STARTED
- POST_MATCH_AUDIT
- UNKNOWN

If the fixture has started/finished, or kickoff cannot be verified, the app blocks new betting recommendations,
AI-council consensus, external prediction benchmarking and value pricing.

This prevents post-match reports, goalscorers, red cards and actual results from leaking into what appears to be a pre-match prediction.

### 2. Better API-Football team resolution
If an exact team search is weak, the app automatically retries cleaned/alias variants such as:
Everton FC -> Everton
Wolverhampton Wanderers -> Wolverhampton / Wolves
Lokomotiv Moscow -> Lokomotiv Moskva
Krylia Sovetov Samara -> Krylya Sovetov

Extra searches happen only when the first exact lookup is weak, to preserve quota.

### 3. Gemini highlight-video repair
@google/genai is upgraded to >= 2.0.0 to use the current Interactions API schema.
The existing direct public YouTube URL video-review flow is retained.

### 4. Council semantics
One responding model is no longer labelled a council consensus.
With fewer than two available council members, status is INSUFFICIENT and the app labels it as a single-model opinion.

### 5. Stale-browser update protection
index.html, manifest and service worker are now served with no-cache headers.
The v3.5 service worker activates immediately so GitHub/Render updates stop leaving the old UI visible.


## v3.6 — live research progress and Round 2 fix

The Relearn / Fresh Round workflow now gives immediate visible feedback.

Every round reports live progress from the server across ten stages:

1. Starting research round
2. Fixture verification
3. Fallback cross-checks
4. Fresh web scouting
5. Video scouting / review
6. Data analysis
7. Independent AI Council
8. External prediction benchmarks
9. Odds & value audit
10. Presentation

Each fixture card displays:
- current round number;
- current stage and percentage;
- current server-side activity/comment;
- elapsed time;
- the four most recent progress messages.

The Relearn button is disabled while a round is already running, preventing accidental duplicate research.
If Round 2 fails, the exact server error is shown instead of appearing to do nothing.

The server exposes a temporary no-store endpoint:
GET /api/research-progress/:progressId

Progress records expire from memory after 45 minutes and do not add API usage.


## v3.7 — asynchronous research jobs

The error:

Unexpected token '<', '<!DOCTYPE '... is not valid JSON

usually means the browser expected JSON but received an HTML error page from a proxy/server instead.
A long multi-stage research request can be vulnerable to this class of infrastructure timeout.

v3.7 changes the architecture:

1. POST /api/research-start returns immediately with HTTP 202.
2. The Node server continues the research job in the background.
3. The browser polls /api/research-progress/:id for the live stage tracker.
4. The browser polls /api/research-result/:id until the finished JSON result is available.
5. The browser no longer keeps one multi-minute HTTP request open.

This makes long Round 1 / Round 2 research much less vulnerable to Render/proxy HTML timeout pages.

The browser also has a safe JSON reader. If any endpoint ever returns an HTML page,
the user sees a clear infrastructure/provider message instead of a raw JSON parser exception.


## v3.8 — mixed-version protection

A partial deployment can leave a newer async server behind an older cached v3.0 browser UI.
The old UI expects POST /api/research to return a complete round, while the newer server starts
an asynchronous job. That mismatch can create an empty-looking "successful" round with 0 sources,
0 evidence and invalid dates.

v3.8 fixes this:
- GET /api/version exposes the server release/protocol.
- The browser checks its APP_VERSION against the server before research.
- If they differ, Start Research is disabled and an Update Required message is shown.
- The legacy POST /api/research endpoint now returns HTTP 409 CLIENT_UPDATE_REQUIRED instead of
  returning an async acceptance object that old clients can mistake for completed research.

This prevents mixed-version deployments from silently producing zero-data reports.
