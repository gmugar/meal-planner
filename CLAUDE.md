# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Skillet** (repo name `meal-planner`) is a weekly meal-planning web app. There is **no build step, no framework, no package.json, and no test suite** — the entire application is one static file, `index.html`, served as-is. Deployed via **GitHub Pages** at the `gmugar.github.io` origin.

**Product shape — one weekly ritual plus a daily glance.** The UX is deliberately centered on a single hero flow: once a week the user runs the 3-step **Plan ritual** (Gather the week's menu → optionally set nights → Review list & copy), and the **copy is the terminal act** — the list gets pasted into DoorDash/Instacart, so there is no in-store checklist, no shopping progress, and no "shopping done" state. The rest of the week the user opens **Home ("This week")** and picks tonight's dinner from the menu. Users found assigning every meal to a day unhelpful: the menu is the plan, and pinning a meal to a night is optional (only for nights they already know). Discovery happens on the user's favorite recipe *websites* (via the source library + URL importer), not via scraped feeds — a scraper/inbox pipeline existed and was removed on purpose; don't reintroduce it.

## Running & deploying

- **Run locally:** serve the folder over HTTP (needed for Supabase/module loading, not just `file://`):
  ```bash
  python3 -m http.server 8000   # then open http://localhost:8000
  ```
- **Deploy the app:** push to `main`. GitHub Pages publishes `index.html`. There is no CI/build.
- **Deploy the Worker** (only when `worker/` changes): from `worker/`, `wrangler deploy`. Secrets (`GITHUB_TOKEN`, `APP_KEY`) are set once with `wrangler secret put` — see [worker/README.md](worker/README.md). The app does not need the Worker running to build or preview.

## Architecture

Everything below lives inside `index.html` (a `<style>` block at the top, then one large `<script>`, ~2100 lines total).

**Single global `state` object** is the whole app model:
`{ checked, favorites, calendar, menus, customRecipes, hidden }`.

**The week's plan is its menu:** `state.menus[weekKey]` (weekKey = that Monday's `dateKey`, see `shopWeekKey`) is the list of recipes gathered for the week, and it drives the shopping list. `state.calendar` (date → recipe ids) is both the pins and the history: a future date is a meal pinned to a known night; today or earlier means it was made then. "Any night" = menu minus that week's calendar ids (`getWeekBreakdown`). "Make tonight" on Home just writes `calendar[today]`. Weeks planned before menus existed have no `menus` entry, so `getMenu()` falls back to the week's calendar ids; call `ensureMenu(offset)` before removing calendar entries so a legacy meal isn't dropped from its week. Always read a week's plan through `getMenu`/`getWeekBreakdown`.

**Local-first sync engine** (`save()` → `persistLocal()` + debounced `flushToSupabase()`):
1. Every mutation calls `save()`, which stamps `localUpdatedAt = Date.now()`, writes `localStorage` synchronously (never dropped), and schedules a debounced flush.
2. The flush is **single-flight with a dirty flag** so rapid edits can't be lost, and upserts to Supabase table `meal_state`, **single row `id = 1`** (personal single-user app).
3. Incoming data (initial load or the realtime `postgres_changes` subscription) is applied **only if `updated_at` is strictly newer than `localUpdatedAt`** — last-write-wins. This is why our own echoes don't revert the UI and stale rows don't clobber newer offline edits. Don't reintroduce a "saving" flag to suppress echoes; the timestamp comparison is the mechanism.

⚠️ **Sync gotcha:** `hidden` is **device-local only** — deliberately not written to or read from Supabase. `applyRemote()` preserves the local value while overwriting everything else. `menus` syncs through its own jsonb column on `meal_state`; if that column is missing, `flushToSupabase` drops the field and retries (`syncMenusColumn`), and `applyRemote` keeps local menus when a row has none. If you add a field, decide explicitly whether it syncs (add it to the upsert + `applyRemote`) or stays local (preserve it like `hidden`). To sync a *flag* without a schema change, store it inside the `checked` map under a reserved key (legacy `shop-done:<weekKey>` keys are scrubbed on load).

**Views & navigation:** two tabs — **This week** (`home-view`, the default) and **Library** (`browse-view`). `list-view` (Review & copy) is a sub-surface reached from Home or the ritual; it renders a `← This week` back link and highlights the first tab. Home shows Tonight, Set nights, Any night (with "Make tonight"), and Made this week. There is no week grid or drag-and-drop editor; "Edit menu" reopens the ritual. `showView(name)` is the only navigation mechanism.

**The Plan ritual** is the wizard (`renderWizard` = step 1 Gather, `renderWizardStep2` = step 2 Set nights, which is optional, one meal per night; `wizardFinish` lands on `list-view` = step 3 Review & copy). `selectWeekAndPlan` seeds the menu from `menus[weekKey]`, or for a new week from its calendar plus the previous week's any-night leftovers (`wizardCarried`; their ingredients get pre-marked "have it" on finish). Gather shows the menu (`wizardPicked`), the searchable library with "last cooked Nw ago" hints (computed from past `state.calendar` entries — another reason removals keep past days), the **source sites** from `sources.json` (fetched at startup into `recipeSources`), and the URL importer. `confirmImport` drops an imported recipe straight into the basket when the wizard is open at step 1 (`wizardStep`). On finish the menu is saved, today-and-later calendar days are rebuilt from the pins, and past days (what was made) are left alone.

**Recipe model:** `RECIPES` (hardcoded array) is seeded into `state.customRecipes` by `seedRecipes()`. Deletions are **tombstones** (`deleted: true`) rather than removals, so a deleted seeded recipe never resurrects and the deletion syncs. `getAllRecipes()` returns `state.customRecipes.filter(r => !r.deleted)` — always use it, never `RECIPES` or raw `customRecipes`.

**Shopping list (Review & copy):** `getShoppingList(mealIds, weekKey)` builds week-scoped checkbox keys (`weekKey|recipeId|itemName`). Pass the week's menu (`getMenu(offset)`). Quantities are summed/converted to **imperial** for display (`toImperialQty`, `combineParsed`). ⚠️ **Checked means "already have it at home"**, not "purchased" — checked items are excluded from `copyShoppingList()`, which is the flow's terminal action. Don't add purchase-tracking semantics.

**Rendering:** `render()` rebuilds view HTML into container elements via `innerHTML`. All handlers are plain global `function` declarations wired through inline `onclick=` attributes — there is no component system or event delegation layer. After changing `state` in a handler, call `save()` then `render()`. `render()` preserves scroll; `showView` resets it.

**Config constants** live at the top of the script (~line 310): `SUPABASE_URL`, `SUPABASE_KEY` (the Supabase **anon** key — public by design for a static app), and the sources-sync settings. `landing.html` is a standalone marketing page with its own inline styles, unrelated to the app.

## Sources & the Worker

**`sources.json`** is the user's library of recipe websites (name, url, notes) surfaced in the Gather step — the notes are the user's own reminders of *what to look at* on each site. The app can edit the list and POST it to the Cloudflare Worker (`worker/worker.js`), which commits `sources.json` back to the repo via the GitHub API. The Worker is locked down: CORS restricted to `https://gmugar.github.io`, an optional `X-App-Key` header, and it only ever writes `sources.json` (sanitized, capped at 25 sources).

The *in-app* URL importer (`doImport` → `parseRecipeFromHtml`) fetches recipe pages through CORS proxies (`fetchHtmlViaProxies`) and parses JSON-LD `Recipe` data. This is the sole ingestion path for new recipes.
