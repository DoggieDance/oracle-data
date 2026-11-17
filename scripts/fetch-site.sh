#!/usr/bin/env bash
# Pull the currently published data (orphan `site` branch) into ./public — it is the state we build on.
# Before the first upload there is no `site` branch yet: start from an empty public/.
set -euo pipefail
rm -rf public
if git ls-remote --exit-code --heads "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" site >/dev/null 2>&1; then
  git clone -q --depth 1 --branch site "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" public
  rm -rf public/.git
else
  echo "no site branch yet — starting empty"
  mkdir -p public
fi
