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
test('set-nights step treats imported markup as text', () => {
  let inserted = '';
  const ctx = run(section('function esc(', '// Recipe source sites') + section('function renderWizardStep2(', 'function wizardBackToStep1('), {
    document: { getElementById: () => ({ remove() {}, scrollTop: 0 }), body: { insertAdjacentHTML: (_, value) => inserted = value } },
    wizardStep: 1, wizardWeekOffset: 1, wizardAssignments: {}, wizardMade: {}, wizardPicked: ['demo'],
    getAllRecipes: () => [{ id: 'demo', name: '<img src=x onerror="alert(1)">', servings: 4 }],
    getWeekDates: () => [new Date('2099-01-05T12:00:00')], dateKey: () => '2099-01-05',
    dayName: () => 'Monday', fmtDate: () => 'Jan 5'
  });
  ctx.renderWizardStep2();
  assert.ok(!inserted.includes('<img'));
  assert.ok(inserted.includes('&lt;img'));
});

// The week's menu: helpers run against the real date functions.
const menuSource = section('function getWeekDates(', 'function fmtDate(') + section('function getMealsForWeek(', 'function changeShopWeek(');
function menuCtx(state, extra = {}) {
  return run(menuSource + section('function getMenu(', 'function openRecipeDetail('), { state, save() {}, render() {}, ...extra });
}

test('week breakdown splits tonight, set nights, made, and any night', () => {
  const state = { calendar: {}, menus: {} };
  const ctx = menuCtx(state);
  const next = ctx.getWeekDates(1).map(ctx.dateKey), last = ctx.getWeekDates(-1).map(ctx.dateKey);
  state.menus[next[0]] = ['a', 'b', 'c'];
  state.calendar[next[4]] = ['b'];
  let wk = ctx.getWeekBreakdown(1);
  assert.deepEqual([...wk.anyNight], ['a', 'c']);
  assert.deepEqual([...wk.pinned.map(p => p.id)], ['b']);
  assert.equal(wk.made.length, 0);
  // A week planned before menus existed: its menu is what's on the calendar.
  state.calendar[last[1]] = ['x'];
  wk = ctx.getWeekBreakdown(-1);
  assert.deepEqual([...wk.made.map(m => m.id)], ['x']);
  assert.equal(wk.anyNight.length, 0);
  // Picking tonight moves a meal off any night; changing puts it back.
  const todayK = ctx.dateKey(new Date());
  state.menus[ctx.getWeekDates(0).map(ctx.dateKey)[0]] = ['p', 'q'];
  ctx.makeTonight('p');
  assert.deepEqual([...ctx.getWeekBreakdown(0).tonight], ['p']);
  assert.deepEqual([...ctx.getWeekBreakdown(0).anyNight], ['q']);
  ctx.unpinMeal(todayK, 'p', 0);
  assert.equal(state.calendar[todayK], undefined);
  assert.deepEqual([...ctx.getWeekBreakdown(0).anyNight], ['p', 'q']);
});

test('unpinning in a legacy week keeps the meal on the menu', () => {
  const state = { calendar: {}, menus: {} };
  const ctx = menuCtx(state);
  const next = ctx.getWeekDates(1).map(ctx.dateKey);
  state.calendar[next[2]] = ['legacy'];
  ctx.unpinMeal(next[2], 'legacy', 1);
  assert.deepEqual([...state.menus[next[0]]], ['legacy']);
  assert.deepEqual([...ctx.getWeekBreakdown(1).anyNight], ['legacy']);
});

test('finishing the ritual saves the menu, rebuilds pins, and keeps what was made', () => {
  const state = { calendar: {}, menus: {}, checked: {} };
  const base = menuCtx(state);
  const next = base.getWeekDates(1).map(base.dateKey), last = base.getWeekDates(-1).map(base.dateKey);
  state.calendar[next[0]] = ['old'];
  state.calendar[last[0]] = ['history'];
  let view;
  const ctx = run(menuSource + section('function wizardFinish(', '/* ── Write your own recipe'), {
    state, wizardWeekOffset: 1, wizardPicked: ['a', 'b', 'c'],
    wizardAssignments: { a: next[3], old: next[0] }, wizardMade: {}, wizardCarried: ['c'],
    getAllRecipes: () => [{ id: 'c', ingredients: [{ cat: 'Produce', items: [{ name: 'Onion', qty: '1' }] }] }],
    save() {}, closeWizard() {}, showView(v) { view = v; }, showToast() {}, shopWeekOffset: 0
  });
  ctx.wizardFinish();
  assert.deepEqual([...state.menus[next[0]]], ['a', 'b', 'c']);
  assert.deepEqual([...state.calendar[next[3]]], ['a']);
  assert.equal(state.calendar[next[0]], undefined, 'meals dropped from the menu leave their nights');
  assert.deepEqual([...state.calendar[last[0]]], ['history']);
  assert.equal(state.checked[next[0] + '|c|Onion'], true, 'carried-over ingredients are marked have');
  assert.equal(ctx.shopWeekOffset, 1);
  assert.equal(view, 'list');
});

test('a new week starts with last week\'s uneaten meals; a planned week keeps its menu', () => {
  const state = { calendar: {}, menus: {} };
  const base = menuCtx(state);
  const next = base.getWeekDates(1).map(base.dateKey), cur = base.getWeekDates(0).map(base.dateKey);
  state.menus[cur[0]] = ['ate', 'left', 'gone'];
  state.calendar[cur[0]] = ['ate'];
  const ctx = run(menuSource + section('function getMenu(', 'function openRecipeDetail(') + section('function selectWeekAndPlan(', '// Planning wizard'), {
    state, wizardWeekOffset: 0, wizardSearch: '', wizardPicked: [], wizardCarried: [], wizardAssignments: {}, wizardMade: {},
    getAllRecipes: () => [{ id: 'ate' }, { id: 'left' }],
    closeWeekPicker() {}, renderWizard() {}
  });
  ctx.selectWeekAndPlan(1);
  assert.deepEqual([...ctx.wizardPicked], ['left']);
  assert.deepEqual([...ctx.wizardCarried], ['left']);
  state.menus[next[0]] = ['chosen'];
  state.calendar[next[2]] = ['chosen'];
  ctx.selectWeekAndPlan(1);
  assert.deepEqual([...ctx.wizardPicked], ['chosen']);
  assert.equal(ctx.wizardCarried.length, 0);
  assert.equal(ctx.wizardAssignments.chosen, next[2]);
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
  const ctx = run(section('function esc(', '// Recipe source sites') + section('/* ── Library ordering', 'function getCardBorderClass(') + section('function renderWizard(', '// Hide non-matching library rows'), {
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

test('written recipe needs a title and ingredients, but directions are optional', () => {
  let saves = 0;
  const state = { customRecipes: [{ id: 'deleted', url: '', deleted: true }] };
  const fields = Object.fromEntries(['text-name', 'text-servings', 'text-ingredients', 'text-instructions', 'import-status'].map(id => [id, {value: ''}]));
  const ctx = run(section('function saveTextImport(', '/* ── Recipe import from URL') + section('function splitQtyName(', 'function parseRecipeFromHtml(') + section('function confirmImport(', 'function deleteCustomRecipe('), {
    state, crypto: require('node:crypto').webcrypto,
    document: { getElementById: id => fields[id] },
    save() { saves++; }, closeImportModal() {}, showToast() {}, render() {}, alert() { assert.fail('Unrelated written recipes are not duplicates'); }
  });
  ctx.saveTextImport();
  fields['text-name'].value = 'No ingredients';
  ctx.saveTextImport();
  assert.equal(saves, 0);
  fields['text-name'].value = 'Lemon rice';
  fields['text-ingredients'].value = '1½ cups rice\n1 lemon';
  ctx.saveTextImport();
  fields['text-name'].value = 'Another recipe';
  fields['text-instructions'].value = 'Cook for 20 minutes.';
  fields['text-servings'].value = '2.5';
  ctx.saveTextImport();
  assert.equal(saves, 1);
  fields['text-servings'].value = '2';
  ctx.saveTextImport();
  assert.equal(saves, 2);
  assert.equal(state.customRecipes[1].servings, 4);
  assert.equal(state.customRecipes[2].servings, 2);
  assert.equal(state.customRecipes.length, 3);
  assert.equal(state.customRecipes[0].deleted, true);
  assert.equal(state.customRecipes[1].instructions, '');
  assert.equal(state.customRecipes[2].instructions, 'Cook for 20 minutes.');
  assert.equal(state.customRecipes[1].ingredients.flatMap(g => g.items).find(i => i.name === 'rice').qty, '1½ cups');
  assert.notEqual(state.customRecipes[1].id, state.customRecipes[2].id);
});
test('library sorts by rotation: favorites, due, not made, then recently made', () => {
  const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const state = { favorites: ['fav'], calendar: { [day(40)]: ['old', 'fav'], [day(21)]: ['mid'], [day(3)]: ['recent'], [day(-2)]: ['fresh'] } };
  const ctx = run(section('/* ── Library ordering', 'function getCardBorderClass('), { state });
  const recipes = ['recent', 'mid', 'fresh', 'fav', 'old', 'new'].map((id, i) => ({ id, name: id, tags: i % 2 ? ['one-pan'] : [], added: id === 'new' ? '2026-09-01' : '' }));
  const groups = ctx.libraryGroups(recipes, ctx.getLastCooked());
  assert.equal(JSON.stringify(groups.map(g => [g.key, g.items.map(r => r.id)])), JSON.stringify([['fav', ['fav']], ['due', ['old', 'mid']], ['fresh', ['new', 'fresh']], ['recent', ['recent']]]));
  assert.ok(!ctx.tagChipsHtml(recipes, '', 'f').includes('gluten-free'));
  assert.ok(ctx.tagChipsHtml(recipes, 'one-pan', 'f').includes('filter-chip on'));
});
test('A–Z sort keeps favorites pinned and ignores cook history', () => {
  const state = { favorites: ['z'], calendar: {} };
  const ctx = run(section('/* ── Library ordering', 'function getCardBorderClass('), { state });
  const recipes = ['b', 'z', 'C', 'a'].map(id => ({ id, name: id, tags: [] }));
  const groups = ctx.libraryGroups(recipes, { b: new Date() }, 'az');
  assert.equal(JSON.stringify(groups.map(g => [g.key, g.items.map(r => r.id)])), JSON.stringify([['fav', ['z']], ['all', ['a', 'b', 'C']]]));
});
test('Most cooked sort ranks by times made, ties by most recent', () => {
  const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const state = { favorites: ['f'], calendar: { [day(30)]: ['a', 'b'], [day(20)]: ['a'], [day(10)]: ['c'], [day(5)]: ['b'], [day(-1)]: ['a', 'n'] } };
  const ctx = run(section('/* ── Library ordering', 'function getCardBorderClass('), { state });
  const counts = ctx.getCookCounts();
  assert.equal(counts.a, 2);
  assert.equal(counts.n, undefined);
  const recipes = ['c', 'a', 'n', 'b', 'f'].map(id => ({ id, name: id, tags: [] }));
  const groups = ctx.libraryGroups(recipes, ctx.getLastCooked(), 'cooked', counts);
  assert.equal(JSON.stringify(groups.map(g => [g.key, g.items.map(r => r.id)])), JSON.stringify([['fav', ['f']], ['cooked', ['b', 'a', 'c']], ['fresh', ['n']]]));
});
