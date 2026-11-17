#!/usr/bin/env bash
# Publish ./public as ONE commit on the orphan `site` branch (GitHub Pages source).
# Force-pushing a single commit keeps the repo the size of one snapshot instead of
# growing every day. Old snapshots become unreachable and GitHub garbage-collects them.
set -euo pipefail
msg="${1:-Update data}"
cd public
rm -rf .git
git init -q -b site
git config user.name "oracle-data-bot"
git config user.email "oracle-data-bot@users.noreply.github.com"
git add -A
git commit -q -m "$msg"
git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" site:site
rm -rf .git
echo "published: $msg"
