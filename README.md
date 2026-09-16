# Football Fact-First Research v3.0 — Multi-AI Council + POSTBOARD

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
