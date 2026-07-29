/**
 * QA PLUS Blog Studio — CheapSub CORS relay
 *
 * The browser supplies its own csk_ key in the request header.
 * This Worker stores no API key, request body, or generated content.
 */

const UPSTREAM_ORIGIN = "https://api.cheapsub.im";

const ALLOWED_ORIGINS = new Set([
  "https://gohwansok-max.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173"
]);

const ALLOWED_PATHS = new Map([
  ["/v1/chat/completions", new Set(["POST"])],
  ["/v1/responses", new Set(["POST"])],
  ["/v1/messages", new Set(["POST"])],
  ["/v1/images/generations", new Set(["POST"])],
  ["/v1/images/proxy", new Set(["GET"])],
  ["/v1/models", new Set(["GET"])]
]);

const FORWARDED_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta"
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-api-key, anthropic-version, anthropic-beta, content-type, accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResponse(origin, status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const originAllowed = ALLOWED_ORIGINS.has(origin);

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    if (!originAllowed) {
      return new Response(
        JSON.stringify({ error: { message: "허용되지 않은 출처입니다." } }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Vary": "Origin"
          }
        }
      );
    }

    const methods = ALLOWED_PATHS.get(url.pathname);
    if (!methods) {
      return jsonResponse(origin, 404, "지원하지 않는 경로입니다.");
    }
    if (!methods.has(request.method)) {
      return jsonResponse(origin, 405, "지원하지 않는 요청 방식입니다.");
    }

    if (
      request.method === "POST" &&
      !request.headers.get("Authorization") &&
      !request.headers.get("x-api-key")
    ) {
      return jsonResponse(origin, 401, "CheapSub API 키가 필요합니다.");
    }

    const contentLength = Number(request.headers.get("Content-Length") || "0");
    if (contentLength > 2_000_000) {
      return jsonResponse(origin, 413, "요청 본문이 너무 큽니다.");
    }

    const upstreamHeaders = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) upstreamHeaders.set(name, value);
    }

    let upstream;
    try {
      upstream = await fetch(`${UPSTREAM_ORIGIN}${url.pathname}${url.search}`, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.method === "GET" ? undefined : request.body,
        redirect: "follow"
      });
    } catch (error) {
      return jsonResponse(
        origin,
        502,
        `CheapSub 연결 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
      );
    }

    const responseHeaders = new Headers(upstream.headers);
    for (const [name, value] of Object.entries(corsHeaders(origin))) {
      responseHeaders.set(name, value);
    }
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.delete("Set-Cookie");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  }
};
