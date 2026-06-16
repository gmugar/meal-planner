// Cloudflare Worker: writes the meal-planner's sources.json to GitHub.
// Secrets (set with `wrangler secret put`):
//   GITHUB_TOKEN  – fine-grained PAT with Contents: Read & Write on gmugar/meal-planner
//   APP_KEY       – (optional) shared key the app must send in X-App-Key
const REPO = "gmugar/meal-planner";
const FILE = "sources.json";
const BRANCH = "main";
const ALLOWED_ORIGIN = "https://gmugar.github.io";

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: cors });
    if (env.APP_KEY && req.headers.get("X-App-Key") !== env.APP_KEY)
      return new Response("Unauthorized", { status: 401, headers: cors });

    let sources;
    try {
      const body = await req.json();
      if (!Array.isArray(body.sources)) throw new Error("sources must be an array");
      sources = body.sources.slice(0, 25).map((s) => ({
        id: String(s.id || "").slice(0, 64),
        name: String(s.name || "").slice(0, 120),
        url: String(s.url || "").slice(0, 300),
        notes: String(s.notes || "").slice(0, 300),
        active: !!s.active,
      }));
    } catch (e) {
      return new Response("Bad request: " + e.message, { status: 400, headers: cors });
    }

    const api = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
    const ghHeaders = (extra = {}) => ({
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "meal-planner-sources-worker",
      ...extra,
    });

    let sha;
    const getRes = await fetch(`${api}?ref=${BRANCH}`, { headers: ghHeaders() });
    if (getRes.status === 200) sha = (await getRes.json()).sha;

    const json = JSON.stringify(sources, null, 2) + "\n";
    const content = btoa(unescape(encodeURIComponent(json)));
    const putRes = await fetch(api, {
      method: "PUT",
      headers: ghHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message: "Update recipe sources from app", content, sha, branch: BRANCH }),
    });
    if (!putRes.ok)
      return new Response("GitHub error: " + (await putRes.text()), { status: 502, headers: cors });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
