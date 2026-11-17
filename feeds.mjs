#!/usr/bin/env node
// The Wire, without Reddit: newest MTG headlines from public RSS/Atom feeds that answer
// servers (GitHub Actions). Writes <out>/feeds.json in ORACLE's existing shape:
//   { updated, wire: [{ t: title, u: url, s: 0, c: unixSeconds, f: '', src: 'EDHREC' }] }
// A feed that fails is skipped; if every feed fails the old file is left untouched.
import fs from 'node:fs';
import path from 'node:path';

const UA = 'OracleNewsWire/1.0 (+https://doggiedance.github.io/ORACLE/)';
export const FEEDS = [
  { src: 'EDHREC', url: 'https://edhrec.com/articles/feed', weight: 3 },          // Commander-first
  { src: 'MTGGoldfish', url: 'https://www.mtggoldfish.com/feed', weight: 2 },
  { src: 'Card Kingdom', url: 'https://blog.cardkingdom.com/feed/', weight: 2 },
  { src: 'Star City Games', url: 'https://articles.starcitygames.com/feed/', weight: 2 },
  { src: 'Draftsim', url: 'https://draftsim.com/feed/', weight: 1 },
  { src: 'Hipsters of the Coast', url: 'https://www.hipstersofthecoast.com/feed/', weight: 1 },
  { src: 'MTG Rocks', url: 'https://mtgrocks.com/feed/', weight: 1 },
  { src: 'Wargamer', url: 'https://www.wargamer.com/magic-the-gathering/feed', weight: 1 },
  { src: 'Scryfall', url: 'https://scryfall.com/blog/feed', weight: 2 },
];
const MAX_AGE_DAYS = 10, PER_SOURCE = 3, KEEP = 24;
// Multi-game sites: drop headlines that are plainly about another TCG.
const OTHER_TCG = /\b(sorcery:? contested realm|pok[eé]mon|lorcana|one piece|flesh and blood|yu-?gi-?oh|star wars unlimited|digimon|altered tcg|gundam card|riftbound|union arena|weiss schwarz)\b/i;

const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#0?39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (x, name) => { const m = x.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };

export function parseFeed(xml) {
  const items = [];
  const blocks = xml.includes('<entry') ? xml.split(/<entry\b/i).slice(1) : xml.split(/<item\b/i).slice(1);
  for (const raw of blocks) {
    const b = raw.split(/<\/(entry|item)>/i)[0];
    const title = decode(tag(b, 'title'));
    let link = decode(tag(b, 'link'));
    if (!link) { const m = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i) || b.match(/<link[^>]*href=["']([^"']+)/i); link = m ? m[1] : ''; }
    const date = decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const t = Date.parse(date);
    if (title && /^https?:\/\//.test(link)) items.push({ title, link, t: Number.isFinite(t) ? t : 0 });
  }
  return items;
}

async function fetchFeed(f) {
  const r = await fetch(f.url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseFeed(await r.text());
}

export async function buildWire({ now = Date.now(), log = console.log } = {}) {
  const all = [], status = [];
  for (const f of FEEDS) {
    try {
      const items = (await fetchFeed(f)).filter(i => !OTHER_TCG.test(i.title) && i.t && now - i.t < MAX_AGE_DAYS * 864e5 && i.t <= now + 36e5);
      items.sort((a, b) => b.t - a.t);
      items.slice(0, PER_SOURCE).forEach((i, k) => all.push({ ...i, src: f.src, rank: (now - i.t) / 36e5 - f.weight * 6 + k * 8 }));
      status.push(`${f.src}: ${items.length}`);
    } catch (e) { status.push(`${f.src}: FAILED (${e.message})`); }
  }
  log('feeds: ' + status.join(', '));
  // Fresh first, nudged toward Commander-focused sources; one source can't fill the top 3.
  all.sort((a, b) => a.rank - b.rank);
  const out = [], perSrcTop = {};
  for (const i of all) {
    if (out.length < 3 && perSrcTop[i.src]) continue;
    perSrcTop[i.src] = 1; out.push(i);
  }
  for (const i of all) if (!out.includes(i)) out.push(i);
  const seen = new Set();
  return out.filter(i => !seen.has(i.link) && seen.add(i.link)).slice(0, KEEP)
    .map(i => ({ t: i.title, u: i.link, s: 0, c: Math.floor(i.t / 1000), f: '', src: i.src }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] || 'public';
  const wire = await buildWire();
  const file = path.join(outDir, 'feeds.json');
  if (!wire.length) { console.log('no items from any feed — keeping the old feeds.json'); process.exit(0); }
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...prev, updated: new Date().toISOString(), wire }, null, 1));
  console.log(`wrote ${wire.length} items → ${file}`);
  wire.slice(0, 5).forEach(w => console.log(`  [${w.src}] ${w.t}`));
}
