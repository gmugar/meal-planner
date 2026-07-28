# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Skillet** (repo name `meal-planner`) is a weekly meal-planning web app. There is **no build step, no framework, no package.json, and no test suite** — the entire application is one static file, `index.html`, served as-is. Deployed via **GitHub Pages** at the `gmugar.github.io` origin.

## Running & deploying

- **Run locally:** serve the folder over HTTP (needed for Supabase/module loading, not just `file://`):
  ```bash
  python3 -m http.server 8000   # then open http://localhost:8000
  ```
- **Deploy the app:** push to `main`. GitHub Pages publishes `index.html`. There is no CI/build.
- **Deploy the Worker** (only when `worker/` changes): from `worker/`, `wrangler deploy`. Secrets (`GITHUB_TOKEN`, `APP_KEY`) are set once with `wrangler secret put` — see [worker/README.md](worker/README.md). The app does not need the Worker running to build or preview.

## Architecture

Everything below lives inside `index.html` (a `<style>` block at the top, then one large `<script>`, ~2100 lines total).

**Single global `state` object** (defined ~line 475) is the whole app model:
`{ selected, checked, favorites, calendar, customRecipes, mealTypes, hidden }`.

**Local-first sync engine** (`save()` → `persistLocal()` + debounced `flushToSupabase()`):
1. Every mutation calls `save()`, which stamps `localUpdatedAt = Date.now()`, writes `localStorage` synchronously (never dropped), and schedules a debounced flush.
2. The flush is **single-flight with a dirty flag** so rapid edits can't be lost, and upserts to Supabase table `meal_state`, **single row `id = 1`** (personal single-user app).
3. Incoming data (initial load or the realtime `postgres_changes` subscription) is applied **only if `updated_at` is strictly newer than `localUpdatedAt`** — last-write-wins. This is why our own echoes don't revert the UI and stale rows don't clobber newer offline edits. Don't reintroduce a "saving" flag to suppress echoes; the timestamp comparison is the mechanism.

⚠️ **Sync gotcha:** `hidden` and `mealTypes` are **device-local only** — deliberately not written to or read from Supabase. `applyRemote()` preserves the local values while overwriting everything else. If you add a field, decide explicitly whether it syncs (add it to the upsert + `applyRemote`) or stays local (preserve it like `hidden`). To sync a *flag* without a schema change, store it inside the `checked` map under a reserved key — that's how per-week "shopping done" works (`shop-done:<weekKey>`).

**Recipe model:**
- `RECIPES` (hardcoded array) is seeded into `state.customRecipes` by `seedRecipes()`. Deletions are **tombstones** (`deleted: true`) rather than removals, so a deleted seeded recipe never resurrects and the deletion syncs. `getAllRecipes()` returns `state.customRecipes.filter(r => !r.deleted)` — always use it, never `RECIPES` or raw `customRecipes`.
- The **inbox** draws from `inboxPool`, which starts as the hardcoded `INBOX_RECIPES` and is replaced/augmented at startup by `inbox.json` (see the weekly pipeline below). Shows 5 deterministic weekly picks (seeded by `hashStr(id + '|' + week)`); dismissals live in `localStorage['inboxDismissed']`. Recipes added from the inbox reuse feed ingredients when present, else fetch them via the CORS-proxy importer.

**Shopping list:** `getShoppingList(mealIds, weekKey)` builds week-scoped checkbox keys (`weekKey|recipeId|itemName`). Pass **occurrences** (`getMealOccurrences`, one id per planned day) not the deduped set, so a recipe on two days doubles. Quantities are summed/converted to **imperial** for display (`toImperialQty`, `combineParsed`).

**Rendering:** `render()` rebuilds view HTML into container elements via `innerHTML`. All handlers are plain global `function` declarations wired through inline `onclick=` attributes — there is no component system or event delegation layer. After changing `state` in a handler, call `save()` then `render()`.

**Config constants** live at the top of the script (~line 310): `SUPABASE_URL`, `SUPABASE_KEY` (the Supabase **anon** key — public by design for a static app), and the sources-sync settings. `landing.html` is a standalone marketing page with its own inline styles, unrelated to the app.

## The weekly inbox pipeline (sources → scraper → inbox.json → app)

The inbox's "fresh dinners" genuinely refresh each week via this loop:

1. **`sources.json`** lists recipe source sites. The app can edit it in-place and POST the new list to the Cloudflare Worker (`worker/worker.js`), which commits `sources.json` back to the repo via the GitHub API. The Worker is locked down: CORS restricted to `https://gmugar.github.io`, an optional `X-App-Key` header, and it only ever writes `sources.json` (sanitized, capped at 25 sources).
2. **`scripts/scrape-inbox.mjs`** (dependency-free Node 20, run by the **`.github/workflows/scrape-inbox.yml`** Action on a weekly cron + manual dispatch) reads `sources.json`, pulls each active site's RSS feed (`<site>/feed/`), fetches recent posts, parses JSON-LD `Recipe` data into the app's inbox schema, and writes **`inbox.json`**. Run it locally with `node scripts/scrape-inbox.mjs`.
3. The app fetches `inbox.json` at startup (`loadInboxFeed()`) and merges it into `inboxPool` ahead of the hardcoded list, deduped by name. If the fetch fails, it silently falls back to the built-in `INBOX_RECIPES`.

Server-side scraping (the Action) can fetch source sites directly; the *in-app* importer must go through CORS proxies (`fetchHtmlViaProxies`) because the browser can't. Both share the same JSON-LD → recipe parsing shape.
