#!/usr/bin/env node
// Back up the raw price archive to GitHub Releases (outside git, so the repo stays small).
//   days-YYYY-MM        one gzipped TSV per TCGCSV day (only months the backfill has finished)
//   recovered-pre2024   cache/extra day files + the raw Internet Archive downloads they came from
// Safe to re-run: files already on a release are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = 'DoggieDance/oracle-data';
const gh = (args, opts = {}) => execFileSync('gh', [...args, '-R', REPO], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, ...opts });
function assets(tag, title, notes) {
  try { return new Set(JSON.parse(gh(['release', 'view', tag, '--json', 'assets'])).assets.map(a => a.name)); }
  catch { gh(['release', 'create', tag, '--title', title, '--notes', notes]); return new Set(); }
}
function upload(tag, files, have) {
  const todo = files.filter(f => !have.has(path.basename(f)));
  for (let i = 0; i < todo.length; i += 20) {
    const batch = todo.slice(i, i + 20);
    gh(['release', 'upload', tag, ...batch, '--clobber']);
    console.log(`${tag}: +${batch.length} (${i + batch.length}/${todo.length})`);
  }
  if (!todo.length) console.log(`${tag}: up to date (${files.length} files)`);
}
const days = path.join(ROOT, 'cache', 'days');
const all = fs.readdirSync(days).filter(f => /^\d{4}-\d{2}-\d{2}\.tsv\.gz$/.test(f)).sort();
const months = [...new Set(all.map(f => f.slice(0, 7)))];
const lastDay = all[all.length - 1].slice(0, 10);
const finished = months.filter(m => process.argv.includes('--all') || m < lastDay.slice(0, 7));
for (const m of finished) {
  const files = all.filter(f => f.startsWith(m)).map(f => path.join(days, f));
  upload(`days-${m}`, files, assets(`days-${m}`, `Raw prices ${m}`, 'Daily TCGplayer prices (via tcgcsv.com), one gzipped TSV per day: pid, subtype (N/F/…), market, low, mid, directLow, high — USD cents, 0 = none.'));
}
if (process.argv.includes('--recovered')) {
  const extra = path.join(ROOT, 'cache', 'extra'), raw = path.join(ROOT, 'cache', 'raw');
  const files = [...fs.readdirSync(extra).filter(f => f.endsWith('.tsv.gz')).map(f => path.join(extra, f)),
                 ...fs.readdirSync(raw).filter(f => !f.endsWith('.part')).map(f => path.join(raw, f))];
  upload('recovered-pre2024', files, assets('recovered-pre2024', 'Recovered pre-2024 price history',
    'Recovered once from Internet Archive copies: MTGJSON AllPrices (2022-01-06 and 2023-05-30 captures, ~90 daily points each) with AllIdentifiers for TCGplayer ids, and Scryfall bulk snapshots (2022-10 → 2024-01). *.tsv.gz are the converted day files (pid, subtype, market cents); the rest are the original downloads.'));
}
