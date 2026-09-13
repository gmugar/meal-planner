const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function section(start, end) {
  assert.ok(html.includes(start) && html.includes(end));
  return html.slice(html.indexOf(start), html.indexOf(end));
}
function run(source, globals = {}) {
  const ctx = vm.createContext(globals);
  vm.runInContext(source, ctx);
  return ctx;
}
test('inline application JavaScript parses', () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('imported decimals, fractions, and existing formats combine correctly', () => {
  const ctx = run(section('function parseQty(', '// Normalize an ingredient name'));
  for (const [input, expected] of [['1/2 cup', .5], ['1 1/2 cups', 1.5], ['1.5 lb', 1.5], ['0.5 kg', .5], ['.5 kg', .5], ['½ cup', .5], ['1½ cups', 1.5], ['3 x 3 oz', 9], ['500 g', 500]]) {
    assert.equal(ctx.parseQty(input).num, expected, input);
  }
  assert.equal(ctx.smartCombineQty('1/2 cup', '1/2 cup'), '1 cups');
  assert.equal(ctx.smartCombineQty('1.5 lb', '1.5 lb'), '3 lb');
  assert.equal(ctx.smartCombineQty('0.5 kg', '0.5 kg'), ctx.toImperialQty('1 kg'));
  for (const input of ['1/0 cup', '1-2 cups', 'to taste']) assert.equal(ctx.parseQty(input), null);
});
test('shopping list keeps the week selected by its caller', () => {
  const element = { classList: { remove() {}, add() {} } };
  const ctx = run(section('function showView(', 'function showToast('), {
    document: { querySelectorAll: () => [element, element], getElementById: () => element },
    window: { scrollTo() {} }, render() {}, calWeekOffset: 0, shopWeekOffset: 1
  });
  ctx.showView('list');
  assert.equal(ctx.shopWeekOffset, 1);
  ctx.shopWeekOffset = 3;
  ctx.showView('list');
  assert.equal(ctx.shopWeekOffset, 3);
});
test('day picker treats imported markup as text', () => {
  let inserted = '';
  const ctx = run(section('function esc(', '// Recipe source sites') + section('function wizardPickForDay(', 'function wizardFinish('), {
    document: { getElementById: () => null, body: { insertAdjacentHTML: (_, value) => inserted = value } },
    wizardAssignments: {}, wizardPicked: ['demo'],
    getAllRecipes: () => [{ id: 'demo', name: '<img src=x onerror="alert(1)">', servings: 4 }],
    dayName: () => 'Mon', fmtDate: () => 'Sep 14'
  });
  ctx.wizardPickForDay('2026-09-14');
  assert.ok(!inserted.includes('<img'));
  assert.ok(inserted.includes('&lt;img'));
});
test('reimport restores the original ID and active duplicates stay blocked', () => {
  let saved = 0, alerts = 0;
  const state = { customRecipes: [{ id: 'seed', url: 'https://example.com/recipe', deleted: true }] };
  const ctx = run(section('function confirmImport(', 'function deleteCustomRecipe('), {
    state, document: { getElementById: () => ({}) }, wizardStep: 1, wizardPicked: [],
    save() { saved++; }, alert() { alerts++; }, closeImportModal() {}, renderWizard() {}, showToast() {}, render() {}
  });
  const imported = { id: 'new', url: 'https://example.com/recipe', name: 'Dinner' };
  ctx.confirmImport(imported);
  assert.equal(state.customRecipes.length, 1);
  assert.equal(state.customRecipes[0].id, 'seed');
  assert.equal(state.customRecipes[0].deleted, false);
  assert.equal(ctx.wizardPicked[0], 'seed');
  assert.equal(saved, 1);
  ctx.confirmImport(imported);
  assert.equal(alerts, 1);
  assert.equal(saved, 1);
});

test('planning opens at the top and preserves position during a refresh', () => {
  let current = null;
  const ctx = run(section('function esc(', '// Recipe source sites') + section('function renderWizard(', '// Hide non-matching library rows'), {
    document: {
      getElementById: () => current,
      body: { insertAdjacentHTML() { current = { scrollTop: 0, scrollHeight: 2000, remove() {} }; } }
    },
    wizardWeekOffset: 1, wizardSearch: '', wizardPicked: [], recipeSources: [],
    state: { calendar: {}, favorites: [] }, getAllRecipes: () => [],
    getWeekDates: () => Array(7).fill(new Date('2026-09-14T12:00:00')),
    fmtDate: () => 'Sep 14', wizardBasketHtml: () => '', wizardNextBtnHtml: () => ''
  });
  ctx.renderWizard();
  assert.equal(current.scrollTop, 0);
  current.scrollTop = 400;
  current.scrollHeight = 1900;
  ctx.renderWizard();
  assert.equal(current.scrollTop, 500);
  current = null;
  ctx.renderWizard();
  assert.equal(current.scrollTop, 0);
});

test('URL retrieval advances after timeout and clears timers', async () => {
  let attempts = 0, cleared = 0;
  const ctx = run(section('async function fetchHtmlViaProxies(', '// Split a raw ingredient'), {
    AbortController,
    setTimeout(fn) { queueMicrotask(fn); return 1; },
    clearTimeout() { cleared++; },
    fetch: async (_, { signal }) => {
      attempts++;
      if (attempts === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))));
      return { ok: true, text: async () => '<html>Recipe</html>' };
    }
  });
  assert.equal(await ctx.fetchHtmlViaProxies('https://example.com/recipe'), '<html>Recipe</html>');
  assert.equal(attempts, 2);
  assert.equal(cleared, 2);
});

test('failed fetch offers manual entry; invalid URLs make no requests', async () => {
  const elements = Object.fromEntries(['import-url', 'import-status', 'import-preview-area', 'import-btn'].map(id => [id, { value: '', disabled: false }]));
  let requests = 0, fallbackURL;
  const ctx = run(section('async function doImport(', '// Keep the source link'), {
    URL, document: { getElementById: id => elements[id] },
    fetchRecipeHtml: async () => { requests++; return null; },
    showManualImport: url => { fallbackURL = url; }
  });
  elements['import-url'].value = 'javascript:alert(1)';
  await ctx.doImport();
  assert.equal(requests, 0);
  elements['import-url'].value = 'https://example.com/recipe';
  await ctx.doImport();
  assert.equal(fallbackURL, 'https://example.com/recipe');
  assert.equal(elements['import-btn'].disabled, false);
  assert.equal(elements['import-url'].disabled, false);
});

test('manual import validates ingredients and preserves source in preview and save', () => {
  const elements = Object.fromEntries(['import-manual-btn', 'import-name', 'import-servings', 'import-ingredients', 'import-status', 'import-url', 'import-btn'].map(id => [id, { value: '' }]));
  let preview, saved;
  const ctx = run(section('function esc(', '// Recipe source sites') + section('function showManualImport(', '// Fetch a page') + section('function splitQtyName(', 'function parseRecipeFromHtml('), {
    URL, document: { getElementById: id => elements[id] },
    showImportPreview: recipe => { preview = recipe; }, confirmImport: recipe => { saved = recipe; }
  });
  ctx.showManualImport('https://example.com/recipe', {});
  elements['import-manual-btn'].onclick();
  assert.equal(preview, undefined);
  elements['import-name'].value = 'Rice';
  elements['import-servings'].value = '2';
  elements['import-ingredients'].value = '2 cups rice';
  elements['import-manual-btn'].onclick();
  assert.equal(preview.url, 'https://example.com/recipe');
  assert.equal(preview.ingredients[0].items[0].qty, '2 cups');
  assert.equal(preview.servings, 2);
  assert.equal(saved, undefined);
  elements['import-btn'].onclick();
  assert.equal(saved, preview);
});

test('configured recipe service returns HTML and exposes actionable errors', async () => {
  let fail = false;
  const ctx = run(section('async function fetchRecipeHtml(', '// Fetch a page'), {
    RECIPE_FETCH_URL: 'https://skillet.example', URL, AbortController, setTimeout, clearTimeout,
    fetch: async address => {
      const endpoint = new URL(address);
      assert.equal(endpoint.origin, 'https://skillet.example');
      assert.equal(endpoint.pathname, '/recipe');
      assert.equal(endpoint.searchParams.get('url'), 'https://simplehomeedit.com/recipe/test/');
      return { ok: !fail, json: async () => fail ? { error: 'The recipe site returned HTTP 403.' } : { html: '<html>recipe</html>' } };
    }
  });
  assert.equal(await ctx.fetchRecipeHtml('https://simplehomeedit.com/recipe/test/'), '<html>recipe</html>');
  fail = true;
  await assert.rejects(ctx.fetchRecipeHtml('https://simplehomeedit.com/recipe/test/'), /HTTP 403/);
});
