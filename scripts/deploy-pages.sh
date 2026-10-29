#!/usr/bin/env bash
# Publish the static site to Cloudflare Pages. Uploads only the files the page
# needs (index.html, css, js, data), never scripts or tests.
# Usage: scripts/deploy-pages.sh [project-name]   (default: vp-county-map)
set -euo pipefail
cd "$(dirname "$0")/.."
project="${1:-vp-county-map}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cp -R index.html css js data "$out"/
find "$out" -name .DS_Store -delete
npx wrangler pages deploy "$out" --project-name "$project" --branch main --commit-dirty=true
