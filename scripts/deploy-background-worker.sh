#!/usr/bin/env bash
set -euo pipefail

# 토큰은 표준입력으로 한 번만 받으며 파일·저장소에 쓰지 않습니다.
IFS= read -r CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN

ROOT="/home/ubuntu/qaplus-blog-studio"
cd "$ROOT"

if grep -q '__BLOG_JOBS_NAMESPACE_ID__' wrangler.toml; then
  echo "Creating durable job-state storage..."
  CREATE_OUTPUT="$(npx --yes wrangler kv namespace create qa-plus-blog-jobs)"
  printf '%s\n' "$CREATE_OUTPUT"
  JOBS_ID="$(printf '%s\n' "$CREATE_OUTPUT" | sed -n 's/.*id = "\([a-f0-9]*\)".*/\1/p' | tail -n 1)"
  if [[ -z "$JOBS_ID" ]]; then
    echo "Unable to read the job-state storage ID." >&2
    exit 2
  fi
  sed -i "s/__BLOG_JOBS_NAMESPACE_ID__/$JOBS_ID/" wrangler.toml
fi

# 기존의 개인 전용 앱 키를 서버 Secret으로 옮겨 공개 HTML에서 제거합니다.
CHEAPSUB_API_KEY="$(git show HEAD:index.html | sed -n 's/^[[:space:]]*const BAKED_CSK = "\([^"]*\)";.*/\1/p' | head -n 1)"
GEMINI_API_KEY="$(git show HEAD:index.html | sed -n 's/^[[:space:]]*const BAKED_GEMINI = "\([^"]*\)";.*/\1/p' | head -n 1)"
if [[ -z "$CHEAPSUB_API_KEY" || -z "$GEMINI_API_KEY" ]]; then
  echo "Required server API keys were not found in the previous revision." >&2
  exit 3
fi

SERVER_ACCESS_KEY="$(openssl rand -hex 32)"
printf '%s' "$SERVER_ACCESS_KEY" > /tmp/qaplus-server-access-key.txt
chmod 600 /tmp/qaplus-server-access-key.txt

put_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | npx --yes wrangler secret put "$name"
}

# 기존 Worker가 버전 기반 배포를 사용 중이므로, 새 워크플로 정의를 먼저 배포합니다.
echo "Deploying workflow definition before secret registration..."
npx --yes wrangler deploy

echo "Registering server-only secrets..."
put_secret CHEAPSUB_API_KEY "$CHEAPSUB_API_KEY"
put_secret GEMINI_API_KEY "$GEMINI_API_KEY"
put_secret QA_PLUS_ACCESS_KEY "$SERVER_ACCESS_KEY"

echo "DEPLOYED"
echo "The browser access key is stored at /tmp/qaplus-server-access-key.txt"
