#!/usr/bin/env node
// ORACLE price pipeline. TCGplayer prices via TCGCSV (https://tcgcsv.com), which asks for:
//   - at most one sync per day, from a backend (never from the user-facing app)
//   - a custom User-Agent, ~100 ms between requests
//   - archives downloaded once and kept (they never change)
//
//   node sync.mjs backfill   one-time: every archived day since 2024-02-08 (kept forever in cache/days)
//   node sync.mjs daily      today's prices + product names from the live API (skips if TCGCSV hasn't updated)
//   node sync.mjs build      FULL rebuild of public/prices from every cached day (this PC)
//   node sync.mjs update     INCREMENTAL: add the newest cached day to an existing public/prices (GitHub Action)
//   node sync.mjs action     daily + update   (what the scheduled GitHub Action runs)
//   node sync.mjs all        daily + build    (local equivalent)
//
// public/prices/  meta.json · latest/<pid%256>.json · hist/<pid%1024>.json · movers.json · products.json.gz (Action state)
//
// cache/days/<YYYY-MM-DD>.tsv.gz  — one line per product+finish:
//   pid \t sub \t market \t low \t mid \t directLow \t high   (cents, 0 = none; sub: N=Normal, F=Foil, else TCGplayer's name)
// Every archived day is kept so we never need to re-download.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UA = 'OraclePriceSync/1.0 (personal deck-builder price history)';
const BASE = 'https://tcgcsv.com';
const CAT = 1; // Magic: The Gathering
const ARCHIVE_START = '2024-02-08';
const DAILY_WINDOW = 90;
const LATEST_SHARDS = 256;
const HIST_SHARDS = 1024;
const DAYS = process.env.DAYS_DIR || path.join(ROOT, 'cache', 'days');
const ARCH = path.join(ROOT, 'cache', 'archives');
const PUB = process.env.PUBLIC_DIR || path.join(ROOT, 'public');
const OUT = path.join(PUB, 'prices');
const PRODUCTS = path.join(OUT, 'products.json.gz');
fs.mkdirSync(DAYS, { recursive: true }); fs.mkdirSync(ARCH, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a);
const cents = v => (v == null || !Number.isFinite(+v)) ? 0 : Math.round(+v * 100);
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

async function get(url, { binary = false, tries = 4 } = {}) {
  let throttles = 0;
  for (let i = 1; i <= tries; i++) {
    const r = await fetch(url, { headers: { 'user-agent': UA } }).catch(e => ({ ok: false, status: 0, err: e }));
    if (r.ok) return binary ? Buffer.from(await r.arrayBuffer()) : r.json();
    if (r.status === 404 || r.status === 403) return null;
    // TCGCSV throttles an IP for ~10 min when it's asked too fast: wait it out, don't hammer.
    if (r.status === 429 && throttles < 6) {
      throttles++; i--;
      const ra = +(r.headers && r.headers.get && r.headers.get('retry-after')) || 0;
      const wait = Math.max(ra * 1000, 10.5 * 60 * 1000);
      log(`  throttled (429) — pausing ${Math.round(wait / 60000)} min before retrying`);
      await sleep(wait);
      continue;
    }
    if (i < tries) await sleep(i * 3000); else throw new Error(`GET ${url} → ${r.status || r.err}`);
  }
}

function rowsToTsv(rows) {
  const lines = [];
  for (const p of rows) {
    if (!p || !p.productId) continue;
    const st = p.subTypeName || 'Normal';
    const sub = st === 'Normal' ? 'N' : st === 'Foil' ? 'F' : st.replace(/\s+/g, '_');
    const vals = [cents(p.marketPrice), cents(p.lowPrice), cents(p.midPrice), cents(p.directLowPrice), cents(p.highPrice)];
    if (!vals.some(Boolean)) continue;
    lines.push([p.productId, sub, ...vals].join('\t'));
  }
  return lines;
}
function writeDay(date, lines) {
  fs.writeFileSync(path.join(DAYS, date + '.tsv.gz'), zlib.gzipSync(lines.join('\n') + '\n', { level: 9 }));
}
const haveDay = d => fs.existsSync(path.join(DAYS, d + '.tsv.gz'));

// ---------- backfill from archives ----------
function sevenZip() {
  const p = execFileSync(process.execPath, ['-e', "process.stdout.write(require('7zip-bin').path7za)"], { cwd: ROOT }).toString();
  try { fs.chmodSync(p, 0o755); } catch {}
  return p;
}
export function backfillDates(today = iso(new Date())) {
  const out = [];
  // every day TCGCSV has archived — fetched once, kept forever
  for (let d = ARCHIVE_START; d < today; d = addDays(d, 1)) out.push(d);
  return out;
}
// Several workers can run at once: each claims a day with an exclusive lock file before
// touching it (a dead worker's claims are released), so no day is fetched twice.
//   BACKFILL_FROM=YYYY-MM-DD   start here (default: archive start / newest when reversed)
//   BACKFILL_REVERSE=1         walk toward older days
const LOCKS = path.join(ROOT, 'cache', 'locks');
function claim(d) {
  fs.mkdirSync(LOCKS, { recursive: true });
  const f = path.join(LOCKS, d);
  try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return true; }
  catch {
    const pid = +fs.readFileSync(f, 'utf8');
    try { process.kill(pid, 0); return false; } // owner still alive
    catch { fs.writeFileSync(f, String(process.pid)); return true; } // stale: take it over
  }
}
const release = d => fs.rmSync(path.join(LOCKS, d), { force: true });
async function backfill() {
  const z = sevenZip();
  let dates = backfillDates().filter(d => !haveDay(d));
  const from = process.env.BACKFILL_FROM;
  if (process.env.BACKFILL_REVERSE) { dates.reverse(); if (from) dates = dates.filter(d => d <= from); }
  else if (from) dates = dates.filter(d => d >= from);
  log(`backfill worker ${process.pid}: ${dates.length} day(s) in range${from ? ' from ' + from : ''}${process.env.BACKFILL_REVERSE ? ' (newest first)' : ''}`);
  let n = 0;
  for (const d of dates) {
    if (haveDay(d) || !claim(d)) continue;
    try {
      const file = path.join(ARCH, `prices-${d}.ppmd.7z`);
      if (!fs.existsSync(file)) {
        const buf = await get(`${BASE}/archive/tcgplayer/prices-${d}.ppmd.7z`, { binary: true });
        if (!buf) { log(`  ${d}: no archive`); continue; }
        fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file); // never leave a half archive
        await sleep(1000); // be gentle: archives are a few MB each
      }
      const tmp = path.join(ROOT, 'cache', 'x-' + d);
      fs.rmSync(tmp, { recursive: true, force: true });
      execFileSync(z, ['x', '-y', '-o' + tmp, file, `${d}/${CAT}/*`, '-r'], { stdio: 'ignore' });
      const catDir = path.join(tmp, d, String(CAT));
      const lines = [];
      if (fs.existsSync(catDir)) for (const g of fs.readdirSync(catDir)) {
        const f = path.join(catDir, g, 'prices');
        if (!fs.existsSync(f)) continue;
        try { lines.push(...rowsToTsv(JSON.parse(fs.readFileSync(f, 'utf8')).results || [])); } catch {}
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      if (lines.length) {
        const out = path.join(DAYS, d + '.tsv.gz');
        fs.writeFileSync(out + '.part', zlib.gzipSync(lines.join('\n') + '\n', { level: 9 })); fs.renameSync(out + '.part', out);
        n++; log(`  ${d}: ${lines.length} prices`);
      }
      // The converted day file is our permanent record (backed up to Releases); the raw 7z can go.
      fs.rmSync(file, { force: true });
    } finally { release(d); }
  }
  log(`backfill worker ${process.pid} done: ${n} day(s) added`);
}

// ---------- daily from live API ----------
function readProducts() {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(PRODUCTS))); } catch { return { groups: {}, p: {} }; }
}
function writeProducts(prod) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(PRODUCTS, zlib.gzipSync(JSON.stringify(prod), { level: 9 }));
}
// Names for movers. Only sets whose TCGCSV modifiedOn moved are refetched.
async function refreshProducts(groups) {
  const prod = readProducts();
  let n = 0;
  for (const g of groups) {
    const prev = prod.groups[g.groupId];
    prod.groups[g.groupId] = { mod: g.modifiedOn, abbr: g.abbreviation || '', name: g.name };
    if (prev && prev.mod === g.modifiedOn) continue;
    const j = await get(`${BASE}/tcgplayer/${CAT}/${g.groupId}/products`);
    for (const p of (j && j.results) || []) {
      const num = ((p.extendedData || []).find(e => e.name === 'Number') || {}).value || '';
      prod.p[p.productId] = [p.name, g.groupId, num];
    }
    n++; await sleep(120);
  }
  log(`products: refreshed ${n} set(s), ${Object.keys(prod.p).length} products known`);
  return prod;
}
async function daily({ force = false, latestHave = null } = {}) {
  const stamp = (await fetch(`${BASE}/last-updated.txt`, { headers: { 'user-agent': UA } }).then(r => r.text())).trim();
  const date = stamp.slice(0, 10);
  if (!force && (haveDay(date) || latestHave === date)) { log(`daily: already have ${date} (TCGCSV updated ${stamp})`); return null; }
  const groups = (await get(`${BASE}/tcgplayer/${CAT}/groups`)).results;
  log(`daily: ${groups.length} sets, TCGCSV build ${stamp}`);
  const lines = [];
  for (const [i, g] of groups.entries()) {
    const j = await get(`${BASE}/tcgplayer/${CAT}/${g.groupId}/prices`);
    if (j && j.results) lines.push(...rowsToTsv(j.results));
    await sleep(120);
    if (i % 100 === 99) log(`  ${i + 1}/${groups.length}`);
  }
  writeDay(date, lines);
  log(`daily: ${date} — ${lines.length} prices`);
  writeProducts(await refreshProducts(groups));
  return date;
}

// ---------- build public shards ----------
// Sources per date, best first: TCGCSV day files, then MTGJSON (pre-2024 windows), then Scryfall snapshots.
const EXTRA = process.env.EXTRA_DIR || path.join(ROOT, 'cache', 'extra');
const SRC_RANK = { tcgcsv: 0, mtgjson: 1, scryfall: 2 };
function dayFiles() {
  const out = {}; // date → [{src, file}]
  for (const f of fs.readdirSync(DAYS)) if (f.endsWith('.tsv.gz')) (out[f.slice(0, 10)] ||= []).push({ src: 'tcgcsv', file: path.join(DAYS, f) });
  if (fs.existsSync(EXTRA)) for (const f of fs.readdirSync(EXTRA)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.(\w+)\.tsv\.gz$/); if (m) (out[m[1]] ||= []).push({ src: m[2], file: path.join(EXTRA, f) });
  }
  for (const d in out) out[d].sort((a, b) => SRC_RANK[a.src] - SRC_RANK[b.src]);
  return out;
}
function readRows(file) {
  return zlib.gunzipSync(fs.readFileSync(file)).toString().split('\n').filter(Boolean).map(l => l.split('\t'));
}
function readDay(d) { return readRows(path.join(DAYS, d + '.tsv.gz')); }

// Daily points for the last DAILY_WINDOW days; before that, one point per fixed 7-day bucket
// (the earliest day available in it). Buckets are absolute (epoch-based) so the grid never
// shifts — a full rebuild and an incremental update always choose the same days.
export function historyAxis(allDates, latest) {
  const dailyFrom = addDays(latest, -DAILY_WINDOW);
  const bucket = d => Math.floor(Date.parse(d + 'T00:00:00Z') / (7 * 864e5));
  const first = new Map();
  for (const d of allDates) if (d < dailyFrom) { const b = bucket(d); if (!first.has(b) || d < first.get(b)) first.set(b, d); }
  return [...[...first.values()].sort(), ...allDates.filter(d => d >= dailyFrom && d <= latest).sort()];
}

// ---------- shared output helpers ----------
const keyOf = (pid, foil) => pid * 2 + (foil ? 1 : 0);
function encodeSeries(arr) { // Uint32Array aligned to dates → [start, ...cents] or null
  let a = 0, b = arr.length - 1;
  while (a <= b && !arr[a]) a++; while (b >= a && !arr[b]) b--;
  return a > b ? null : [a, ...arr.subarray(a, b + 1)];
}
function writeLatest(rows, date, trend) {
  fs.mkdirSync(path.join(OUT, 'latest'), { recursive: true });
  const L = Array.from({ length: LATEST_SHARDS }, () => ({}));
  for (const [pid, sub, ...v] of rows) {
    if (sub !== 'N' && sub !== 'F') continue;
    const sh = L[+pid % LATEST_SHARDS];
    const row = sh[pid] || (sh[pid] = [0, 0, 0, 0]);
    const off = sub === 'F' ? 4 : 0;
    while (row.length < off + 4) row.push(0);
    for (let i = 0; i < 4; i++) row[off + i] = +v[i] || 0;
  }
  // t: {pid: [normal m30, normal usual, foil m30, foil usual]} — see Movers.add
  const T = Array.from({ length: LATEST_SHARDS }, () => ({}));
  if (trend) for (const [k, v] of trend) {
    const pid = Math.floor(k / 2), off = k % 2 ? 2 : 0, sh = T[pid % LATEST_SHARDS];
    const row = sh[pid] || (sh[pid] = [0, 0]);
    while (row.length < off + 2) row.push(0);
    row[off] = v[0]; row[off + 1] = v[1];
  }
  L.forEach((sh, i) => fs.writeFileSync(path.join(OUT, 'latest', i + '.json'), JSON.stringify({ d: date, p: sh, t: T[i] })));
}
function writeSite(meta) {
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(PUB, '.nojekyll'), '');
  fs.writeFileSync(path.join(PUB, 'index.html'), `<!doctype html><meta charset="utf-8"><title>ORACLE data</title><p>Data for <a href="https://doggiedance.github.io/ORACLE/">ORACLE</a>: TCGplayer price history (via <a href="https://tcgcsv.com">tcgcsv.com</a>; older points from MTGJSON and Scryfall snapshots) and the news wire. Prices through ${meta.latest}.</p>`);
}

// Movers: the last 3 days vs the median of days 8–30, filtered hard against TCGplayer
// market-price glitches (one odd sale can swing a thin foil 90%):
//   - the move must hold on each of the last 3 daily points, not just today
//   - the card must trade steadily (≥ 8 points in the reference window)
//   - today's cheapest LISTING must agree with the direction (a real drop has listings below the old price)
//   - moves beyond ±75% in a week are treated as bad data
//   - the price must also be off its days 31–365 median (a spike falling back isn't a drop)
const SEALED_RE = /\b(booster|boosters|box|bundle|pack|packs|display|case|kit|prerelease|starter|gift|tin|fat pack|precon|commander deck|theme deck|intro deck|planeswalker deck|challenger deck|event deck|deck box|sealed|collection|anthology|from the vault|signature spellbook|duel decks?|secret lair drop|land station)\b/i;
class Movers {
  constructor(dates, lows) { this.dates = dates; this.lows = lows || new Map(); this.t = dates.map(d => Date.parse(d)); this.list = []; const last = this.t[this.t.length - 1]; this.from = last - 30 * 864e5; this.to = last - 7 * 864e5; this.recent = last - 4 * 864e5; this.longFrom = last - 365 * 864e5; this.lastIdx = dates.length - 1; this.trend = new Map(); }
  add(pid, foil, arr) {
    const cur = arr[this.lastIdx]; if (!cur) return;
    // Cards on the market under ~60 days are still in preorder/launch pricing: no trend, no mover.
    let firstIdx = 0; while (firstIdx < this.lastIdx && !arr[firstIdx]) firstIdx++;
    if (this.t[firstIdx] > this.t[this.lastIdx] - 60 * 864e5) return;
    const ref = [], win = [], rec = [];
    for (let i = this.lastIdx; i >= 0 && this.t[i] >= this.from; i--) {
      const v = arr[i]; if (!v) continue;
      win.push(v);
      if (this.t[i] <= this.to) ref.push(v);
      else if (this.t[i] >= this.recent && rec.length < 3) rec.push(v);
    }
    // Per-printing trend for the latest shards (deck checks in ORACLE): median of days 8–30, and the
    // weekly-sampled median of days 31–365 (its "usual" price).
    const long = [];
    for (let i = this.lastIdx, next = this.from; i >= 0 && this.t[i] >= this.longFrom; i--) if (this.t[i] <= next && arr[i]) { long.push(arr[i]); next = this.t[i] - 6.5 * 864e5; }
    long.sort((x, y) => x - y);
    const lmed = long.length >= 4 ? long[long.length >> 1] : 0;
    const rs = [...ref].sort((x, y) => x - y);
    const m30 = rs.length >= 4 ? rs[rs.length >> 1] : 0;
    if (m30 || lmed) this.trend.set(keyOf(pid, foil), [m30, lmed]);
    if (ref.length < 8 || rec.length < 3) return;
    ref.sort((x, y) => x - y);
    const med = ref[ref.length >> 1];
    if (Math.max(cur, med) < 300) return; // ignore sub-$3 noise
    const now = [...rec].sort((x, y) => x - y)[1]; // median of the last 3 days
    const pct = now / med - 1;
    if (Math.abs(pct) < 0.1 || Math.abs(pct) > 0.75) return;
    if (!rec.every(v => pct < 0 ? v <= med * 0.95 : v >= med * 1.05)) return;
    const mean = win.reduce((x, y) => x + y, 0) / win.length;
    const sd = Math.sqrt(win.reduce((x, y) => x + (y - mean) ** 2, 0) / win.length);
    if (Math.abs(now - med) < Math.max(50, sd)) return;
    // A spike unwinding (or a dip recovering) isn't a move: the price must also differ from its longer-run level.
    // (weekly samples, so the daily-resolution last 90 days don't outweigh the weekly year before them)
    if (lmed && (pct < 0 ? now > lmed * 0.9 : now < lmed * 1.1)) return;
    const low = this.lows.get(pid * 2 + (foil ? 1 : 0));
    if (low && (pct < 0 ? low > med : low < med)) return;
    // Was it already moving before this week? Compare the late half of the reference window
    // (days 8–15) with the early half (days 22–30): a steady trend vs a one-week spike/crash.
    let g = 0;
    const early = [], late = [];
    for (let i = this.lastIdx; i >= 0 && this.t[i] >= this.from; i--) if (arr[i]) { const age = (this.t[this.lastIdx] - this.t[i]) / 864e5; if (age >= 22) early.push(arr[i]); else if (age >= 8 && age <= 15) late.push(arr[i]); }
    if (early.length >= 3 && late.length >= 3) { const md = a => a.sort((x, y) => x - y)[a.length >> 1]; const r = md(late) / md(early) - 1; if (pct > 0 ? r >= 0.08 : r <= -0.08) g = 1; }
    this.list.push({ pid, foil, cur: now, ref: med, pct, g });
  }
  write(prod) {
    const named = this.list.map(m => {
      const p = prod.p[m.pid]; if (!p) return null;
      const g = prod.groups[p[1]] || {};
      // Old sets have no collector numbers on TCGplayer, so sealed is decided by the product name.
      const kind = p[2] || !SEALED_RE.test(p[0]) ? 'single' : 'sealed';
      if (kind === 'sealed' && Math.max(m.cur, m.ref) < 1500) return null;
      return { pid: m.pid, n: p[0], set: g.abbr || '', sn: g.name || '', num: p[2] || '', kind, foil: m.foil ? 1 : 0, cur: m.cur, ref: m.ref, pct: Math.round(m.pct * 1000) / 1000, g: m.g };
    }).filter(Boolean);
    const pick = (kind, dir) => named.filter(m => m.kind === kind && (dir < 0 ? m.pct < 0 : m.pct > 0)).sort((a, b) => dir < 0 ? a.pct - b.pct : b.pct - a.pct).slice(0, 40);
    const out = { d: this.dates[this.lastIdx], window: '7d vs median of days 8–30', drops: { single: pick('single', -1), sealed: pick('sealed', -1) }, climbs: { single: pick('single', 1), sealed: pick('sealed', 1) } };
    fs.writeFileSync(path.join(OUT, 'movers.json'), JSON.stringify(out));
    log(`movers: ${out.drops.single.length}+${out.drops.sealed.length} drops, ${out.climbs.single.length}+${out.climbs.sealed.length} climbs`);
  }
}

function lowsOf(rows) { const m = new Map(); for (const [pid, sub, , low] of rows) if ((sub === 'N' || sub === 'F') && +low) m.set(+pid * 2 + (sub === 'F' ? 1 : 0), +low); return m; }

// ---------- FULL build (this PC: every cached source) ----------
function build() {
  const files = dayFiles();
  const tcg = Object.keys(files).filter(d => files[d].some(x => x.src === 'tcgcsv')).sort();
  if (!tcg.length) throw new Error('no TCGCSV days cached — run backfill/daily first');
  const latest = tcg[tcg.length - 1];
  const dates = historyAxis(Object.keys(files), latest);
  log(`build: ${dates.length} history points from ${dates[0]} to ${latest}`);
  const series = new Map();
  dates.forEach((d, i) => {
    const seen = new Set();
    for (const { file } of files[d]) for (const [pid, sub, market] of readRows(file)) {
      if (sub !== 'N' && sub !== 'F') continue;
      const m = +market; if (!m) continue;
      const k = keyOf(+pid, sub === 'F');
      if (seen.has(k)) continue; // a better source already gave this point
      seen.add(k);
      let a = series.get(k); if (!a) { a = new Uint32Array(dates.length); series.set(k, a); }
      a[i] = m;
    }
  });
  const prod = readProducts();
  fs.rmSync(path.join(OUT, 'hist'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'latest'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'hist'), { recursive: true });
  const H = Array.from({ length: HIST_SHARDS }, () => ({}));
  const movers = new Movers(dates, lowsOf(readDay(latest)));
  for (const [k, a] of series) {
    const pid = Math.floor(k / 2), foil = k % 2;
    movers.add(pid, foil, a);
    const enc = encodeSeries(a); if (!enc) continue;
    (H[pid % HIST_SHARDS][pid] ||= {})[foil ? 'f' : 'n'] = enc;
  }
  let bytes = 0;
  H.forEach((sh, i) => { const t = JSON.stringify(sh); bytes += t.length; fs.writeFileSync(path.join(OUT, 'hist', i + '.json'), t); });
  writeLatest(readDay(latest), latest, movers.trend);
  movers.write(prod);
  writeSite(metaFor(dates, d => files[d][0].src, series.size, latest));
  log(`build: ${series.size} series, history ${(bytes / 1e6).toFixed(1)} MB in ${HIST_SHARDS} shards`);
}
function metaFor(dates, srcOf, n, latest) {
  return {
    updated: new Date().toISOString(), latest, dates, src: dates.map(d => srcOf(d)[0]), // t = TCGCSV, m = MTGJSON, s = Scryfall snapshot
    shards: { latest: LATEST_SHARDS, hist: HIST_SHARDS }, series: n,
    source: 'TCGplayer market prices: tcgcsv.com (2024-02-08+), MTGJSON & Scryfall snapshots via the Internet Archive (earlier)', units: 'USD cents',
  };
}

// ---------- INCREMENTAL update (GitHub Action: no day archive, just the published shards) ----------
function update(date) {
  if (!fs.existsSync(path.join(OUT, 'meta.json'))) { log('update: no published history yet — waiting for the initial upload from the backfill PC'); return false; }
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
  if (meta.latest >= date) { log(`update: published data already at ${meta.latest}`); return false; }
  const oldDates = meta.dates, oldSrc = meta.src;
  const dates = historyAxis([...oldDates, date], date);
  const pos = new Map(dates.map((d, i) => [d, i]));
  const remap = oldDates.map(d => pos.has(d) ? pos.get(d) : -1);
  const srcByDate = Object.fromEntries(oldDates.map((d, i) => [d, oldSrc[i]])); srcByDate[date] = 't';
  const today = dates.length - 1;
  const rows = readDay(date);
  const byShard = Array.from({ length: HIST_SHARDS }, () => []);
  for (const [pid, sub, market] of rows) if ((sub === 'N' || sub === 'F') && +market) byShard[+pid % HIST_SHARDS].push([+pid, sub === 'F', +market]);
  const movers = new Movers(dates, lowsOf(rows));
  let n = 0;
  for (let i = 0; i < HIST_SHARDS; i++) {
    const file = path.join(OUT, 'hist', i + '.json');
    const sh = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const series = new Map();
    for (const [pid, o] of Object.entries(sh)) for (const fk of ['n', 'f']) {
      const enc = o[fk]; if (!enc) continue;
      const a = new Uint32Array(dates.length);
      for (let j = 1; j < enc.length; j++) { const ni = remap[enc[0] + j - 1]; if (ni >= 0 && enc[j]) a[ni] = enc[j]; }
      series.set(keyOf(+pid, fk === 'f'), a);
    }
    for (const [pid, foil, m] of byShard[i]) {
      const k = keyOf(pid, foil);
      let a = series.get(k); if (!a) { a = new Uint32Array(dates.length); series.set(k, a); }
      a[today] = m;
    }
    const out = {};
    for (const [k, a] of series) {
      const pid = Math.floor(k / 2), foil = k % 2;
      movers.add(pid, foil, a);
      const enc = encodeSeries(a); if (!enc) continue;
      (out[pid] ||= {})[foil ? 'f' : 'n'] = enc; n++;
    }
    fs.writeFileSync(file, JSON.stringify(out));
  }
  writeLatest(rows, date, movers.trend);
  movers.write(readProducts());
  writeSite(metaFor(dates, d => srcByDate[d] || 't', n, date));
  log(`update: ${oldDates.length} → ${dates.length} points, now through ${date}; ${n} series`);
  return true;
}

const cmd = process.argv[2] || 'all';
try {
  if (cmd === 'backfill') await backfill();
  else if (cmd === 'daily') await daily({ force: process.argv.includes('--force') });
  else if (cmd === 'build') build();
  else if (cmd === 'products') writeProducts(await refreshProducts((await get(`${BASE}/tcgplayer/${CAT}/groups`)).results));
  else if (cmd === 'update') { const d = process.argv[3] || fs.readdirSync(DAYS).filter(f => f.endsWith('.tsv.gz')).sort().pop().slice(0, 10); update(d); }
  else if (cmd === 'action') {
    let have = null; try { have = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8')).latest; } catch {}
    const d = await daily({ latestHave: have, force: process.argv.includes('--force') });
    if (d) update(d);
    // Reprint radar refreshes every run (Scryfall adds spoiled reprints daily). A failure keeps yesterday's file.
    try { await (await import('./reprints.mjs')).buildReprints(PUB); } catch (e) { log('reprints failed (keeping the last file): ' + e.message); }
    // Market read (staples index, staples on sale, new-set curve; images on movers). Needs reprints.json first.
    try { await (await import('./market.mjs')).buildMarket(); } catch (e) { log('market failed (keeping the last file): ' + e.message); }
  }
  else if (cmd === 'all') { await daily(); build(); }
  else console.log('usage: node sync.mjs backfill|daily|build|update [date]|action|all');
} catch (e) { log('ERROR', e.stack || e.message); process.exitCode = 1; }
