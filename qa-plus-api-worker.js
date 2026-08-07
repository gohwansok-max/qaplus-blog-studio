/**
 * QA PLUS Blog Studio — CheapSub CORS relay
 *
 * The browser supplies its own csk_ key in the request header.
 * This Worker stores no API key, request body, or generated content.
 */

const UPSTREAM_ORIGIN = "https://api.cheapai.im";
const UPSTREAM_TARGETS = {
  cheapsub: "https://api.cheapai.im",
  openai: "https://api.openai.com"
};
const PUBLIC_IMAGE_PREFIX = "/blog-images/";
const MAX_STORED_IMAGE_BYTES = 10_000_000;
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const ALLOWED_IMAGE_SOURCE_HOSTS = new Set([
  "api.cheapai.im",
  "file.kayops.com"
]);

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

/**
 * 요청 경로를 상류 서비스와 상류 경로로 나눕니다.
 *   /cheapsub/v1/chat/completions -> {service:"cheapsub", path:"/v1/chat/completions"}
 *   /openai/v1/images/generations -> {service:"openai",   path:"/v1/images/generations"}
 *   /v1/chat/completions          -> {service:"cheapsub", path:"/v1/chat/completions"}  (구버전 호환)
 */
function routeRequest(pathname) {
  for (const service of Object.keys(UPSTREAM_TARGETS)) {
    const prefix = "/" + service;
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return { service, path: pathname.slice(prefix.length) || "/" };
    }
  }
  return { service: "cheapsub", path: pathname };
}

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

function decodeBase64(value) {
  const raw = atob(String(value || "").replace(/\s+/g,""));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function imageExtension(contentType) {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  return "jpg";
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2,"0")).join("");
}

async function imageKey(bytes, contentType) {
  const digest = await crypto.subtle.digest("SHA-256",bytes);
  return "generated/" + bytesToHex(new Uint8Array(digest)) + "." + imageExtension(contentType);
}

function publicImageUrl(request, key) {
  const url = new URL(request.url);
  url.pathname = PUBLIC_IMAGE_PREFIX + key;
  url.search = "";
  return url.toString();
}

function safeImageSource(value) {
  try {
    const url = new URL(String(value || ""),UPSTREAM_ORIGIN);
    if (url.protocol !== "https:" || !ALLOWED_IMAGE_SOURCE_HOSTS.has(url.hostname)) return null;
    return url;
  } catch (_) {
    return null;
  }
}

/** 매직 넘버로 실제 이미지 형식을 판별합니다. gpt-image 는 webp/png 를 돌려주기도 합니다. */
function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "image/jpeg";
}

async function loadGeneratedImage(item, request) {
  if (item?.b64_json) {
    const bytes = decodeBase64(item.b64_json);
    return {bytes,contentType:sniffImageType(bytes)};
  }

  const source = safeImageSource(item?.proxy_url || item?.url || item?.download_url);
  if (!source) throw new Error("이미지 공급자가 영구 저장 가능한 HTTPS 주소를 반환하지 않았습니다.");

  const headers = new Headers({Accept:"image/*"});
  if (source.hostname === "api.cheapai.im") {
    const authorization = request.headers.get("Authorization");
    if (authorization) headers.set("Authorization",authorization);
  }
  const response = await fetch(source.toString(),{headers,redirect:"follow"});
  if (!response.ok) throw new Error("생성 이미지 원본을 저장소로 복사하지 못했습니다. (" + response.status + ")");
  const contentType = String(response.headers.get("Content-Type") || "image/jpeg").split(";")[0].trim().toLowerCase();
  if (!/^image\/(?:jpeg|png|webp)$/.test(contentType)) {
    throw new Error("생성 이미지 응답 형식을 확인하지 못했습니다.");
  }
  return {bytes:new Uint8Array(await response.arrayBuffer()),contentType};
}

async function persistGeneratedImages(data, request, env) {
  if (!env?.BLOG_IMAGES) throw new Error("BLOG_IMAGES 저장소가 연결되지 않았습니다.");
  const items = Array.isArray(data?.data) ? data.data : [];
  if (!items.length) return data;

  const storedItems = [];
  for (const item of items) {
    const loaded = await loadGeneratedImage(item,request);
    if (!loaded.bytes.length || loaded.bytes.length > MAX_STORED_IMAGE_BYTES) {
      throw new Error("생성 이미지 크기가 영구 저장 허용 범위를 벗어났습니다.");
    }
    const key = await imageKey(loaded.bytes,loaded.contentType);
    const storedBytes = loaded.bytes.buffer.slice(
      loaded.bytes.byteOffset,
      loaded.bytes.byteOffset + loaded.bytes.byteLength
    );
    await env.BLOG_IMAGES.put(key,storedBytes,{
      metadata:{
        contentType:loaded.contentType,
        cacheControl:IMAGE_CACHE_CONTROL
      }
    });
    const stableUrl = publicImageUrl(request,key);
    storedItems.push({
      ...item,
      b64_json:undefined,
      url:stableUrl,
      proxy_url:stableUrl,
      persistent_url:stableUrl
    });
  }
  return {...data,data:storedItems};
}

async function serveStoredImage(request, env) {
  if (!env?.BLOG_IMAGES) {
    return new Response("Image storage unavailable",{status:503});
  }
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.slice(PUBLIC_IMAGE_PREFIX.length));
  if (!key || key.includes("..")) return new Response("Not found",{status:404});
  const stored = await env.BLOG_IMAGES.getWithMetadata(key,{type:"arrayBuffer"});
  if (!stored?.value) return new Response("Not found",{status:404});
  const headers = new Headers({
    "Content-Type":stored.metadata?.contentType || "image/jpeg",
    "Cache-Control":stored.metadata?.cacheControl || IMAGE_CACHE_CONTROL
  });
  headers.set("Access-Control-Allow-Origin","*");
  headers.set("X-Content-Type-Options","nosniff");
  return new Response(stored.value,{status:200,headers});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const originAllowed = ALLOWED_ORIGINS.has(origin);

    if (request.method === "GET" && url.pathname.startsWith(PUBLIC_IMAGE_PREFIX)) {
      return serveStoredImage(request,env);
    }

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

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response(JSON.stringify({
        ok: true,
        usage: "/cheapsub/v1/chat/completions 또는 /openai/v1/images/generations 형태로 호출하세요."
      }), {
        status: 200,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    }

    const route = routeRequest(url.pathname);
    const upstreamOrigin = UPSTREAM_TARGETS[route.service];

    const methods = ALLOWED_PATHS.get(route.path);
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
      upstream = await fetch(`${upstreamOrigin}${route.path}${url.search}`, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.method === "GET" ? undefined : request.body,
        redirect: "follow"
      });
    } catch (error) {
      return jsonResponse(
        origin,
        502,
        `${route.service === "openai" ? "OpenAI" : "CheapSub"} 연결 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
      );
    }

    if (route.path === "/v1/images/generations" && upstream.ok) {
      let data;
      try {
        data = await upstream.json();
        data = await persistGeneratedImages(data,request,env);
      } catch (error) {
        return jsonResponse(
          origin,
          502,
          `생성 이미지를 모바일에서도 보이는 영구 저장소에 보관하지 못했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
        );
      }
      return new Response(JSON.stringify(data),{
        status:200,
        headers:{
          ...corsHeaders(origin),
          "Content-Type":"application/json; charset=utf-8",
          "Cache-Control":"no-store"
        }
      });
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
