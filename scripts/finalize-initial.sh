#!/usr/bin/env bash
# One-time: publish the full history (built on this PC) as the oracle-data site, then deploy it.
# After this the GitHub Actions take over: prices daily, wire every 3 h.
set -euo pipefail
cd "$(dirname "$0")/.."
export GH_TOKEN="$(gh auth token)" GITHUB_REPOSITORY="DoggieDance/oracle-data"

echo "== full build from every cached source"
node sync.mjs build
echo "== keep the latest wire the Action published (if any)"
curl -sf "https://doggiedance.github.io/oracle-data/feeds.json" -o public/feeds.json || node feeds.mjs public
echo "== push public/ as the single-commit site branch (size: $(du -sh public | cut -f1))"
scripts/publish-site.sh "Initial full history through $(node -p "require('./public/prices/meta.json').latest")"
echo "== deploy via the wire workflow (it loads the site branch, refreshes the wire, deploys everything)"
gh workflow run wire.yml -R "$GITHUB_REPOSITORY"
