#!/usr/bin/env node
/**
 * Weekly inbox scraper for Skillet.
 *
 * Reads sources.json, pulls recent posts from each active site's RSS feed,
 * fetches each post, and extracts a recipe from its JSON-LD structured data.
 * Writes the results to inbox.json in the app's inbox schema. The app loads
 * inbox.json at startup (falling back to its hardcoded list), so this is what
 * makes the weekly "fresh dinners" genuinely refresh.
 *
 * Dependency-free: Node 20+ global fetch + regex parsing. Run via the
 * scrape-inbox GitHub Action (weekly cron) or locally with `node scripts/scrape-inbox.mjs`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (compatible; SkilletInboxBot/1.0; +https://github.com/gmugar/meal-planner)';
const PER_SITE = 8;           // max recipes kept per source
const FEED_ITEMS = 20;        // max recent posts inspected per feed
const REQUEST_TIMEOUT = 15000;

/* ── tiny helpers ── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripHtml(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

/* ── recipe field parsing (mirrors the app's importer) ── */
function splitQtyName(raw) {
  const ing = stripHtml(raw);
  const m = ing.match(/^([\d¼½¾⅓⅔⅛\s\/\.\-]+(?:\s*(?:cup|cups|tbsp|tsp|oz|lb|lbs|pound|pounds|g|kg|ml|L|clove|cloves|can|cans|bunch|head|large|medium|small|pinch|dash|to taste|tablespoon|tablespoons|teaspoon|teaspoons|ounce|ounces|slice|slices|piece|pieces)s?)?)\s+(.+)/i);
  return m ? { name: m[2].trim(), qty: m[1].trim() } : { name: ing, qty: '' };
}

const CAT_RULES = {
  Meat: /\b(chicken|beef|pork|lamb|turkey|bacon|sausage|steak|ground|mince|ham|prosciutto|salami|pepperoni|shrimp|prawns|salmon|tuna|fish|cod|tilapia|crab|lobster|scallop|meatball|chorizo|duck|veal|brisket|ribs)\b/i,
  Produce: /\b(garlic|onion|tomato|lettuce|spinach|kale|carrot|celery|pepper|potato|broccoli|cauliflower|zucchini|squash|cucumber|avocado|mushroom|corn|pea|cabbage|ginger|lemon|lime|orange|apple|banana|berry|basil|cilantro|parsley|mint|dill|thyme|rosemary|scallion|shallot|jalapen|chili|chilli|arugula|radish|beet|asparagus|eggplant|artichoke|leek|fennel)\b/i,
  Dairy: /\b(cheese|milk|cream|butter|yogurt|sour cream|mozzarella|parmesan|cheddar|feta|ricotta|gouda|brie|egg|eggs|mascarpone)\b/i,
  Pantry: /\b(oil|vinegar|soy sauce|tamari|ketchup|mustard|mayo|honey|sugar|flour|bread|tortilla|wrap|rice|pasta|noodle|broth|stock|sauce|sriracha|hoisin|teriyaki|peanut butter|maple|cornstarch|coconut milk|tomato paste|passata|can|canned|dried|bean|lentil|chickpea)\b/i,
  Spices: /\b(salt|pepper|paprika|cumin|oregano|cinnamon|nutmeg|cayenne|chili powder|garlic powder|onion powder|turmeric|coriander|cardamom|clove|bay leaf|bay leaves|italian seasoning|taco seasoning|curry|garam masala|red pepper flake|sesame seed|vanilla|extract)\b/i
};
function autoCategorize(items) {
  const cats = {}, other = [];
  for (const item of items) {
    let matched = false;
    for (const [cat, rx] of Object.entries(CAT_RULES)) {
      if (rx.test(item.name)) { (cats[cat] ||= []).push(item); matched = true; break; }
    }
    if (!matched) other.push(item);
  }
  const out = [];
  for (const cat of ['Meat', 'Produce', 'Dairy', 'Pantry', 'Spices']) if (cats[cat]) out.push({ cat, items: cats[cat] });
  if (other.length) out.push({ cat: 'Other', items: other });
  return out;
}

function detectTags(text) {
  const t = text.toLowerCase(), tags = [];
  if (t.includes('dairy-free') || t.includes('dairy free')) tags.push('dairy-free');
  if (t.includes('gluten-free') || t.includes('gluten free')) tags.push('gluten-free');
  if (t.includes('one-pan') || t.includes('one pan') || t.includes('sheet pan') || t.includes('skillet')) tags.push('one-pan');
  if (t.includes('one-pot') || t.includes('one pot')) tags.push('one-pot');
  if (t.includes('fakeaway') || t.includes('takeout') || t.includes('take-out')) tags.push('fakeaway');
  return [...new Set(tags)];
}

/* ── extract a Recipe object from a page's JSON-LD ── */
function findRecipeLD(html) {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const candidates = [];
    const push = (d) => { if (d && typeof d === 'object') candidates.push(d); };
    if (Array.isArray(data)) data.forEach(push);
    else { push(data); if (Array.isArray(data['@graph'])) data['@graph'].forEach(push); }
    for (const c of candidates) {
      const type = c['@type'];
      const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
      if (isRecipe) return c;
    }
  }
  return null;
}

function buildRecipe(ld, url, siteName, sourceId) {
  const name = stripHtml(ld.name);
  if (!name) return null;
  const rawIng = ld.recipeIngredient || ld.ingredients || [];
  if (!Array.isArray(rawIng) || rawIng.length === 0) return null; // require ingredients
  const items = rawIng.map(splitQtyName).filter((i) => i.name);
  let yield_ = ld.recipeYield;
  if (Array.isArray(yield_)) yield_ = yield_[0];
  const servings = parseInt(yield_, 10) || 4;
  const keywords = Array.isArray(ld.keywords) ? ld.keywords.join(' ') : (ld.keywords || '');
  const cats = [].concat(ld.recipeCategory || []).join(' ');
  const cuisines = [].concat(ld.recipeCuisine || []).join(' ');
  const slug = (new URL(url).pathname.replace(/\/+$/,'').split('/').pop() || 'recipe').slice(0, 60);
  return {
    id: 'feed_' + sourceId + '_' + slug,
    name,
    site: siteName,
    url,
    desc: stripHtml(ld.description).slice(0, 200),
    tags: detectTags([name, stripHtml(ld.description), keywords, cats, cuisines].join(' ')),
    servings,
    ingredients: autoCategorize(items)
  };
}

/* ── RSS discovery ── */
function feedUrl(siteUrl) {
  return siteUrl.replace(/\/+$/, '') + '/feed/';
}
function extractPostLinks(xml) {
  const links = [];
  for (const item of xml.matchAll(/<item[\s\S]*?<\/item>/gi)) {
    const block = item[0];
    const link = block.match(/<link>([\s\S]*?)<\/link>/i);
    if (link) links.push(decodeEntities(link[1]).trim());
  }
  return links.slice(0, FEED_ITEMS);
}

/* ── main ── */
async function scrapeSource(source) {
  const out = [];
  const xml = await fetchText(feedUrl(source.url));
  if (!xml) { console.warn(`  ! no feed for ${source.name}`); return out; }
  const links = extractPostLinks(xml);
  console.log(`  ${source.name}: ${links.length} recent posts`);
  for (const link of links) {
    if (out.length >= PER_SITE) break;
    const html = await fetchText(link);
    await sleep(300); // be polite
    if (!html) continue;
    const ld = findRecipeLD(html);
    if (!ld) continue;
    const recipe = buildRecipe(ld, link, source.name, source.id);
    if (recipe) out.push(recipe);
  }
  console.log(`  ${source.name}: kept ${out.length} recipes`);
  return out;
}

async function main() {
  const sources = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));
  const active = sources.filter((s) => s.active);
  console.log(`Scraping ${active.length} active source(s)...`);

  const all = [];
  for (const source of active) {
    try { all.push(...await scrapeSource(source)); }
    catch (e) { console.warn(`  ! ${source.name} failed: ${e.message}`); }
  }

  // Dedup by name (keep first occurrence).
  const seen = new Set(), recipes = [];
  for (const r of all) {
    const k = r.name.toLowerCase().trim();
    if (seen.has(k)) continue;
    seen.add(k);
    recipes.push(r);
  }

  if (recipes.length === 0) {
    console.error('No recipes scraped — leaving inbox.json unchanged.');
    process.exit(1);
  }

  const payload = { generatedAt: new Date().toISOString(), count: recipes.length, recipes };
  await writeFile(join(ROOT, 'inbox.json'), JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote inbox.json with ${recipes.length} recipes.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
