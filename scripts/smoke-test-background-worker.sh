#!/usr/bin/env bash
set -euo pipefail

ACCESS_KEY="$(cat /tmp/qaplus-server-access-key.txt)"
RESPONSE="$(mktemp)"
STATUS="$(curl --silent --show-error --output "$RESPONSE" --write-out '%{http_code}' \
  -X POST 'https://qa-plus-api.gohwansok.workers.dev/jobs' \
  -H 'Origin: https://gohwansok-max.github.io' \
  -H 'Content-Type: application/json' \
  -H "X-QA-PLUS-ACCESS-KEY: $ACCESS_KEY" \
  --data '{"topic":"","script":""}')"

if [[ "$STATUS" != "400" ]]; then
  cat "$RESPONSE" >&2
  echo "Expected HTTP 400 after authenticated validation, got $STATUS" >&2
  exit 1
fi
if ! grep -q '영상 제목 또는 핵심 주제를 입력해 주세요' "$RESPONSE"; then
  cat "$RESPONSE" >&2
  exit 1
fi
rm -f "$RESPONSE"
echo 'Deployed background job API authentication and validation: PASS'
