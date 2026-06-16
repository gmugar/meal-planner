# Meal Planner — sources sync Worker

A tiny Cloudflare Worker that lets the (static) meal-planner app save its recipe
**sources** back to the GitHub repo. The app POSTs the edited list here; the Worker
commits `sources.json` to `gmugar/meal-planner`. The weekly scraper then reads
`sources.json`, so in-app edits flow through with no manual step.

## One-time deploy

1. Install the CLI: `npm install -g wrangler`
2. Log in to Cloudflare (free account is fine): `wrangler login`
3. From this `worker/` folder, set the secrets:
   - `wrangler secret put GITHUB_TOKEN`
     Paste a **fine-grained** GitHub PAT scoped to `gmugar/meal-planner` with
     **Contents: Read and write**. (Make a fresh one for this — don't reuse the
     scraper's token.)
   - `wrangler secret put APP_KEY`  *(optional but recommended)*
     Any random string; the app sends it so random visitors can't write.
4. Deploy: `wrangler deploy`
5. Copy the printed URL, e.g. `https://meal-planner-sources.<you>.workers.dev`

## Wire it into the app

Send me the Worker URL (and the APP_KEY if you set one) and I'll drop them into
`index.html` (`SOURCES_SYNC_URL` / `SOURCES_SYNC_KEY`) and push — or set them yourself
at the top of the sources section in `index.html`.

## Security notes

- The Worker only ever writes `sources.json`, and sanitizes/caps the payload, so the
  blast radius is limited to "which sites get scraped."
- It only accepts requests from the app's origin and (if set) the APP_KEY.
- The GitHub token lives as a Cloudflare secret, never in the public page.
