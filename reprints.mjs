// Reprint radar: which cards are being reprinted (announced/upcoming, or released in the last
// RECENT_DAYS) and what their EXISTING printings cost — the "wait, it's getting cheaper" signal.
//
// One request a day: Scryfall's default_cards bulk file (every paper printing with prices),
// streamed so memory stays flat. Output: public/reprints.json
//   { updated, today, cards: [{ o, n, lo, hi, nOld, new: [{ id, set, sn, st, rel, usd, foil }] }] }
//   lo/hi = cheapest / dearest existing printing in USD cents (non-foil, else foil).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import readline from 'node:readline';

const PUB = process.argv[2] || process.env.PUBLIC_DIR || 'public';
const RECENT_DAYS = 75;      // reprints released this recently still count (prices bottom 2–4 months after release)
const MIN_CENTS = 100;       // ignore cards whose cheapest existing copy is under $1
const UA = { 'User-Agent': 'ORACLE-data/1.0 (personal deck builder)', Accept: 'application/json;q=0.9,*/*;q=0.8' };
// Supply that actually reaches the market. Promos / memorabilia / digital don't move prices.
const SKIP_SET_TYPES = new Set(['promo', 'memorabilia', 'token', 'minigame', 'alchemy', 'treasure_chest', 'vanguard', 'funny']);

const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a);
const cents = v => v ? Math.round(parseFloat(v) * 100) : 0;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export async function buildReprints(pub = PUB, source) {
  const today = new Date().toISOString().slice(0, 10);
  const recentFrom = addDays(today, -RECENT_DAYS);
  let input = source;
  if (!input) {
    const meta = await (await fetch('https://api.scryfall.com/bulk-data/default-cards', { headers: UA })).json();
    const uri = meta.jsonl_download_uri; // gzipped JSON Lines (one printing per line)
    if (!uri) throw new Error('bulk-data: no jsonl_download_uri in ' + JSON.stringify(meta).slice(0, 300));
    log(`reprints: downloading ${uri} (${((meta.compressed_size || 0) / 1e6).toFixed(0)} MB gz, ${meta.updated_at})`);
    const res = await fetch(uri, { headers: UA });
    if (!res.ok) throw new Error('bulk download ' + res.status);
    input = Readable.fromWeb(res.body);
  } else input = fs.createReadStream(source);
  if (!source || source.endsWith('.gz')) input = input.pipe(zlib.createGunzip());

  const byOracle = new Map(); // oracle_id → { n, prints: [...] }
  let seen = 0;
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line || line[0] !== '{') continue;
    const c = JSON.parse(line);
    (() => {
        seen++;
        if (c.digital || !(c.games || []).includes('paper')) return;
        if (/^(token|double_faced_token|art_series|emblem|vanguard|planar|scheme)$/.test(c.layout)) return;
        if (/\bBasic\b/.test(c.type_line || '')) return;
        const o = c.oracle_id || (c.card_faces && c.card_faces[0] && c.card_faces[0].oracle_id); if (!o) return;
        let e = byOracle.get(o); if (!e) byOracle.set(o, e = { n: c.name, prints: [] });
        e.prints.push({ id: c.id, set: c.set, sn: c.set_name, st: c.set_type, rel: c.released_at, reprint: !!c.reprint,
          usd: cents(c.prices && c.prices.usd), foil: cents(c.prices && (c.prices.usd_foil || c.prices.usd_etched)) });
    })();
  }

  const cards = [];
  for (const [o, e] of byOracle) {
    const fresh = e.prints.filter(p => p.reprint && p.rel >= recentFrom && !SKIP_SET_TYPES.has(p.st));
    if (!fresh.length) continue;
    const first = fresh.reduce((m, p) => p.rel < m ? p.rel : m, '9999');
    const old = e.prints.filter(p => p.rel < first && (p.usd || p.foil));
    if (!old.length) continue;
    const px = old.map(p => p.usd || p.foil);
    const lo = Math.min(...px), hi = Math.max(...px);
    if (lo < MIN_CENTS) continue;
    const sets = new Map(); // one entry per new set (several frames of the same card in one set collapse)
    for (const p of fresh.sort((a, b) => a.rel < b.rel ? -1 : 1)) {
      const s = sets.get(p.set);
      if (!s) sets.set(p.set, { id: p.id, set: p.set, sn: p.sn, st: p.st, rel: p.rel, usd: p.usd, foil: p.foil, k: 1 });
      else { s.k++; if (p.usd && (!s.usd || p.usd < s.usd)) { s.usd = p.usd; s.id = p.id; } }
    }
    cards.push({ o, n: e.n, lo, hi, nOld: old.length, new: [...sets.values()] });
  }
  cards.sort((a, b) => b.lo - a.lo);
  const out = { updated: new Date().toISOString(), today, recentDays: RECENT_DAYS, cards };
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'reprints.json'), JSON.stringify(out));
  const upcoming = cards.filter(c => c.new.some(s => s.rel > today)).length;
  log(`reprints: ${seen} printings scanned → ${cards.length} reprinted cards ≥ $${MIN_CENTS / 100} (${upcoming} upcoming), ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildReprints(PUB, process.env.BULK_FILE).catch(e => { console.error(e); process.exit(1); });
}
