import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-api-key, x-qa-plus-access-key, x-qa-plus-job-key, anthropic-version, anthropic-beta, content-type, accept",
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

/* ------------------------------------------------------------------
 * 내구형 블로그 작업실
 *
 * 브라우저는 작업을 등록하고 상태만 읽습니다. 생성·재시도·중간 저장은
 * Cloudflare Workflow와 KV에서 수행하므로 탭 종료/절전과 무관합니다.
 * API 키는 Worker Secret에만 두며, 작업 등록에는 별도 접근 키가 필요합니다.
 * ------------------------------------------------------------------ */
const JOB_PREFIX = "blog-job/";
const JOB_TTL_SECONDS = 60 * 60 * 24 * 14;
const STEP_CONFIG = {
  retries: {limit: 6, delay: "10 seconds", backoff: "exponential"},
  timeout: "20 minutes"
};
const JOB_MODELS = {
  gpt: ["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","deepseek-v4-pro","glm-5.2","grok-4.5"],
  claude: ["claude-opus-5","claude-opus-4-8","claude-sonnet-5","claude-fable-5"]
};
const GEMINI_MODELS = ["gemini-3.7-flash","gemini-3.6-flash","gemini-3-flash-preview","gemini-3.5-flash","gemini-2.5-flash"];
const JOB_RULES = `
[QA PLUS 원칙 — 반드시 지킬 것]
- 독자는 식품제조 현장의 품질·생산·위생 담당자입니다. 실무자가 오늘 바로 쓸 수 있게 씁니다.
- 대본과 공식 출처에 없는 법령 번호, 고시 번호, 기준 수치, 처벌 조항, 인증 요구사항은 절대 만들지 않습니다.
- 확실하지 않은 내용은 단정하지 말고 "확인이 필요합니다"라고 씁니다.
- 특정 업체·제품을 비방하거나 홍보하지 않습니다. 실제 회사명·개인정보는 쓰지 않습니다.
- 겁주는 표현이나 과장을 쓰지 않습니다. 제목은 궁금하게, 내용은 차분하고 정확하게.
- 분량 채우기용 군더더기·동어반복·빈 수식어는 금지합니다. 한 문장에 하나의 실무 판단 또는 조치가 드러나야 합니다.`;
const JOB_QUALITY = `
[검색·체류시간을 위한 필수 조건]
- 영상 내용을 그대로 옮겨 적지 않습니다. 배경, 제도 원리, 판단 기준, 실제 사례, 흔한 실수, 절차를 더해 읽는 사람에게만 주는 가치를 만듭니다.
- 독자가 이 글만 읽고도 스스로 조치할 수 있을 만큼 구체적으로 씁니다. 무엇을 보고, 어떻게 판단하고, 어디에 기록하는지를 담습니다.
- 같은 말을 다르게 반복해서 분량을 늘리지 않습니다. 문단마다 새로운 정보가 있어야 합니다.
- 표, 체크리스트, 단계별 절차, 자주 묻는 질문을 반드시 포함합니다.`;
const JOB_DRIVE_URL = "https://drive.google.com/drive/folders/1tHqeagzD__Oqjc027TVJhcWQC0JkOIV6?usp=sharing";
const JOB_IMAGE_STYLES = {
  photo: "photorealistic documentary photograph of a real Korean small-to-mid-sized food factory, static camera, practical cool-white 5000-5600K fluorescent lighting, decade-used stainless surfaces with faint water spots, glossy green epoxy floor with realistic scuffs, orderly irregularity rather than a staged showroom, natural material texture, 16:9 landscape",
  illust: "clean editorial illustration for a food-safety guide, muted teal and navy palette, flat vector style, calm and professional, Korean factory setting, soft paper texture",
  mixed: "photorealistic documentary factory photograph for the cover image and clean flat editorial illustration for body images, muted teal and navy palette, Korean food factory setting"
};
const JOB_CATEGORY_SCENES = {
  "HACCP": "production floor / hygiene anteroom / monitoring record review",
  "FSSC 22000": "raw material warehouse audit / audit response office / production-line verification",
  "식품안전": "handwashing station / heating process room / metal-detection packaging line",
  "품질관리": "quality laboratory / quality-control office / on-site verification",
  "무료자료": "checklist close-up / training material room / practical field-use scene"
};
const JOB_IMAGE_NEGATIVE = "no readable text, no letters, no numbers, no Korean lettering, no equipment model numbers, no brand logos, no watermark, no identifiable face, no exposed hair, no missing mask, no 3D render, no CGI, no spotless showroom cleanroom, no brand-new factory, no futuristic laboratory, no neon lighting, no fisheye, no dutch angle";

function nowIso() { return new Date().toISOString(); }
function jobStorageKey(id) { return JOB_PREFIX + id; }
function randomId(prefix) {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return prefix + "-" + bytesToHex(bytes);
}
function jsonNoStore(origin, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {...corsHeaders(origin), "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"}
  });
}
function sameSecret(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left.length !== right.length) return false;
  let different = 0;
  for (let i = 0; i < left.length; i += 1) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}
function hasAccess(request, env) {
  return Boolean(env?.QA_PLUS_ACCESS_KEY) && sameSecret(request.headers.get("X-QA-PLUS-ACCESS-KEY"), env.QA_PLUS_ACCESS_KEY);
}
function cleanJobError(error) {
  return String(error?.message || error || "알 수 없는 오류")
    .replace(/Bearer\s+\S+/gi, "Bearer [숨김]")
    .replace(/(?:csk_|sk-|AIza)[A-Za-z0-9_\-]+/g, "[숨김]")
    .slice(0, 600);
}
function validJobUrl(value) {
  try { return ["http:","https:"].includes(new URL(String(value || "")).protocol); } catch (_) { return false; }
}
function getJobVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0];
    if (url.hostname.includes("youtube.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) => ["shorts","embed","live"].includes(part));
      if (marker >= 0) return parts[marker + 1] || "";
    }
  } catch (_) {}
  return (raw.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/) || [])[1] || "";
}
function normalizeJobInput(raw) {
  const topic = String(raw?.topic || "").trim().slice(0, 300);
  const script = String(raw?.script || "").trim().slice(0, 180000);
  const videoUrl = String(raw?.videoUrl || "").trim().slice(0, 2048);
  if (!topic) throw new NonRetryableError("영상 제목 또는 핵심 주제를 입력해 주세요.");
  if (!videoUrl && script.length < 120) throw new NonRetryableError("YouTube 영상 주소를 넣거나 대본을 120자 이상 넣어 주세요.");
  if (videoUrl && !getJobVideoId(videoUrl)) throw new NonRetryableError("YouTube 영상 주소 형식을 확인해 주세요.");
  const category = ["HACCP","FSSC 22000","식품안전","품질관리","무료자료"].includes(raw?.category) ? raw.category : "HACCP";
  const targetChars = [6000,9000,12000].includes(Number(raw?.targetChars)) ? Number(raw.targetChars) : 9000;
  const imgCount = Math.max(0, Math.min(5, Number(raw?.imgCount) || 0));
  const sources = Array.isArray(raw?.sources) ? raw.sources.filter(validJobUrl).slice(0,12) : [];
  const imgStyle = ["photo","illust","mixed"].includes(raw?.imgStyle) ? raw.imgStyle : "photo";
  const imgQuality = ["low","medium","high"].includes(raw?.imgQuality) ? raw.imgQuality : "medium";
  const imgRoute = ["auto","cheapsub","openai-direct","openai-proxy"].includes(raw?.imgRoute) ? raw.imgRoute : "auto";
  const m1 = String(raw?.m1 || "gpt-5.6-sol");
  const m2 = String(raw?.m2 || "claude-opus-5");
  const gmModel = String(raw?.gmModel || "gemini-3.7-flash");
  const imgModel = String(raw?.imgModel || "gpt-image-2");
  return {topic, script, videoUrl, videoId:getJobVideoId(videoUrl), category, targetChars, imgCount, sources, imgStyle, imgQuality, imgRoute, m1, m2, gmModel, imgModel};
}
async function readJob(env, id) {
  if (!env?.BLOG_JOBS) throw new Error("BLOG_JOBS 저장소가 연결되지 않았습니다.");
  const raw = await env.BLOG_JOBS.get(jobStorageKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function writeJob(env, job) {
  job.updatedAt = nowIso();
  await env.BLOG_JOBS.put(jobStorageKey(job.id), JSON.stringify(job), {expirationTtl:JOB_TTL_SECONDS});
  return job;
}
async function patchJob(env, id, patch) {
  const job = await readJob(env, id);
  if (!job) throw new Error("작업 상태를 찾지 못했습니다.");
  Object.assign(job, patch);
  return writeJob(env, job);
}
function jobForClient(job) {
  if (!job) return null;
  const {jobKey, ...safe} = job;
  return safe;
}
function isRetryableStatus(status) { return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599); }
function modelCandidates(preferred) {
  const family = /^claude-/i.test(preferred) ? JOB_MODELS.claude : JOB_MODELS.gpt;
  return [...new Set([preferred, ...family])];
}
function isUnavailableModelError(error) {
  return /fixed_merchant_unavailable|model_not_found|model_not_allowed|no_such_model|이용할 수 없습니다|HTTP 404/i.test(String(error?.message || ""));
}
function makeUpstreamError(service, response, detail) {
  const error = new Error(`${service} HTTP ${response.status}: ${String(detail || "응답 오류").slice(0, 360)}`);
  error.status = response.status;
  if (response.status === 401 || response.status === 403 || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 425 && response.status !== 429)) error.permanent = true;
  return error;
}
function maybePermanent(error) {
  if (error?.permanent) return new NonRetryableError(cleanJobError(error));
  return error;
}
function joinJobContinuation(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  const max = Math.min(600, a.length, b.length);
  for (let n = max; n >= 30; n -= 1) if (a.slice(-n) === b.slice(0,n)) return a + b.slice(n);
  return a + b;
}
function textOnlyLength(html) { return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length; }
function stripCodeFence(value) { return String(value || "").replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim(); }
function jobSystemOutline() {
  return `당신은 QA PLUS의 식품안전 콘텐츠 기획자입니다. 받은 재료로 깊이 있는 장문 실무 글의 설계도를 만듭니다.\n${JOB_RULES}\n${JOB_QUALITY}\n[출력] 마크다운. 다음을 모두 포함합니다.\n1) 이 주제를 검색하는 현장 담당자가 실제로 궁금해할 질문 10개\n2) 소제목 9~11개 — 각 소제목마다 다룰 내용을 3줄씩 구체적으로 메모\n3) 본문에 넣을 표 1~2개의 구성안\n4) 실제 현장 사례 2~3가지의 뼈대\n5) 흔한 실수 7가지\n6) 현장 체크리스트 10항목\n7) 대본에 근거가 없어 확인이 필요한 주장 목록\n설명 없이 결과만 출력합니다.`;
}
function jobSystemDraft(input) {
  const embed = input.videoId ? `- 도입부 다음에 유튜브 영상을 넣습니다: <iframe src="https://www.youtube-nocookie.com/embed/${input.videoId}" title="${input.topic}" loading="lazy" allowfullscreen></iframe>` : "- 영상 삽입 코드는 넣지 않습니다.";
  const src = input.sources.length ? `- 글 마지막 참고자료에 아래 주소만 링크로 넣습니다. 다른 주소를 만들지 마세요.\n${input.sources.map((s) => "  " + s).join("\n")}` : "- 공식 출처가 제공되지 않았으므로 참고자료 링크를 만들지 않습니다.";
  return `당신은 20년 경력의 QA PLUS 식품안전 편집장입니다. 설계도를 받아 완성된 장문 실무 글을 씁니다.\n${JOB_RULES}\n${JOB_QUALITY}\n[분량] 공백 포함 ${input.targetChars}자 이상. 이것은 최소 기준입니다. 절대 짧게 끝내지 마세요.\n[문체] 존댓말. 한 문단 3~5줄. 현장 담당자에게 차분히 설명하듯. 과장 없이.\n[반드시 넣을 구성]\n- <h2> 글 제목 (첫 줄)\n${embed}\n- 도입부 3~4문단\n- <h2> 소제목 9개 이상, 각 소제목 아래 최소 4문단\n- <table> 실무 표 1개 이상 (<thead><tbody><th scope> 사용, <caption> 포함)\n- <ul> 현장 체크리스트 2개 이상 (합계 10항목 이상)\n- 현장 사례 2개 이상 (<blockquote> 활용, 회사명 없이)\n- 흔한 실수 7개 이상\n- 자주 묻는 질문 5개와 답변\n${src}\n- 마무리 직전에 QA PLUS 무료자료 안내: <p><a href="${JOB_DRIVE_URL}" target="_blank" rel="noopener noreferrer">QA PLUS 무료자료 받기</a></p>\n- 마지막 줄에 <p><em>이 글은 일반 실무 참고용이며, 적용 전 최신 기준과 소관 기관 고시를 반드시 확인하시기 바랍니다.</em></p>\n[형식] 순수 HTML 조각만 출력합니다. <html> <head> <body> 마크다운 기호 코드펜스는 절대 쓰지 않습니다. <script> <style> <img>는 넣지 않습니다.`;
}
function jobSystemFinal(input) {
  const need = input.targetChars >= 9000 ? 2 : 1;
  return `당신은 QA PLUS의 최종 장문 편집장입니다. 받은 원고를 더 깊고 풍성하게 고쳐 씁니다.\n${JOB_RULES}\n${JOB_QUALITY}\n[할 일]\n1) 설명이 얕은 문단에 판단 기준·원인·실행 방법·후속 확인을 덧붙입니다.\n2) 소제목이 9개 미만이면 실무에 도움 되는 섹션을 더 만듭니다.\n3) 실무 표가 ${need}개 미만이면 추가합니다.\n4) 사례에 상황·조치·결과를 구체적으로 씁니다.\n5) 같은 말이 반복되면 지우고 새 정보로 바꿉니다.\n6) 흔한 실수 7개, 체크리스트 10항목, FAQ 5개를 채웁니다.\n7) 대본과 공식 출처에 없는 수치·법령을 새로 만들지 않습니다.\n[유지] 영상 삽입 코드, 참고자료 링크, 무료자료 안내, 마지막 면책 문구는 그대로 유지합니다.\n[분량] 결과는 반드시 ${input.targetChars}자 이상이며 원문보다 짧아지면 안 됩니다.\n[형식] 전체 글을 처음부터 끝까지 순수 HTML 조각으로 다시 출력합니다. 요약하거나 생략하지 말고 전문을 출력하세요.`;
}
function jobSystemPack(input) {
  const style = JOB_IMAGE_STYLES[input.imgStyle] || JOB_IMAGE_STYLES.photo;
  const zones = JOB_CATEGORY_SCENES[input.category] || JOB_CATEGORY_SCENES.HACCP;
  return `당신은 QA PLUS 블로그의 편집자입니다. 완성된 글을 읽고 발행에 필요한 정보를 만듭니다.\n${JOB_RULES}\n[출력] 아래 JSON 하나만 출력합니다. 설명·코드펜스·다른 문장은 절대 쓰지 않습니다.\n{"title":"검색에 걸리면서 과장 없는 한국어 제목 (12~40자)","description":"검색결과 설명 40~140자","labels":["Blogger 라벨 3~5개"],"keywords":["실제 검색어 6~8개"],"images":[{"role":"cover","prompt":"English prompt","alt":"한국어 대체 텍스트"},{"role":"body","prompt":"English prompt","alt":"한국어 대체 텍스트"}]}\n[이미지 프롬프트는 영어] 공통 스타일: ${style}\n분야 ${input.category}에서 서로 다른 장면을 고릅니다: ${zones}\n한 장은 넓은 공간, 한 장은 장갑 낀 손 중간 샷, 한 장은 물건 클로즈업으로 거리를 다르게 합니다. 글자·로고·식별 가능한 얼굴을 만들지 않습니다. 모든 프롬프트 끝에 다음을 붙입니다: ${JOB_IMAGE_NEGATIVE}`;
}
async function callCheapSub(env, model, messages, maxTokens) {
  if (!env?.CHEAPSUB_API_KEY) throw new NonRetryableError("서버 글쓰기 API 키가 설정되지 않았습니다.");
  const isGPT = /^gpt-/i.test(model);
  const bodies = isGPT
    ? [{model,messages,stream:false,max_completion_tokens:maxTokens},{model,messages,stream:false,max_tokens:maxTokens,temperature:0.85}]
    : [{model,messages,stream:false,max_tokens:maxTokens,temperature:0.85},{model,messages,stream:false,max_completion_tokens:maxTokens}];
  let lastError;
  for (const body of bodies) {
    let response;
    try {
      response = await fetch("https://api.cheapai.im/v1/chat/completions", {method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer " + env.CHEAPSUB_API_KEY},body:JSON.stringify(body)});
    } catch (error) { throw error; }
    const raw = await response.text();
    if (!response.ok) {
      const error = makeUpstreamError("글쓰기 서비스",response,raw);
      if (response.status === 400 && /token|temperature|parameter|unsupported/i.test(raw)) { lastError = error; continue; }
      throw error;
    }
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error("글쓰기 서비스가 JSON 응답을 반환하지 않았습니다."); }
    const text = String(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.delta?.content ?? "").trim();
    if (text) return {text, finish:data?.choices?.[0]?.finish_reason || "stop", model};
    lastError = new Error("글쓰기 서비스가 빈 응답을 반환했습니다.");
  }
  throw lastError || new Error("글쓰기 응답을 받지 못했습니다.");
}
async function callJobLLM(env, preferred, system, user, maxTokens) {
  let last;
  for (const candidate of modelCandidates(preferred)) {
    try { return await callCheapSub(env,candidate,[{role:"system",content:system},{role:"user",content:user}],maxTokens); }
    catch (error) {
      last = error;
      if (isUnavailableModelError(error)) continue;
      throw maybePermanent(error);
    }
  }
  throw maybePermanent(last || new Error("사용 가능한 글쓰기 모델이 없습니다."));
}
async function runDurableLong(workflow, step, job, phase, preferred, system, user, maxTokens, target, rounds, initial = "") {
  let full = initial || "";
  let lastFinish = full ? "interrupted" : "";
  const maxCalls = rounds + 4;
  for (let call = 1; call <= maxCalls; call += 1) {
    const prompt = !full ? user : `${user}\n\n[지금까지 작성한 원고]\n${full}\n\n${lastFinish === "length" || lastFinish === "interrupted" ? "원고가 중간에서 끊겼습니다. 마지막 글자 다음부터만 이어서 HTML로 출력하세요. 이미 쓴 부분은 반복하지 마세요." : "분량이 아직 목표에 못 미칩니다. 아직 다루지 않은 소제목·표·사례·FAQ를 더해 HTML로 이어서 출력하세요. 이미 쓴 내용은 반복하지 마세요."}`;
    await patchJob(workflow.env, job.id, {stage:phase, message:`${phase} ${call}차 생성 중…`, partial:{...(job.partial || {}), [phase]:full}});
    const got = await step.do(`${phase}-${call}`, STEP_CONFIG, async () => callJobLLM(workflow.env,preferred,system,prompt,maxTokens));
    full = joinJobContinuation(full, got.text);
    lastFinish = got.finish;
    job.usedModels = [...new Set([...(job.usedModels || []), got.model])];
    job.partial = {...(job.partial || {}), [phase]:full};
    await writeJob(workflow.env,job);
    const enough = !target || textOnlyLength(full) >= target;
    if ((got.finish !== "length" && enough) || (got.finish !== "length" && textOnlyLength(full) >= target * 0.92)) break;
  }
  if (!full.trim()) throw new Error(`${phase} 단계에서 결과를 받지 못했습니다.`);
  return stripCodeFence(full);
}
async function extractTranscript(env, input) {
  if (!input.videoUrl || !env?.GEMINI_API_KEY) return "";
  const prompt = "이 유튜브 영상을 처음부터 끝까지 보고, 말한 내용을 한국어로 그대로 받아써 주세요. 타임스탬프·화자 표시·회차 번호·설명은 넣지 않습니다. 화면의 중요한 글자·숫자·표·기준 이름이 나오면 해당 문장 뒤에 (화면: ...)으로 덧붙입니다.";
  const candidates = [...new Set([input.gmModel, ...GEMINI_MODELS])];
  let last;
  for (const model of candidates) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{file_data:{file_uri:input.videoUrl}},{text:prompt}]}],generationConfig:{temperature:0.2,maxOutputTokens:32000}})});
      const raw = await response.text();
      if (!response.ok) throw makeUpstreamError("영상 대본 서비스",response,raw);
      const data = JSON.parse(raw);
      const text = (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
      if (text) return text;
      last = new Error(`${model} 모델이 빈 대본을 반환했습니다.`);
    } catch (error) {
      last = error;
      if (error?.permanent) throw maybePermanent(error);
    }
  }
  throw last || new Error("영상 대본을 추출하지 못했습니다.");
}
async function generateServerImage(env, prompt, input) {
  const errors = [];
  const cheapSub = async () => {
    if (!env?.CHEAPSUB_API_KEY) throw new NonRetryableError("서버 이미지 API 키가 설정되지 않았습니다.");
    const response = await fetch("https://api.cheapai.im/v1/images/generations", {method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer " + env.CHEAPSUB_API_KEY},body:JSON.stringify({model:input.imgModel,prompt,n:1,size:"1536x1024",quality:input.imgQuality,output_format:"jpeg",output_compression:88})});
    const raw = await response.text();
    if (!response.ok) throw makeUpstreamError("이미지 서비스",response,raw);
    const data = JSON.parse(raw);
    const stored = await persistGeneratedImages(data,new Request("https://qa-plus-api.gohwansok.workers.dev/v1/images/generations",{headers:{Authorization:"Bearer " + env.CHEAPSUB_API_KEY}}),env);
    const item = stored?.data?.[0];
    if (!item?.persistent_url && !item?.url) throw new Error("영구 이미지 주소를 만들지 못했습니다.");
    return {src:item.persistent_url || item.url, model:"칩섭 " + input.imgModel};
  };
  const openAI = async () => {
    if (!env?.OPENAI_API_KEY) throw new Error("서버 OpenAI 예비 키가 설정되지 않았습니다.");
    const response = await fetch("https://api.openai.com/v1/images/generations", {method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer " + env.OPENAI_API_KEY},body:JSON.stringify({model:input.imgModel,prompt,n:1,size:"1536x1024",quality:input.imgQuality,output_format:"webp"})});
    const raw = await response.text();
    if (!response.ok) throw makeUpstreamError("OpenAI 이미지 서비스",response,raw);
    const data = JSON.parse(raw);
    const stored = await persistGeneratedImages(data,new Request("https://qa-plus-api.gohwansok.workers.dev/openai/v1/images/generations",{headers:{Authorization:"Bearer " + env.OPENAI_API_KEY}}),env);
    const item = stored?.data?.[0];
    if (!item?.persistent_url && !item?.url) throw new Error("영구 이미지 주소를 만들지 못했습니다.");
    return {src:item.persistent_url || item.url, model:"OpenAI " + input.imgModel};
  };
  const routes = input.imgRoute === "cheapsub" ? [cheapSub] : (input.imgRoute === "openai-direct" || input.imgRoute === "openai-proxy" ? [openAI] : [cheapSub,openAI]);
  for (const route of routes) {
    try { return await route(); } catch (error) { errors.push(cleanJobError(error)); if (error instanceof NonRetryableError) throw error; }
  }
  throw new Error(errors.join(" / "));
}
function parsePack(text, input) {
  let pack = {};
  try { pack = JSON.parse((String(text).match(/\{[\s\S]*\}/) || [text])[0]); } catch (_) {}
  return {
    title:String(pack.title || input.topic || "QA PLUS").slice(0,120),
    description:String(pack.description || "").slice(0,150),
    labels:Array.isArray(pack.labels) ? pack.labels.map(String).filter(Boolean).slice(0,5) : [input.category],
    keywords:Array.isArray(pack.keywords) ? pack.keywords.map(String).filter(Boolean).slice(0,8) : [],
    images:Array.isArray(pack.images) ? pack.images.slice(0,input.imgCount).map((item,index) => ({role:item?.role === "cover" || index === 0 ? "cover" : "body",prompt:String(item?.prompt || "").slice(0,4000),alt:String(item?.alt || "").slice(0,300)})).filter((item) => item.prompt) : []
  };
}

export class BlogGenerationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const jobId = event.payload?.jobId;
    let job = await readJob(this.env,jobId);
    if (!job) throw new NonRetryableError("작업 기록을 찾지 못했습니다.");
    try {
      job.status = "running";
      job.stage = "1";
      job.message = "서버 작업실에서 준비 중…";
      await writeJob(this.env,job);
      const input = job.input;
      let script = input.script || "";
      if (!script && input.videoUrl) {
        script = await step.do("1-영상 대본 추출", STEP_CONFIG, async () => extractTranscript(this.env,input));
      }
      job.checkpoints = {...(job.checkpoints || {}), scriptText:script};
      job.stage = "2";
      job.message = script ? "대본을 확보했습니다. 설계 중…" : "대본 없이 설계 중…";
      await writeJob(this.env,job);
      const material = [
        "영상 주소: " + (input.videoUrl || "(없음)"),
        "영상 제목: " + input.topic,
        "대표 분야: " + input.category,
        input.sources.length ? "공식 출처:\n" + input.sources.join("\n") : "공식 출처: 제공되지 않음",
        script ? "대본:\n" + script : "(대본 없음 — 제목과 분야를 바탕으로 실무 배경 지식을 보태되, 없는 수치·법령은 만들지 말 것)"
      ].join("\n\n");
      const outline = await step.do("2-설계", STEP_CONFIG, async () => callJobLLM(this.env,input.m1,jobSystemOutline(),material,5000));
      job.checkpoints = {...job.checkpoints, outline:outline.text};
      job.usedModels = [...new Set([...(job.usedModels || []),outline.model])];
      job.stage = "3";
      job.message = "본문을 단계별로 집필 중…";
      await writeJob(this.env,job);
      const draft = await runDurableLong(this,step,job,"3",input.m2,jobSystemDraft(input),`아래 설계도와 원본 재료로 글을 써 주세요.\n\n[설계도]\n${outline.text}\n\n[원본 재료]\n${material}`,16000,input.targetChars,6,job.checkpoints?.htmlDraftPartial || "");
      job.checkpoints = {...job.checkpoints, htmlDraft:draft};
      job.partial = {};
      job.stage = "4";
      job.message = "최종 원고를 보강 중…";
      await writeJob(this.env,job);
      let finalHtml;
      try {
        finalHtml = await runDurableLong(this,step,job,"4",input.m2,jobSystemFinal(input),`[현재 원고]\n${draft}\n\n[설계도]\n${outline.text}`,16000,input.targetChars,5,job.checkpoints?.htmlFinalPartial || "");
        if (textOnlyLength(finalHtml) < textOnlyLength(draft) * 0.95) finalHtml = draft;
      } catch (error) {
        job.warnings = [...(job.warnings || []), "최종 보강 단계가 끝나지 않아 1차 원고를 사용합니다: " + cleanJobError(error)];
        finalHtml = draft;
      }
      job.checkpoints = {...job.checkpoints, htmlFinal:finalHtml};
      job.partial = {};
      job.stage = "5";
      job.message = "제목·라벨·이미지를 준비 중…";
      await writeJob(this.env,job);
      let packText = "";
      try {
        const packCall = await step.do("5-제목과 라벨", STEP_CONFIG, async () => callJobLLM(this.env,input.m1,jobSystemPack(input),`이미지는 정확히 ${Math.max(input.imgCount,1)}개를 제안해 주세요. 첫 번째는 cover입니다.\n\n[글]\n${finalHtml.slice(0,14000)}`,2500));
        packText = packCall.text;
        job.usedModels = [...new Set([...(job.usedModels || []),packCall.model])];
      } catch (error) {
        job.warnings = [...(job.warnings || []), "제목·라벨 생성에 실패해 기본값을 사용합니다: " + cleanJobError(error)];
      }
      const pack = parsePack(packText,input);
      const images = [];
      for (let index = 0; index < pack.images.length; index += 1) {
        const spec = pack.images[index];
        try {
          const image = await step.do(`5-이미지-${index + 1}`, STEP_CONFIG, async () => generateServerImage(this.env,spec.prompt,input));
          images.push({...image,slot:index,role:spec.role,alt:spec.alt,prompt:spec.prompt});
          job.message = `이미지 ${index + 1}/${pack.images.length} 저장 완료`;
          job.checkpoints = {...job.checkpoints, images};
          await writeJob(this.env,job);
        } catch (error) {
          job.warnings = [...(job.warnings || []), `이미지 ${index + 1}장 실패: ${cleanJobError(error)}`];
          await writeJob(this.env,job);
        }
      }
      job.status = "completed";
      job.stage = "5";
      job.message = "서버 작업 완료 · 검토 후 Blogger로 보내세요.";
      job.result = {html:finalHtml,title:pack.title,desc:pack.description,labels:pack.labels,keywords:pack.keywords,images,videoId:input.videoId,usedModels:job.usedModels || []};
      job.completedAt = nowIso();
      job.partial = {};
      await writeJob(this.env,job);
      return {jobId:job.id,status:job.status};
    } catch (error) {
      const message = cleanJobError(error);
      await patchJob(this.env,jobId,{status:"failed",stage:job?.stage || "?",message:"서버 작업이 멈췄습니다.",error:message,failedAt:nowIso()});
      throw error;
    }
  }
}

async function handleJobRequest(request, env, origin, url) {
  if (!hasAccess(request,env)) return jsonNoStore(origin,401,{error:{message:"서버 작업실 접근 키가 올바르지 않습니다."}});
  if (!env?.BLOG_JOBS || !env?.BLOG_WORKFLOW) return jsonNoStore(origin,503,{error:{message:"서버 작업실 저장소 또는 워크플로가 연결되지 않았습니다."}});
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && segments.length === 1) {
    let raw;
    try { raw = await request.json(); } catch (_) { return jsonNoStore(origin,400,{error:{message:"작업 요청 형식이 올바르지 않습니다."}}); }
    let input;
    try { input = normalizeJobInput(raw); } catch (error) { return jsonNoStore(origin,400,{error:{message:cleanJobError(error)}}); }
    const id = randomId("qaplus");
    const jobKey = randomId("key");
    const job = {id,jobKey,status:"queued",stage:"0",message:"서버 작업실에 등록했습니다.",createdAt:nowIso(),updatedAt:nowIso(),input,checkpoints:{},partial:{},warnings:[],usedModels:[]};
    await writeJob(env,job);
    try { await env.BLOG_WORKFLOW.create({id,params:{jobId:id}}); }
    catch (error) {
      await patchJob(env,id,{status:"failed",message:"서버 작업을 시작하지 못했습니다.",error:cleanJobError(error),failedAt:nowIso()});
      return jsonNoStore(origin,502,{error:{message:"서버 작업을 시작하지 못했습니다: " + cleanJobError(error)}});
    }
    return jsonNoStore(origin,202,{job:jobForClient(job),jobKey});
  }
  if (request.method === "GET" && segments.length === 2) {
    const job = await readJob(env,segments[1]);
    if (!job || !sameSecret(request.headers.get("X-QA-PLUS-JOB-KEY"),job.jobKey)) return jsonNoStore(origin,404,{error:{message:"작업을 찾지 못했습니다."}});
    return jsonNoStore(origin,200,{job:jobForClient(job)});
  }
  if (request.method === "DELETE" && segments.length === 2) {
    const job = await readJob(env,segments[1]);
    if (!job || !sameSecret(request.headers.get("X-QA-PLUS-JOB-KEY"),job.jobKey)) return jsonNoStore(origin,404,{error:{message:"작업을 찾지 못했습니다."}});
    if (["queued","running"].includes(job.status)) {
      const instance = await env.BLOG_WORKFLOW.get(job.id);
      await instance.terminate();
      await patchJob(env,job.id,{status:"cancelled",message:"사용자가 새 작업을 시작하여 기존 작업을 종료했습니다.",cancelledAt:nowIso()});
    }
    return jsonNoStore(origin,200,{ok:true});
  }
  return jsonNoStore(origin,405,{error:{message:"지원하지 않는 작업 요청입니다."}});
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

    if (url.pathname === "/jobs" || url.pathname.startsWith("/jobs/")) {
      return handleJobRequest(request, env, origin, url);
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
