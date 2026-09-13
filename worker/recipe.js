// Only fetch recipe publishers, never arbitrary hosts or redirect destinations.
const DEFAULT_HOSTS = ['simplehomeedit.com', 'www.simplehomeedit.com', 'budgetbytes.com', 'www.budgetbytes.com', 'halfbakedharvest.com', 'www.halfbakedharvest.com'];
const MAX_BYTES = 2 * 1024 * 1024;

export async function fetchRecipe(req, env) {
  const allowedOrigins = ['https://gmugar.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
  const origin = req.headers.get('Origin');
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  if (allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  const reply = (status, error, code) => Response.json({ error, code }, { status, headers });
  if (origin && !allowedOrigins.includes(origin)) return reply(403, 'This app origin is not allowed.', 'origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  if (req.method !== 'GET') return reply(405, 'Use GET for recipe imports.', 'method');
  const hosts = new Set(env.RECIPE_HOSTS ? env.RECIPE_HOSTS.split(',').map(h => h.trim().toLowerCase()).filter(Boolean) : DEFAULT_HOSTS);
  function validate(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.has(url.hostname)) throw new Error('unsupported');
    url.hash = '';
    return url;
  }
  let target;
  try { target = validate(new URL(req.url).searchParams.get('url')); }
  catch (_) { return reply(400, 'Use an HTTPS recipe URL from a supported recipe site.', 'unsupported_url'); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(target.href, {
        redirect: 'manual', signal: controller.signal,
        headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': 'Skillet-Recipe-Importer/1.0' }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('Location');
        if (!location || redirects === 3) return reply(502, 'The recipe page redirected too many times or without a destination.', 'redirect');
        try { target = validate(new URL(location, target).href); }
        catch (_) { return reply(400, 'The recipe redirected to an unsupported site.', 'unsupported_redirect'); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return reply(502, `The recipe site returned HTTP ${response.status}. You can paste the ingredients instead.`, 'upstream');
      }
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('Content-Type') || '')) {
        await response.body?.cancel();
        return reply(422, 'That address did not return a recipe web page.', 'content_type');
      }
      const reader = response.body?.getReader();
      if (!reader) return reply(422, 'The recipe page was empty.', 'empty');
      const decoder = new TextDecoder();
      let html = '', size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          return reply(413, 'This recipe page is too large. Paste the ingredients instead.', 'too_large');
        }
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      return new Response(JSON.stringify({ html, url: target.href }), { headers });
    }
  } catch (_) {
    return reply(controller.signal.aborted ? 504 : 502,
      controller.signal.aborted ? 'The recipe site took too long to respond. Try again or paste the ingredients.' : 'The recipe site could not be reached. Try again or paste the ingredients.',
      controller.signal.aborted ? 'timeout' : 'network');
  } finally { clearTimeout(timeout); }
}
