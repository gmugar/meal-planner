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
