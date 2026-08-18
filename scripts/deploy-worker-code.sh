#!/usr/bin/env bash
set -euo pipefail
IFS= read -r CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
cd /home/ubuntu/qaplus-blog-studio
npx --yes wrangler deploy
