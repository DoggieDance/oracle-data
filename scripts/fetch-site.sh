#!/usr/bin/env bash
# Pull the currently published data (orphan `site` branch) into ./public — it is the state we build on.
set -euo pipefail
rm -rf public
git clone -q --depth 1 --branch site "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" public
rm -rf public/.git
