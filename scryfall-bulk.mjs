// Scryfall default_cards bulk file (every paper/digital printing, gzipped JSON Lines, ~80 MB).
// Downloaded once per Scryfall update into cache/scryfall/ and shared by reprints.mjs and market.mjs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(ROOT, 'cache', 'scryfall');
const UA = { 'User-Agent': 'ORACLE-data/1.0 (personal deck builder)', Accept: 'application/json;q=0.9,*/*;q=0.8' };
const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a);

export async function bulkFile() {
  if (process.env.BULK_FILE) return process.env.BULK_FILE;
  const meta = await (await fetch('https://api.scryfall.com/bulk-data/default-cards', { headers: UA })).json();
  const uri = meta.jsonl_download_uri;
  if (!uri) throw new Error('bulk-data: no jsonl_download_uri in ' + JSON.stringify(meta).slice(0, 300));
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, path.basename(new URL(uri).pathname));
  if (fs.existsSync(file)) return file;
  log(`scryfall: downloading ${uri} (${((meta.compressed_size || 0) / 1e6).toFixed(0)} MB)`);
  const res = await fetch(uri, { headers: UA });
  if (!res.ok) throw new Error('bulk download ' + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file + '.part'));
  fs.renameSync(file + '.part', file);
  for (const f of fs.readdirSync(DIR)) if (f !== path.basename(file) && f.endsWith('.jsonl.gz')) fs.rmSync(path.join(DIR, f)); // keep one
  return file;
}
export async function* bulkCards() {
  const file = await bulkFile();
  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (line && line[0] === '{') yield JSON.parse(line.endsWith(',') ? line.slice(0, -1) : line);
  }
}
