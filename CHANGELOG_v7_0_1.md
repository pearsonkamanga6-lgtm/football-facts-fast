# v7.0.1 Search Rescue Hotfix

- Fixed false “no usable public evidence” failures when cloud-hosted search-engine HTML returned zero results.
- Added Gemini Google Search grounding fallback, invoked only after the normal warehouse has no usable source.
- Added `/api/search-preflight` and a **Test Web Research** button.
- Added provider-by-provider search diagnostics.
- Health screen now distinguishes best-effort HTML search from reliable configured live-search rescue.
- Bumped app version to 7.0.1.
