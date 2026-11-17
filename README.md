# oracle-data

Self-updating data for [ORACLE](https://doggiedance.github.io/ORACLE/). It's published to GitHub Pages at `https://doggiedance.github.io/oracle-data/`, and nothing has to run on anyone's PC.

| Workflow | When | What |
|---|---|---|
| `prices.yml` | daily, 23:17 UTC | Pulls the day's TCGplayer prices from [TCGCSV](https://tcgcsv.com), adds them to the price history, recomputes Price Watch movers, archives the raw day as a Release asset, and deploys. |
| `wire.yml` | every 3 h | Rebuilds the news Wire from public MTG news RSS feeds (EDHREC, MTGGoldfish, Card Kingdom, SCG, Draftsim and others) and deploys. |
| `keepalive.yml` | monthly | Touches `main` so GitHub doesn't pause the schedules after 60 quiet days. |

## Published files

```
feeds.json                 { updated, wire: [{ t, u, s, c, f, src }] }
prices/meta.json           { latest, dates[], src[] (t=TCGCSV m=MTGJSON s=Scryfall), shards }
prices/latest/<pid%256>.json   { d, p: { pid: [nMarket,nLow,nMid,nDirectLow, fMarket,fLow,fMid,fDirectLow] } }  (cents)
prices/hist/<pid%1024>.json    { pid: { n: [startIndex, ...cents], f: [...] } }   aligned to meta.dates, 0 = no data
prices/movers.json         biggest 7-day drops/climbs, singles and sealed, noise-filtered
```

`pid` is the TCGplayer product id, which Scryfall exposes as `card.tcgplayer_id`. History has daily points for the last 90 days and one point per fixed 7-day bucket before that.

## History coverage

| Period | Source | Granularity |
|---|---|---|
| Oct 2021 – Jan 2022 | MTGJSON AllPrices copy saved by the Internet Archive | daily |
| Oct 2022, Jan/Mar/Dec 2023 | Scryfall bulk snapshots saved by the Internet Archive | single days |
| Mar – May 2023 | MTGJSON AllPrices copy saved by the Internet Archive | daily |
| Feb 2024 → today | TCGCSV daily archive and live API | daily (raw kept in Releases) |

The pre-2024 points were recovered once by `history-extra.mjs`. As far as I could find, no other public source has them.

## Local tools (one-time / maintenance)

```
node sync.mjs backfill      # every TCGCSV archive day → cache/days (kept forever)
node history-extra.mjs      # pre-2024 recovery → cache/extra
node sync.mjs build         # full rebuild of public/prices from all cached sources
node sync.mjs update DATE   # incremental (what the Action runs); proven identical to a full rebuild
node feeds.mjs public       # rebuild the wire
```

TCGCSV etiquette is followed: one sync a day, a custom User-Agent, 120 ms between requests, archives fetched once. Prices are TCGplayer data, shown for personal deck-building.
