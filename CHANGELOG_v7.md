# Football Fact-First v7.0 — Stability + Independent AI Council

## Fixed from v6.3
- Replaced the broken service worker with a valid network-first worker.
- Service-worker registration errors are now visible instead of silently ignored.
- `package.json` is the single runtime version source; the server injects it into the browser and service worker.
- Added hard timeouts around AI HTTP calls and Gemini video interactions.
- Extended temporary research-job retention from 45 to 90 minutes.

## AI Council rebuild
- Added **Test AI Council** live preflight in Setup.
- Gemini, OpenRouter, Groq and Cloudflare are tested independently when configured.
- The local deterministic/statistical engine is now a **separate checker**, not an AI Council vote.
- Council depth is now 3 / 4 / 6 / 8 independent AI models; 4 is recommended.
- Council consensus requires at least two independent AI models by default.
- OpenRouter free-model discovery can supply multiple different underlying models.
- Failed/timeout models are reported rather than silently treated as consensus.

## Learning / performance tracking
- Each research round can be marked **GREEN**, **RED**, or **PUSH/VOID** after settlement.
- The market, classification and Council snapshot are saved with the result.
- POSTBOARD shows tracked settled picks and tracked green rate.

## Deployment
- Upload the ROOT package contents directly to the GitHub repository root.
- Upload the PUBLIC package contents directly inside the GitHub `public` folder.
- Render build: `npm install`
- Render start: `npm start`
- After deployment open Setup and run **Test AI Council** before trusting Council output.
