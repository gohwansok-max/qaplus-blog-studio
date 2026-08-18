#!/usr/bin/env bash
set -euo pipefail
IFS= read -r CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
npx --yes wrangler whoami
