// Market read: what the price history says beyond single-card charts. Runs after the daily
// price update (needs public/prices/{meta,latest,hist}) and the Scryfall bulk file.
// Output: public/prices/market.json
//   index   — "Commander staples" price index: the 500 most-played Commander cards (EDHREC rank),
//             each at its cheapest long-lived printing, chain-linked daily → is the market up or down?
//   sale    — staples (EDHREC top 3000) whose cheapest copy sits ≥ 15% under its usual (1-year) price
//   heat    — staples ≥ 20% over their usual price and still rising vs last month
//   sets    — how new-set prices actually behave after release in OUR data: the median rare/mythic
//             price by week since release (relative to release week), across every set since early 2024,
//             plus where each recent set sits on that curve right now
// It also stamps Scryfall ids (images) and EDHREC ranks onto movers.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bulkCards } from './scryfall-bulk.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = process.env.PUBLIC_DIR || path.join(ROOT, 'public');
const OUT = path.join(PUB, 'prices');
const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a);
const DAY = 864e5;
const T = d => Date.parse(d + 'T00:00:00Z');
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const SKIP_ST = new Set(['memorabilia', 'funny', 'token', 'minigame', 'alchemy', 'treasure_chest', 'vanguard']);
const CURVE_ST = new Set(['expansion', 'core', 'masters', 'draft_innovation']);
const INDEX_N = 500, STAPLE_N = 3000, WEEKS = 26;

export async function buildMarket() {
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
  const dates = meta.dates, tt = dates.map(T), last = tt[tt.length - 1], today = meta.latest;

  // ---- 1. Scryfall: tcgplayer id → card facts; oracle → EDHREC rank
  const info = new Map();     // pid → {sid, o, n, set, sn, rel, rar, st, booster}
  const byOracle = new Map(); // o → {n, er, pids: []}
  const setInfo = new Map();  // set → {name, rel, st}
  for await (const c of bulkCards()) {
    if (c.digital || !(c.games || []).includes('paper') || c.lang !== 'en') continue;
    if (/^(token|double_faced_token|art_series|emblem)$/.test(c.layout) || SKIP_ST.has(c.set_type)) continue;
    const o = c.oracle_id || (c.card_faces && c.card_faces[0] && c.card_faces[0].oracle_id); if (!o) continue;
    if (!setInfo.has(c.set)) setInfo.set(c.set, { name: c.set_name, rel: c.released_at, st: c.set_type });
    let e = byOracle.get(o); if (!e) byOracle.set(o, e = { n: c.name, er: 0, pids: [], basic: /\bBasic\b/.test(c.type_line || '') });
    if (c.edhrec_rank && (!e.er || c.edhrec_rank < e.er)) e.er = c.edhrec_rank;
    for (const pid of [c.tcgplayer_id, c.tcgplayer_etched_id].filter(Boolean)) {
      if (info.has(pid)) continue;
      info.set(pid, { sid: c.id, o, n: c.name, set: c.set, sn: c.set_name, rel: c.released_at, rar: c.rarity, st: c.set_type, booster: !c.promo && /^\d+$/.test(c.collector_number || '') && !/^(plst|plist|ulst|sld)$/.test(c.set), etched: pid === c.tcgplayer_etched_id });
      e.pids.push(pid);
    }
  }
  log(`market: ${info.size} priced printings, ${byOracle.size} cards`);

  // ---- 2. latest prices + trend reads (normal finish only: what a deck buyer pays)
  const cur = new Map(), trend = new Map();
  for (let i = 0; i < meta.shards.latest; i++) {
    const sh = JSON.parse(fs.readFileSync(path.join(OUT, 'latest', i + '.json'), 'utf8'));
    for (const [pid, row] of Object.entries(sh.p)) if (row[0]) cur.set(+pid, row[0]);
    for (const [pid, t] of Object.entries(sh.t || {})) trend.set(+pid, t);
  }

  // ---- 3. staples: EDHREC top N, cheapest current non-foil printing
  const staples = [...byOracle.entries()].filter(([, e]) => e.er && e.er <= STAPLE_N && !e.basic).sort((a, b) => a[1].er - b[1].er);
  const cheapest = (e) => { let best = null; for (const pid of e.pids) { const v = cur.get(pid), inf = info.get(pid); if (!v || inf.etched) continue; if (!best || v < best.v) best = { pid, v }; } return best; };
  let reprintSet = new Set();
  try { reprintSet = new Set(JSON.parse(fs.readFileSync(path.join(PUB, 'reprints.json'), 'utf8')).cards.map(c => c.o)); } catch { }
  const sale = [], heat = [];
  for (const [o, e] of staples) {
    const b = cheapest(e); if (!b || b.v < 200) continue;
    const t = trend.get(b.pid) || [0, 0];
    // "usual" = the cheapest this card normally sells for (lowest 1-year usual across its printings),
    // so one odd printing's history can't make a card look on sale
    let usual = 0; for (const pid of e.pids) { const tp = trend.get(pid), inf2 = info.get(pid); if (!tp || !tp[1] || inf2.etched) continue; if (!usual || tp[1] < usual) usual = tp[1]; }
    if (!usual) continue;
    const m30 = t[0];
    const inf = info.get(b.pid);
    const row = { pid: b.pid, sid: inf.sid, o, n: e.n, set: inf.set.toUpperCase(), er: e.er, cur: b.v, usual, m30, pct: Math.round((b.v / usual - 1) * 1000) / 1000, rp: reprintSet.has(o) ? 1 : 0 };
    if (b.v <= usual * 0.85) sale.push(row);
    else if (b.v >= usual * 1.2 && m30 && b.v >= m30 * 1.08) heat.push(row);
  }
  sale.sort((a, b) => a.pct - b.pct); heat.sort((a, b) => b.pct - a.pct);

  // ---- 4. read the history we need (index printings + new-set rares/mythics) in one pass over the shards
  const want = new Set();
  const indexPick = []; // [o, pid]
  const yearAgo = last - 365 * DAY;
  for (const [o, e] of staples.slice(0, INDEX_N)) {
    // cheapest printing that also has a long history (so the index doesn't jump when a new cheap printing appears)
    let best = null;
    for (const pid of e.pids) { const v = cur.get(pid), inf = info.get(pid); if (!v || inf.etched || T(inf.rel) > yearAgo) continue; if (!best || v < best.v) best = { pid, v }; }
    if (best) { indexPick.push([o, best.pid]); want.add(best.pid); }
  }
  const curveFrom = '2024-02-20', curveTo = new Date(last - 14 * DAY).toISOString().slice(0, 10);
  const setCards = new Map(); // set → [pid]
  for (const [pid, inf] of info) {
    if (!inf.booster || inf.etched || !(inf.rar === 'rare' || inf.rar === 'mythic') || !CURVE_ST.has(inf.st)) continue;
    const s = setInfo.get(inf.set); if (!s || s.rel < curveFrom || s.rel > curveTo) continue;
    (setCards.get(inf.set) || setCards.set(inf.set, []).get(inf.set)).push(pid); want.add(pid);
  }
  const series = new Map(); // pid → Uint32Array aligned to dates (normal finish)
  for (let i = 0; i < meta.shards.hist; i++) {
    const sh = JSON.parse(fs.readFileSync(path.join(OUT, 'hist', i + '.json'), 'utf8'));
    for (const [k, o] of Object.entries(sh)) {
      const pid = +k; if (!want.has(pid)) continue;
      const enc = o.n || (info.get(pid) && info.get(pid).etched ? o.f : null); if (!enc) continue;
      const a = new Uint32Array(dates.length); for (let j = 1; j < enc.length; j++) a[enc[0] + j - 1] = enc[j];
      series.set(pid, a);
    }
  }

  // ---- 5. staples index (chain-linked: each step uses only cards priced on both days)
  const from = tt.findIndex(x => x >= last - 365 * DAY);
  const index = [[dates[from], 100]]; let val = 100;
  for (let i = from + 1; i < dates.length; i++) {
    let a = 0, b = 0;
    for (const [, pid] of indexPick) { const s = series.get(pid); if (!s) continue; const p0 = s[i - 1], p1 = s[i]; if (p0 && p1) { a += p0; b += p1; } }
    if (a) val *= b / a;
    index.push([dates[i], Math.round(val * 100) / 100]);
  }
  const at = days => { const tgt = last - days * DAY; let best = index[0]; for (const p of index) if (T(p[0]) <= tgt + 2 * DAY) best = p; return best[1]; };
  const now = index[index.length - 1][1];
  const idx = { name: 'Commander staples', n: indexPick.length, pts: index, ch7: now / at(7) - 1, ch30: now / at(30) - 1, ch90: now / at(90) - 1, ch365: now / index[0][1] - 1 };

  // ---- 6. new-set curve: price vs release week, per set, then across sets
  const valueAt = (s, target) => { // nearest point within ±4 days
    let best = 0, bd = 4.5 * DAY;
    for (let i = 0; i < tt.length; i++) { const d = Math.abs(tt[i] - target); if (d < bd && s[i]) { bd = d; best = s[i]; } }
    return best;
  };
  const sets = [];
  for (const [code, pids] of setCards) {
    const si = setInfo.get(code), r0 = T(si.rel);
    const weeksOut = Math.min(WEEKS, Math.floor((last - r0) / (7 * DAY)));
    const perWeek = Array.from({ length: weeksOut + 1 }, () => []);
    let used = 0;
    for (const pid of pids) {
      const s = series.get(pid); if (!s) continue;
      const base = valueAt(s, r0); // release-day price
      if (base < 100) continue; // under $1 at release: noise
      used++;
      for (let w = 0; w <= weeksOut; w++) { const v = valueAt(s, r0 + w * 7 * DAY); if (v) perWeek[w].push(v / base); }
    }
    if (used < 8) continue;
    sets.push({ code: code.toUpperCase(), name: si.name, rel: si.rel, st: si.st, cards: used, curve: perWeek.map(a => a.length >= 5 ? Math.round(median(a) * 1000) / 1000 : null) });
  }
  sets.sort((a, b) => a.rel < b.rel ? 1 : -1);
  const curve = [];
  for (let w = 0; w <= WEEKS; w++) {
    const v = sets.filter(s => s.curve[w] != null && s.st !== 'masters').map(s => s.curve[w]); // masters sets are mostly reprints: own shape
    curve.push(v.length >= 3 ? { w, med: Math.round(median(v) * 1000) / 1000, n: v.length } : null);
  }
  const valid = curve.filter(Boolean);
  const bottom = valid.reduce((m, p) => p.med < m.med ? p : m, valid[0]);
  const recent = sets.filter(s => T(s.rel) >= last - WEEKS * 7 * DAY);

  const out = {
    d: today, updated: new Date().toISOString(),
    index: idx,
    sale: sale.slice(0, 300), saleN: sale.length, heat: heat.slice(0, 200), heatN: heat.length,
    curve: { pts: valid, bottom, sets: sets.length },
    recent: recent.map(s => ({ code: s.code, name: s.name, rel: s.rel, st: s.st, cards: s.cards, curve: s.curve })),
  };
  fs.writeFileSync(path.join(OUT, 'market.json'), JSON.stringify(out));

  // ---- 7. movers get images + EDHREC rank
  try {
    const mf = path.join(OUT, 'movers.json'), m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    for (const dir of ['drops', 'climbs', 'dropsUsd', 'climbsUsd']) for (const kind of ['single', 'sealed']) for (const it of (m[dir] || {})[kind] || []) {
      const inf = info.get(it.pid); if (!inf) continue;
      it.sid = inf.sid; const e = byOracle.get(inf.o); if (e && e.er) it.er = e.er;
    }
    fs.writeFileSync(mf, JSON.stringify(m));
  } catch (e) { log('movers enrich skipped: ' + e.message); }

  log(`market: index ${idx.n} staples ${(idx.ch30 * 100).toFixed(1)}% 30d; ${sale.length} on sale, ${heat.length} heating; curve from ${sets.length} sets, bottom week ${bottom && bottom.w} (${bottom && Math.round((bottom.med - 1) * 100)}%); ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) buildMarket().catch(e => { console.error(e); process.exit(1); });
