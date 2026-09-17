# Football Fact-First Research v6.0 — Football Intelligence Research Engine

This release is a structural upgrade rather than another small patch. It is designed around the failures exposed during live testing: API quotas, provider outages, fixture-verification gaps, stale browser versions, and the risk of treating many specialist prompts as many independent models.

## Core architecture

The app now separates five layers:

1. **Fixture / identity verification**
   - API-Football team resolution and current squad checks when available.
   - Bookmaker-style team-name aliases.
   - API-Football head-to-head/date verification.
   - football-data.org and TheSportsDB fallback checks.
   - Fresh web fixture-date consensus when the structured API cannot match the fixture.
   - A future fixture date can be marked `PREMATCH_WEB_VERIFIED` only when at least two independent verification sources agree. If the match is today and the clock time is unknown, betting conclusions remain blocked.

2. **Local deterministic data engine**
   - Always available and consumes no LLM quota.
   - Scores team-identity coverage, fixture verification, squad coverage, source diversity and video support.
   - Detects repeated *explicit* exact-market wording across independent source domains.
   - Does not invent xG, tactical information or hidden statistics.
   - Does not replace the full football analysis; it is an independent non-AI evidence layer.

3. **Primary AI failover router**
   - Default text-analysis preference conserves Gemini quota for video:
     1. OpenRouter
     2. Groq
     3. Cloudflare Workers AI
     4. Gemini text
   - If every cloud AI is unavailable, research still completes and preserves the evidence rather than crashing or inventing a pick.

4. **Adaptive AI Council — ceiling 100 agent seats**
   - Initial choices: 5, 8, 12, 20, 50 or 100.
   - Large targets run in waves rather than firing 100 calls at once.
   - The council can stop early when multiple independent underlying models/engines reach stable convergence.
   - Agent-seat consensus and unique-model consensus are reported separately.
   - Specialist agents cannot create fake confidence simply by repeating the same underlying model.
   - A deterministic local engine is included as a separately labelled non-AI council member.

5. **External benchmarks and odds last**
   - External prediction sites run only after the internal sporting analysis and only for a verified pre-match fixture.
   - Actual predictions, explanations and links are extracted where possible.
   - Bookmaker prices are checked only after the sporting shortlist exists.

## Provider circuit breakers

v5.0 adds temporary provider health states:

- `READY`
- `RATE_LIMITED`
- `QUOTA_EXHAUSTED`
- `TEMP_UNAVAILABLE`
- `PLAN_BLOCKED`
- `ERROR_COOLDOWN`

When a provider returns a quota/rate-limit/outage error, the app temporarily stops hammering that provider and moves to another healthy provider. Gemini text and Gemini video have separate health channels because one can remain usable while the other is quota-limited.

The Setup tab shows provider health, cooldown state, calls, successes, failures and API-Football quota information when available.

## Multi-source fixture verification

If API-Football cannot match the fixture:

- football-data.org and TheSportsDB are checked when available;
- two fresh web fixture searches are run;
- only pages that mention both teams are considered;
- future date candidates are grouped by independent source domain;
- at least two independent verification votes must agree before a synthetic web-verified future fixture is accepted;
- the UI lists the verification sources;
- same-day fixtures without an exact kickoff time remain blocked.

This keeps the Pre-Match Integrity Guard strict without making API-Football the single point of failure.

## 100-brain council semantics

“100 brains” means a ceiling of **100 agent seats**, not a claim that 100 completely different foundation models are available.

The UI reports separately:

- requested agent seats;
- executed / available agents;
- unique underlying models/engines;
- specialist agents;
- deterministic engines;
- unique-model consensus;
- agent-seat consensus;
- adaptive early-stop reason.

## Environment variables

Required for live public-web research:

- `TAVILY_API_KEY`

Strongly recommended structured data:

- `API_FOOTBALL_KEY`

AI providers — connect as many as available; none is individually mandatory:

- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_AUTH_TOKEN`
- `GEMINI_API_KEY`

Optional data/video fallbacks:

- `FOOTBALL_DATA_ORG_KEY`
- `SCOREBAT_TOKEN`

Optional:

- `APP_PUBLIC_URL`
- `GEMINI_MODEL`
- `GEMINI_VIDEO_MODEL`
- `API_FOOTBALL_MIN_GAP_MS`

## GitHub update placement

Repository root:

- `server.js`
- `package.json`

Inside `public/`:

- `index.html`
- `service-worker.js`
- `manifest.webmanifest`

The full package also contains the PWA icons.

## Render

Build command:

```text
npm install
```

Start command:

```text
npm start
```

After deployment, verify that the top of the app says **v5.0** before testing a fixture.

## Important integrity rule

A market is not allowed merely because web sources or video evidence exist. If the target fixture is live, finished, same-day with unknown kickoff time, or otherwise temporally ambiguous, the app blocks pre-match betting conclusions. Post-match result information must never be used to manufacture a pre-match prediction.


## v5.1 — fixes exposed by Lion City Sailors vs BG Pathum United

This test exposed two linked problems:

1. `Lion City Sailors FC` was falsely resolved as `Golden Lion` because fuzzy name similarity accepted the single token `Lion`.
2. The bad structured alias then poisoned web fixture verification and YouTube search, causing unrelated "Golden" videos and blocking a fixture that was publicly scheduled.

v5.1 fixes both root causes:

- Multi-word team names now require strong token identity coverage. `Lion City Sailors` can no longer resolve to `Golden Lion`.
- Explicit alias support was added for Lion City Sailors and BG Pathum United.
- Web fixture verification always searches the REQUESTED team names, not a possibly-wrong structured alias.
- Fresh web verification can extract exact UTC/SGT kickoff times.
- Two independent fixture/date sources plus an explicit timezone-aware kickoff can create an exact web-verified fixture time.
- Video searches use quoted requested club names plus the word `football`.
- Video candidates must actually mention one of the requested teams and obvious music/trailer/movie results are rejected.
- Suspicious structured club matches are discarded instead of being allowed to contaminate squads, fixture verification, or video evidence.

The integrity guard remains strict, but a bad third-party team alias should no longer be able to block a clearly verified future fixture.


## v6.0 — Football Intelligence Research Engine

v6.0 changes the project from an API-led predictor into a research-first evidence system.

- Multi-search discovery fleet: Google HTML best-effort, Bing HTML, DuckDuckGo HTML, and Tavily when configured.
- Tavily is optional; one search provider can fail without ending the match.
- Automatic research-question ledger across fixture, squads, injuries, lineups, transfers, last 5/10, home-away, opponent strength, goals/xG, shots/SOT, possession, corners, cards/referee, tactics, rest/fatigue, motivation, H2H, weather, predictions, Reddit, X, Facebook, YouTube, local media, counter-evidence, thresholds and press conferences.
- Search results are only doorways: the engine opens public pages, extracts readable text and keeps snippets when a site blocks automated reading.
- Evidence warehouse records source type, reliability, independent domains, readable pages, duplicate content families and page errors.
- Standard / Deep / Maximum research modes.
- Saturation detection stops wasteful repeated searching when new research questions stop adding independent sources.
- Structured football APIs are cross-checkers rather than the only gatekeeper.
- The evidence warehouse can independently verify a future fixture date/kickoff when multiple independent sources agree.
- All external searches/page reads use timeouts so a stalled provider does not freeze the whole research job.
- Existing deterministic engine, provider circuit breakers and adaptive 100-agent AI council remain in place.
