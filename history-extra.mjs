#!/usr/bin/env node
// Pre-2024 price history recovered from the Internet Archive (one-time):
//   - MTGJSON AllPrices (each copy = 90 days of daily prices) + AllIdentifiers (uuid → TCGplayer product id)
//   - Scryfall bulk snapshots (single days; usd/usd_foil = TCGplayer market price, keyed by tcgplayer_id)
// Raw downloads are kept forever in cache/raw so nothing has to be fetched twice.
// Output: cache/extra/<YYYY-MM-DD>.<source>.tsv.gz, same columns as cache/days (pid sub market low mid direct high).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parser } = require('stream-json');
const { streamObject } = require('stream-json/streamers/StreamObject');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { pick } = require('stream-json/filters/Pick');
const { chain } = require('stream-chain');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(ROOT, 'cache', 'raw');
const EXTRA = path.join(ROOT, 'cache', 'extra');
fs.mkdirSync(RAW, { recursive: true }); fs.mkdirSync(EXTRA, { recursive: true });
const UA = 'OraclePriceSync/1.0 (personal deck-builder price history)';
const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a);
const cents = v => (v == null || !Number.isFinite(+v)) ? 0 : Math.round(+v * 100);

const SOURCES = {
  mtgjsonIds: { ts: '20230530', url: 'https://mtgjson.com/api/v5/AllIdentifiers.json.xz', file: 'mtgjson-AllIdentifiers-20230530.json.xz' },
  mtgjson2022: { ts: '20220106090512', url: 'https://mtgjson.com/api/v5/AllPrices.json.zip', file: 'mtgjson-AllPrices-20220106.json.zip' },
  mtgjson2023: { ts: '20230530051025', url: 'https://mtgjson.com/api/v5/AllPrices.json.xz', file: 'mtgjson-AllPrices-20230530.json.xz' },
  scryfall: [
    { ts: '20190609094027', url: 'https://archive.scryfall.com/json/scryfall-default-cards.json', date: '2019-06-09' },
    { ts: '20221019021947', url: 'https://data.scryfall.io/default-cards/default-cards-20221018210611.json', date: '2022-10-18' },
    { ts: '20230311185111', url: 'https://data.scryfall.io/default-cards/default-cards-20230113220738.json', date: '2023-01-13' },
    { ts: '20230306165907', url: 'https://data.scryfall.io/default-cards/default-cards-20230306100511.json', date: '2023-03-06' },
    { ts: '20231227032122', url: 'https://data.scryfall.io/default-cards/default-cards-20231226220609.json', date: '2023-12-26' },
    // oracle-cards (one printing per card) — extra dates only
    { ts: '20250820185830', url: 'https://data.scryfall.io/oracle-cards/oracle-cards-20221014090230.json', date: '2022-10-14' },
    { ts: '20230125143312', url: 'https://data.scryfall.io/oracle-cards/oracle-cards-20230125100229.json', date: '2023-01-25' },
    { ts: '20240303095603', url: 'https://data.scryfall.io/oracle-cards/oracle-cards-20240128100145.json', date: '2024-01-28' },
  ],
};

async function download(ts, url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const wb = `https://web.archive.org/web/${ts}id_/${url}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    log(`download ${path.basename(dest)} (attempt ${attempt})`);
    try {
      const r = await fetch(wb, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const tmp = dest + '.part';
      // Plain .json from Scryfall is stored gzipped to save disk.
      const gz = dest.endsWith('.gz') && !url.endsWith('.gz');
      await pipeline(Readable.fromWeb(r.body), ...(gz ? [zlib.createGzip({ level: 6 })] : []), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      log(`  saved ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
      return dest;
    } catch (e) {
      log(`  failed: ${e.message}`);
      await new Promise(r => setTimeout(r, attempt * 15000));
    }
  }
  throw new Error('could not download ' + url);
}

function decompressStream(file) {
  if (file.endsWith('.xz')) return spawn('xz', ['-dc', file]).stdout;
  if (file.endsWith('.zip')) return spawn('unzip', ['-p', file]).stdout;
  if (file.endsWith('.gz')) return fs.createReadStream(file).pipe(zlib.createGunzip());
  return fs.createReadStream(file);
}

function writeExtra(date, src, rows) {
  const f = path.join(EXTRA, `${date}.${src}.tsv.gz`);
  fs.writeFileSync(f, zlib.gzipSync(rows.join('\n') + '\n', { level: 9 }));
}

// uuid → { n: productId, e: etchedProductId }
async function loadIdMap() {
  const cacheFile = path.join(RAW, 'mtgjson-uuid-tcgplayer-20230530.json.gz');
  if (fs.existsSync(cacheFile)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile)));
  const s = SOURCES.mtgjsonIds;
  const file = await download(s.ts, s.url, path.join(RAW, s.file));
  log('parse AllIdentifiers…');
  const map = {};
  await new Promise((res, rej) => {
    const c = chain([decompressStream(file), parser(), pick({ filter: 'data' }), streamObject()]);
    c.on('data', ({ key, value }) => {
      const id = value.identifiers || {};
      if (id.tcgplayerProductId || id.tcgplayerEtchedProductId) map[key] = { n: id.tcgplayerProductId ? +id.tcgplayerProductId : 0, e: id.tcgplayerEtchedProductId ? +id.tcgplayerEtchedProductId : 0, f: (value.finishes || []).join(',') };
    });
    c.on('end', res); c.on('error', rej);
  });
  fs.writeFileSync(cacheFile, zlib.gzipSync(JSON.stringify(map)));
  log(`  ${Object.keys(map).length} uuids mapped to TCGplayer`);
  return map;
}

async function mtgjsonPrices(key, idMap) {
  const s = SOURCES[key];
  const file = await download(s.ts, s.url, path.join(RAW, s.file));
  log(`parse ${s.file}…`);
  const byDate = {}; // date → rows
  let cards = 0, mapped = 0;
  await new Promise((res, rej) => {
    const c = chain([decompressStream(file), parser(), pick({ filter: 'data' }), streamObject()]);
    c.on('data', ({ key: uuid, value }) => {
      cards++;
      const tp = value && value.paper && value.paper.tcgplayer && value.paper.tcgplayer.retail;
      const ids = idMap[uuid];
      if (!tp || !ids) return;
      mapped++;
      const emit = (pid, sub, series) => { if (!pid || !series) return; for (const [d, v] of Object.entries(series)) { const m = cents(v); if (m) (byDate[d] || (byDate[d] = [])).push([pid, sub, m, 0, 0, 0, 0].join('\t')); } };
      emit(ids.n, 'N', tp.normal);
      emit(ids.n, 'F', tp.foil);
      emit(ids.e || ids.n, ids.e ? 'N' : 'F', tp.etched); // etched foils are their own TCGplayer product
    });
    c.on('end', res); c.on('error', rej);
  });
  const dates = Object.keys(byDate).sort();
  for (const d of dates) writeExtra(d, 'mtgjson', byDate[d]);
  log(`  ${cards} cards, ${mapped} mapped; ${dates.length} days ${dates[0]} → ${dates[dates.length - 1]}`);
}

async function scryfallSnapshot(s) {
  const out = path.join(EXTRA, `${s.date}.scryfall.tsv.gz`);
  if (fs.existsSync(out) || fs.existsSync(out + '.empty')) return;
  const file = await download(s.ts, s.url, path.join(RAW, 'scryfall-' + path.basename(s.url) + '.gz'));
  log(`parse ${path.basename(s.url)}…`);
  const rows = [];
  await new Promise((res, rej) => {
    const c = chain([decompressStream(file), parser(), streamArray()]);
    c.on('data', ({ value: card }) => {
      const p = card.prices || {};
      const usd = p.usd ?? card.usd, foil = p.usd_foil, etched = p.usd_etched;
      if (card.tcgplayer_id) {
        if (cents(usd)) rows.push([card.tcgplayer_id, 'N', cents(usd), 0, 0, 0, 0].join('\t'));
        if (cents(foil)) rows.push([card.tcgplayer_id, 'F', cents(foil), 0, 0, 0, 0].join('\t'));
      }
      const et = card.tcgplayer_etched_id;
      if (et && cents(etched)) rows.push([et, 'N', cents(etched), 0, 0, 0, 0].join('\t'));
    });
    c.on('end', res); c.on('error', rej);
  });
  if (!rows.length) { log(`  ${s.date}: snapshot has no prices — skipped`); fs.writeFileSync(out + '.empty', ''); return; }
  writeExtra(s.date, 'scryfall', rows);
  log(`  ${s.date}: ${rows.length} prices`);
}

const only = process.argv[2];
try {
  if (!only || only === 'mtgjson') {
    const ids = await loadIdMap();
    for (const k of ['mtgjson2022', 'mtgjson2023']) await mtgjsonPrices(k, ids);
  }
  if (!only || only === 'scryfall') {
    for (const s of SOURCES.scryfall) {
      try { await scryfallSnapshot(s); } catch (e) { log(`  ${s.date} skipped: ${e.message}`); }
    }
  }
  log('history-extra done');
} catch (e) { log('ERROR', e.stack || e.message); process.exitCode = 1; }
