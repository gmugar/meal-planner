const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../worker/recipe.js'), 'utf8').replace('export async function', 'async function');
function service(fetch, timers = {}) {
  const ctx = vm.createContext({ fetch, URL, Response, AbortController, TextDecoder, setTimeout, clearTimeout, ...timers });
  vm.runInContext(source, ctx);
  return (url, options = {}, env = {}) => ctx.fetchRecipe(new Request('https://service.example/recipe?url=' + encodeURIComponent(url), options), env);
}
const url = 'https://simplehomeedit.com/recipe/juicy-oven-baked-chicken-kebabs/';
test('returns HTML as JSON with CORS for Skillet', async () => {
  const run = service(async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, undefined);
    return new Response('<html>recipe</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  const res = await run(url, { headers: { Origin: 'https://gmugar.github.io' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://gmugar.github.io');
  assert.equal((await res.json()).html, '<html>recipe</html>');
});
test('rejects unsafe URLs and origins without fetching', async () => {
  const run = service(() => { throw new Error('must not fetch'); });
  for (const target of ['http://simplehomeedit.com/a', 'https://127.0.0.1/a', 'https://simplehomeedit.com.evil.example/a', 'https://user:password@simplehomeedit.com/a', 'https://simplehomeedit.com:8080/a', 'bad']) {
    assert.equal((await run(target)).status, 400, target);
  }
  assert.equal((await run(url, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await run(url, { method: 'POST' })).status, 405);
});
test('validates each redirect before following it', async () => {
  let requests = 0;
  const run = service(async () => { requests++; return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/admin' } }); });
  assert.equal((await run(url)).status, 400);
  assert.equal(requests, 1);
});
test('follows relative redirects and stops redirect loops', async () => {
  let requests = 0;
  const run = service(async target => {
    requests++;
    if (requests === 1) return new Response(null, { status: 301, headers: { Location: '/recipe/new/' } });
    assert.equal(target, 'https://simplehomeedit.com/recipe/new/');
    return new Response('recipe', { headers: { 'Content-Type': 'text/html' } });
  });
  assert.equal((await run(url)).status, 200);
  requests = 0;
  const loop = service(async () => { requests++; return new Response(null, { status: 302, headers: { Location: url } }); });
  assert.equal((await loop(url)).status, 502);
  assert.equal(requests, 4);
});
test('reports blocked pages, non-HTML responses, and oversized bodies', async () => {
  for (const [response, status] of [
    [new Response('blocked', { status: 403 }), 502],
    [new Response('{}', { headers: { 'Content-Type': 'application/json' } }), 422],
    [new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'text/html' } }), 413]
  ]) assert.equal((await service(async () => response)(url)).status, status);
});
test('times out hung upstream requests', async () => {
  const run = service((_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), {
    setTimeout(fn) { queueMicrotask(fn); return 1; }, clearTimeout() {}
  });
  const res = await run(url);
  assert.equal(res.status, 504);
  assert.equal((await res.json()).code, 'timeout');
});
