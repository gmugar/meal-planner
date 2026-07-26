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

**Two-tier persistence** — every mutation calls `save()` → `saveToSupabase()`:
1. Writes `state` to `localStorage['mealPlannerState']` synchronously (instant render / offline cache).
2. Upserts to a Supabase table `meal_state`, **single row `id = 1`** (this is a personal single-user app, not multi-tenant).
3. A realtime `postgres_changes` subscription pushes remote edits back into `state` and re-renders, so multiple devices stay in sync.

⚠️ **Sync gotcha:** `hidden` and `mealTypes` are **device-local only** — they are deliberately *not* written to or read from Supabase. Both `loadFromSupabase()` and the realtime handler preserve the local values while overwriting everything else. If you add a field, decide explicitly whether it syncs (add it to the `upsert` and both readers) or stays local (preserve it like `hidden`).

**Recipe model:**
- `RECIPES` (hardcoded array ~line 317) is seeded into `state.customRecipes` by `seedRecipes()` on load, so hardcoded and user-created recipes are unified and individually deletable. `getAllRecipes()` returns `state.customRecipes` — always use it rather than `RECIPES` directly.
- `INBOX_RECIPES` (~line 2018) is a separate curated "discovery" feed. The inbox shows 5 seeded weekly picks; dismissals are tracked in a separate key `localStorage['inboxDismissed']`, independent of `state`.

**Rendering:** `render()` rebuilds view HTML into container elements via `innerHTML`. All handlers are plain global `function` declarations wired through inline `onclick=` attributes — there is no component system or event delegation layer. After changing `state` in a handler, call `save()` then `render()`.

**Config constants** live at the top of the script (~line 310): `SUPABASE_URL`, `SUPABASE_KEY` (the Supabase **anon** key — public by design for a static app), and the sources-sync settings. `landing.html` is a standalone marketing page with its own inline styles, unrelated to the app.

## The sources / Worker flow

`sources.json` lists recipe source sites. The app can edit it in-place and POST the new list to the Cloudflare Worker (`worker/worker.js`), which commits `sources.json` back to `gmugar/meal-planner` via the GitHub API. A weekly scraper (external, not in this repo) reads `sources.json` to refresh recipes. The Worker is locked down: CORS restricted to `https://gmugar.github.io`, an optional `X-App-Key` header, and it only ever writes `sources.json` (payload sanitized and capped at 25 sources).
