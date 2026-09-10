# AGENTS.md

Trend-harvest + digital-product qualification pipeline. Flat repo, public GitHub repo since 2026-09-10 (`github.com/TechHypeXP/hex-expan` — public because CodeRabbit/Cubic PR-review tools need it on their free tiers; `.env`, `data/`, `downloads/` all gitignored). TypeScript-only, run via tsx. No test suite.

## Commands

```bash
pnpm harvest                  # fire 5 grounded engines -> data/run_*/payload.json
pnpm score -- --top=12        # PHASE 3 only: Vs-score + rank (needs candidates.json first)
pnpm report                   # render latest scored.json -> report.md + self-contained report.html
pnpm transcribe -- --watch    # live/one-shot whisper transcription via OpenRouter STT (see notes below)
pnpm creator-scan             # micro-creator finder: Exa+Brave discovery (YouTube+Instagram) -> real-stat verify -> contact hunt
                               #   tunables (niches, follower band, activity window, rate limits, model) live in
                               #   config/creator_scan.json, not hardcoded — pass --config=<path> to override
pnpm registry-report          # data/db/{runs.jsonl,creators.json} -> data/db/registry_report.html (New/Reviewed/Contacted/Converted view)
pnpm scrape                   # getinsight_id_br.ts (ideabrowser deferred; kept for Whop/Gumroad targets)
```

## Scheduled scanning (since 2026-09-10)

`scripts/scheduled_creator_scan.sh`, installed via crontab (`0 */4 * * *`), runs
`creator-scan` + `registry-report` on a ramped cadence: 6x/day (every 4h) for the
first 4 days since first fire (tracked in `data/db/.scan_schedule_start`), then
drops to 1x/day at 09:00 Cairo time. Logs to `data/db/scheduled_scan.log`. Chosen
because `trendFreshnessHours` (config/creator_scan.json) is 6h, so a 4h cadence
never wastes a SerpAPI call, and 24 runs over 4 days gives a real multi-run sample
of the trend-filtered pipeline's hit rate before settling into steady state.

OpenRouter also serves Speech-to-Text: `POST /api/v1/audio/transcriptions`, JSON body `{model: "openai/whisper-large-v3-turbo[:nitro]", input_audio: {data: <base64>, format: "mp3"|"wav"|...}}` — ~$0.012/audio-hour. Growing yt-dlp `.part` files are ffmpeg-readable mid-stream (live transcription possible).

Brave free tier = 1 req/sec (`x-ratelimit-policy: 1;w=1`) — serialize calls with ≥1.1s stagger or everything past the first request 429s. Brave also returns HTTP 200 with `bad_results:true` + `{mixed:{main:[]}}` shape for over-constrained queries — the poison-guard misses this shape (no `error` key, non-empty wrapper), so cache keys get version-bumped when query logic changes. Exact-phrase stacking (`"a" AND "b" AND "c"`) reliably returns zero — use plain keyword queries.

More hard-won traps: `node --env-file` / `dotenv` do NOT override shell env (stale `~/.bashrc` key) — parse `.env` directly or use `override:true` with absolute path; never pass base64 through shell args (ARG_MAX) — build JSON bodies in node/fs; `pnpm [--dir] script -- args` loses args under tsx — call `node_modules/.bin/tsx` directly; tsx can hang post-script (esbuild service keeps loop alive) — kill by PID; never combine kill-patterns with literal target strings in one command; no unbounded foreground waits in tool commands.

## Session continuity

- `data/intel/session_handover_2026-09-09.md` — full two-day handover report (timeline, loops, bridge content, critical path). Read together with this file.

Syntax check (no test suite exists):

```bash
pnpm exec esbuild harvest.ts --outfile=/dev/null   # repeat for any changed .ts
```

## Data format policy (per layer, not one format)

- **JSON** — machine payloads only (`payload.json`, `scored.json`, `candidates.json`)
- **NDJSON** — append-only run log (`data/index.jsonl`)
- **Markdown + self-contained HTML** — human report layer (`pnpm report`; HTML opens locally, zero infra; static Vercel deploy later needs no backend/Supabase — defer Supabase until multi-device history UI is actually needed)
- **SQLite/CSV** — consider only when trend-queries across >10 runs or spreadsheet export is demanded

## Intel layer

- `data/intel/` — human-distilled strategy documents (`intel_gadzhi_summit_day3.md`: micro-creator distribution model, operator playbook, VRE framing; `intel_gadzhi_summit_day4.md`: funnel-hacking method, upsell math, one-day cash machine, picks-and-shovels framing). Derived from recorded live streams (`downloads/day*/transcript_*.md` via `pnpm transcribe`). Full session-continuity doc: `data/intel/session_handover_2026-09-09.md`.
- An additional candidate class was proposed 2026-09-08 — pending a pricing-band decision before adding to candidates.json; proposed schema fields (`upsell_companion`, `funnel_type`) noted in day-4 intel. Full rationale kept in `data/intel/` (gitignored, not in this public repo).
- `data/intel/engine_thesis_handover.md` §10 has a fact-checked review of an external ("CCW") critique and a ranked 10x plan. No Phase 4 script exists yet — it's a spec, not shipped code. Real bug found there: Phase 2 generates template-clone candidates ("[X] Tracker" vs "[X] Ledger") that pass Jaccard dedup because they're genuinely different tokens — fix belongs in the Phase 2 prompt (diversity constraint), not in score.ts's dedup logic.

## Hard-won quirks

- **pnpm 12 settings home is `pnpm-workspace.yaml`**, not the `pnpm` field in package.json (silently ignored). `onlyBuiltDependencies: [esbuild]` lives there.
- `ERR_PNPM_IGNORED_BUILDS` for esbuild is **advisory** — tsx works anyway (verified via `pnpm exec tsx --version`).
- `packageManager` and `devEngines.packageManager` in package.json must stay aligned or corepack hard-fails with `ERR_PNPM_BAD_PM_VERSION`.
- All scripts are `.ts` run through tsx (`pnpm harvest` etc.). Do not reintroduce `.mjs` — it was deleted deliberately.
- Scripts load `.env` via dotenv with **`override: true`** — `~/.bashrc` exports a stale Kilo Code `OPENROUTER_API_KEY` that shadowed the real key (dotenv never overrides by default → silent 401 "User not found" from OpenRouter with a perfectly valid .env key). Keep override mode; do not remove.
- Models (verified 2026-09-08): `x-ai/grok-4-fast` is **deprecated** (404) → use `x-ai/grok-4.3`. Grok on OpenRouter has no live web access by default — grounding requires `plugins: [{ id: "web" }]` in the request body.
- `cachedFetch` refuses to cache error objects or empty arrays — 401s and LLM empty-grounding results would otherwise poison the 6h cache.

## Secrets

- `.env` holds all API keys; `.env`, `data/`, `ideabrowser_vault.json` are gitignored. Keep it that way.
- `HIKERAPI_API_KEY` (optional) — Instagram verification cascade tier 2 in `creator_scan.ts` (paid, pay-per-request, ~$0.60-$1.00/1K, no subscription). Only fires if this key is set; unset = tier 1 (free public-page parse, currently broken — IG serves a JS app shell) is the only attempt, degrading to "unknown - verify manually" same as before. Endpoint/schema unverified against a live key — confirm against hikerapi.com docs before first real use.
- Last verified engine status (2026-09-08, final): **all 5 OK** — Sonar (OpenRouter), Grok (grok-4.3 + web plugin), SerpAPI trends (free plan = 250 searches/mo), Exa, Brave. OpenRouter key validated via `GET /api/v1/auth/key`; SerpAPI via `serpapi.com/account`. First fully-green run: `data/run_2026-09-08T16-32-28-278Z/` (317 trends + grounded LLM payloads). Cache-hit behavior verified across consecutive runs.

## Pipeline discipline

Order is fixed: **harvest → GLM generates `candidates.json` → score**. Never reorder.

- `harvest.ts` `run()` fires exactly 5 sources: Sonar (OpenRouter), Grok (OpenRouter), SerpAPI trends, Exa, Brave. 
- `fetchSerpAdDensity()` and `fetchDecodo()` are exported from `harvest.ts` but **must NOT be called in `run()`** — they are per-candidate Phase 3 lookups consumed by `score.ts`.
- `score.ts` implements `Vs = (P*0.25) + (E*0.20) + (T*0.20) + (F*0.15) - (S*0.20)`, range -20..40. The saturation penalty is subtractive by design — do not revert to an additive-only formula.
- `score.ts --top=N` guards the SerpAPI budget (250/mo free): pre-ranks by P/E/T/F, runs live S-lookups (SerpAPI ad-density + Decodo evidence) only on the top N (default: all — always pass `--top` on the free plan).
- `score.ts` de-duplicates candidates (Jaccard token overlap > 0.85) **before** scoring.
- `data/cache/` is content-hash keyed, TTL 6h. To verify caching: run `pnpm harvest` twice within 6h — second run must log `cache hit:` lines.

## External services

- **Decodo = 3 separate products — do not conflate credentials:**
  1. **Residential proxy** (`gate.decodo.com:10001`, user:pass via `DECODO_RESIDENTIAL_*`) → used by `getinsight_id_br.ts` for raw HTML fetch + cheerio. Verified 2026-09-08: must use the **`https://` proxy scheme** (`--proxy https://gate.decodo.com:10001`); plain `http://` CONNECT is flaky/aborts. Session-suffix usernames (`user-session-x`) are rejected by this plan — use the plain username and retry instead.
  2. **Web Scraping API** (`scraper-api.decodo.com`, Basic auth via `DECODO_SCRAPING_API_AUTH`) → used by `harvest.ts` `fetchDecodo()`. Free tier is nearly exhausted — manual/Phase-3 invocation only, never in scheduled/repeated runs. Body must use `{ "url": ... }`, not `{ "query": ... }` (400 otherwise).
  3. **Fast Search API** (`DECODO_SEARCH_API_KEY`) → placeholder only, no function built; propose call shape before wiring into `harvest.ts`.
- **Bright Data** zone `yt_intel_prx1` is a **proxy zone** (port 33335, `brd-customer-...` user format), NOT a Scraping Browser/CDP zone. Do not attempt `connectOverCDP`/playwright against it.
- **ideabrowser.com — DEFERRED, Pro-tier gated.** Do not integrate or scrape. Decision 2026-09-08: Agent Connector = MCP + API key generated in logged-in dashboard, Hub data/MCP = Pro plan ($1499/yr); free plan = Business Coach connector only. Raw fetch is blocked by Vercel Security Checkpoint (HTTP 429 JS challenge — curl/cheerio get the shield page, 0 ideas). robots.txt allows `/database` but ToS §4 prohibits copy/redistribute. Revisit ONLY if harvest.ts output proves insufficient. Until then: manual occasional reads by user; `getinsight_id_br.ts` + Decodo residential stays in toolkit for other targets (Whop/Gumroad leaderboards) where no bot-challenge exists.
