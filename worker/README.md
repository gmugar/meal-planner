# Skillet Worker

Deployed origin: `https://meal-planner-sources.gmugar-skillet.workers.dev`.

The Worker serves two routes:

- `GET /recipe?url=<encoded HTTPS recipe URL>` fetches recipe HTML and returns
  `{ "html": "...", "url": "final URL" }` as JSON. The browser parses its recipe
  data without rendering the returned HTML.
- The existing POST handler saves the source list to GitHub. Its `GITHUB_TOKEN`
  and optional `APP_KEY` secrets are separate from the read-only recipe route.

Recipe fetching supports Simple Home Edit, Budget Bytes, and Half Baked Harvest
(including their `www` hosts). To add publishers, set the optional `RECIPE_HOSTS`
Worker variable to a comma-separated list of exact hostnames. This replaces the
built-in list. Only add trusted public recipe publishers. Each redirect is
validated against this list, HTTPS is required, and credentials and custom ports
are rejected. Requests have a 12-second deadline, three-redirect limit, and 2 MiB
body limit. Upstream error responses are returned as JSON errors rather than
recipe HTML. No GitHub credentials, browser cookies, or authorization headers
are sent to recipe sites.

CORS permits `https://gmugar.github.io` and local preview at port 8000. This is a
public read endpoint; CORS is not authentication. Publisher restrictions keep it
from being a general-purpose proxy. Some publishers can still deny server
requests; the app offers manual ingredient entry for these cases.

## Deploy and connect

From this directory:

```sh
npx wrangler login
npx wrangler deploy
```

Set `RECIPE_FETCH_URL` in `../index.html` to the Worker origin printed by deploy
(e.g. `https://meal-planner-sources.<account-subdomain>.workers.dev`). Then publish
the app via its normal GitHub Pages deployment. Until configured, the app uses
its legacy public proxies. No secret is needed by the recipe route.

For the optional source-saving route, configure `GITHUB_TOKEN` (fine-grained PAT
with Contents read/write on `gmugar/meal-planner`) and optionally `APP_KEY` using
`npx wrangler secret put NAME`. Existing deployed secrets are preserved.

## Verify

```sh
node --test ../tests/*.cjs
npx wrangler deploy --dry-run
npx wrangler dev --port 8787
```

For a local app preview, temporarily set `RECIPE_FETCH_URL` to
`http://localhost:8787` and serve the app on port 8000. Test a supported recipe
URL and verify title, servings, and ingredients before saving.
