/**
 * QA PLUS Blog Studio — 안정성 특성 테스트 (v24, 경제냠냠 파이프라인 이식판)
 *
 * 이 파일은 "경제냠냠과 같은 파이프라인" 계약을 고정합니다.
 * 리팩터링으로 아래 성질이 사라지면 실패해야 합니다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createDomShim } from "./lib/dom-shim.mjs";
import { extractConst, extractFunction, getAppScript, getHtmlSource } from "./lib/app-script.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appScript = getAppScript();
const html = getHtmlSource();
const swSource = fs.readFileSync(path.join(here, "..", "sw.js"), "utf8");
const resetSource = fs.readFileSync(path.join(here, "..", "reset.html"), "utf8");
const workerSource = fs.readFileSync(path.join(here, "..", "qa-plus-api-worker.js"), "utf8");

new vm.Script(appScript, { filename: "index.html:inline-script" });

function runFunctions(names, prelude = "", contextExtras = {}) {
  const source = names.map((name) => extractFunction(appScript, name)).join("\n");
  const context = { DOMParser: createDomShim(), console, ...contextExtras };
  vm.runInNewContext(`${prelude}\n${source}`, context);
  return context;
}

/* ============================================================
   1. 단일 호출 경로 — 모든 LLM 단계가 chat/completions 스트리밍
   ============================================================ */

assert.match(appScript, /async function callRaw\(\{model, messages, maxTokens/);
assert.match(appScript, /async function callLong\(\{model, system, user/);
assert.match(appScript, /async function callLLM\(\{model, system, user/);
assert.match(appScript, /stream:true/, "칩섭 호출은 SSE 스트리밍이어야 합니다");
assert.match(appScript, /\/cheapsub\/v1\/chat\/completions/);

// Anthropic 네이티브 /v1/messages 경로와 모델별 예비 전환 로직은 제거되었습니다.
assert.doesNotMatch(appScript, /v1\/messages/, "Claude 전용 Anthropic 경로는 쓰지 않습니다");
assert.doesNotMatch(appScript, /anthropic-version/);
assert.doesNotMatch(appScript, /CLAUDE_SONNET_FALLBACK_MODEL/);
assert.doesNotMatch(appScript, /CLAUDE_EMPTY_SAME_MODEL_RETRIES/);
assert.doesNotMatch(appScript, /EXPANSION_MAX_PASSES/);

/* ------------------------------------------------------------
   1-b. 공급자 장애 시 모델 자동 전환
   칩섭은 특정 공급자가 죽으면 그 모델만 503 fixed_merchant_unavailable 로 막고
   "다른 모델을 이용해 주세요" 라고 안내합니다(요금 미청구). 같은 모델 재시도는
   소용이 없으므로 같은 계열의 다음 모델로 넘어가야 합니다.
   ------------------------------------------------------------ */

assert.match(appScript, /const MODEL_FAMILIES = /);
assert.match(appScript, /function modelUnavailable\(e\)/);
assert.match(appScript, /fixed_merchant_unavailable/);
assert.match(appScript, /function noteModel\(preferred, used\)/);
assert.match(appScript, /요금은 청구되지 않습니다/, "요금 미청구 사실을 사용자에게 알려야 합니다");
assert.match(
  extractFunction(appScript, "noteModel"),
  /modelSwap\[preferred\] === used\) return/,
  "같은 전환을 매 호출마다 다시 알리면 결과 화면이 도배됩니다"
);

{
  const ctx = runFunctions(["modelCandidates"], [
    `MODEL_FAMILIES = ${/const MODEL_FAMILIES = \{[\s\S]*?\n    \};/.exec(appScript)[0].replace(/^const MODEL_FAMILIES = /, "").replace(/;$/, "")};`,
    `modelSwap = {};`
  ].join("\n"));

  // 선호 모델이 맨 앞, 같은 계열만 뒤따릅니다.
  const claude = [...ctx.modelCandidates("claude-opus-5")];
  assert.equal(claude[0], "claude-opus-5");
  assert.ok(claude.includes("claude-opus-4-8") && claude.includes("claude-sonnet-5"));
  assert.ok(!claude.some((m) => m.startsWith("gpt-")), "Claude 는 GPT 계열로 넘어가지 않습니다");

  const gpt = [...ctx.modelCandidates("gpt-5.6-sol")];
  assert.equal(gpt[0], "gpt-5.6-sol");
  assert.ok(gpt.includes("gpt-5.6-terra") && gpt.includes("deepseek-v4-pro") && gpt.includes("glm-5.2"));
  assert.ok(!gpt.some((m) => m.startsWith("claude-")));

  // 중복이 없어야 합니다.
  assert.equal(new Set(gpt).size, gpt.length);
}

// callLLM 과 callLong 모두 모델 후보를 순회해야 합니다.
{
  const callLlm = extractFunction(appScript, "callLLM");
  assert.match(callLlm, /modelCandidates\(model\)/);
  assert.match(callLlm, /if \(modelUnavailable\(e\)\) break/, "공급자 차단이면 같은 모델 재시도 없이 다음 모델로");
  assert.match(callLlm, /noteModel\(model, candidate\)/);

  const callLongFn = extractFunction(appScript, "callLong");
  assert.match(callLongFn, /const candidates = modelCandidates\(model\)/);
  assert.match(callLongFn, /modelUnavailable\(e\) && ci < candidates\.length - 1/);
  assert.match(callLongFn, /noteModel\(model, candidates\[ci\]\)/);
}

// 칩섭 공식 모델 목록에 없는 이름을 쓰면 안 됩니다.
{
  const CHEAPSUB_MODELS = new Set([
    "gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-image-2",
    "claude-opus-5","claude-opus-4-8","claude-sonnet-5","claude-fable-5",
    "deepseek-v4-pro","grok-4.5","glm-5.2"
  ]);
  const families = /const MODEL_FAMILIES = \{[\s\S]*?\n    \};/.exec(appScript)[0];
  for (const model of families.match(/"[a-z0-9.\-]+"/gi).map((s) => s.replace(/"/g, ""))) {
    assert.ok(CHEAPSUB_MODELS.has(model), `${model} 은 칩섭이 제공하는 모델이 아닙니다`);
  }
  // 설정 드롭다운의 모델도 마찬가지입니다.
  const selects = /<select id="m[12]">[\s\S]*?<\/select>/g;
  for (const block of html.match(selects) || []) {
    for (const value of block.match(/value="([^"]+)"/g).map((s) => s.slice(7, -1))) {
      assert.ok(CHEAPSUB_MODELS.has(value), `${value} 은 칩섭이 제공하는 모델이 아닙니다`);
    }
  }
}

// 파라미터 이름이 안 맞는 공급자를 위한 3단 재시도 (경제냠냠과 동일)
assert.match(appScript, /max_completion_tokens/);
assert.match(appScript, /res\.status === 400 && \/token\|temperature\|parameter\|unsupported\/i\.test\(lastErr\)/);

// 스트림이 끊겨도 받은 만큼은 버리지 않습니다.
assert.match(appScript, /if \(out\.trim\(\)\) return \{text:out\.trim\(\), finish:"interrupted"\}/);

/* ============================================================
   2. 이어쓰기 · 백그라운드 복구
   ============================================================ */

assert.match(appScript, /const CONT = /);
assert.match(appScript, /const MORE = /);
assert.match(appScript, /function transientLLMError\(e\)/);
assert.match(appScript, /async function waitForApp\(attempt = 0, onWait\)/);
assert.match(appScript, /addEventListener\("visibilitychange"/);
assert.match(appScript, /window\.addEventListener\("online", resolve, \{once:true\}\)/);
assert.match(appScript, /navigator\.wakeLock\.request\("screen"\)/);
assert.match(appScript, /Math\.min\(12000, 1500 \* Math\.pow\(2, attempt\)\)/, "지수형 대기");

const callLongSource = extractFunction(appScript, "callLong");
assert.match(callLongSource, /retries < 6/, "일시 오류는 최대 6회 재시도");
assert.match(callLongSource, /got\.finish === "interrupted"/);
assert.match(callLongSource, /textLen\(full\) >= target \* 0\.92/, "목표 92% 도달 시 종료");

/* ============================================================
   3. 파이프라인 체크포인트 — 완료된 단계는 다시 결제하지 않습니다
   ============================================================ */

assert.match(appScript, /const PIPE_KEY = KEY \+ "\.pipeline"/);
assert.match(appScript, /function savePipe\(p\)/);
assert.match(appScript, /function loadPipe\(\)/);
for (const field of ["scriptText", "outline", "htmlDraft", "htmlDraftPartial", "htmlFinal", "htmlFinalPartial", "images"]) {
  assert.match(appScript, new RegExp(`pipe\\.${field}`), `pipe.${field} 체크포인트가 있어야 합니다`);
}
assert.match(appScript, /Date\.now\(\) - draftSaveAt > 2500/, "집필 중 약 2.5초 간격 부분 저장");
assert.match(appScript, /Date\.now\(\) - finalSaveAt > 2500/, "보강 중 약 2.5초 간격 부분 저장");
assert.match(appScript, /pipe\.fingerprint !== fingerprint/, "입력이 바뀌면 체크포인트를 버립니다");
assert.match(appScript, /localStorage\.removeItem\(PIPE_KEY\)/, "완료 후 체크포인트 정리");

// 제미나이 백그라운드 작업 이어받기
assert.match(appScript, /const GM_JOB_KEY = KEY \+ "\.gemini-job"/);
assert.match(appScript, /v1beta\/interactions/);
assert.match(appScript, /for \(const model of \[\]\)/, "API 키로 Interactions API를 호출하지 않아야 함");
assert.match(appScript, /background:true, store:true/);
assert.match(appScript, /old\.url === url && Date\.now\(\) - \(old\.at \|\| 0\) < 24 \* 60 \* 60 \* 1000/);
assert.match(appScript, /generateContent/, "구형 계정용 예비 경로 유지");

/* ============================================================
   4. 6단계 구성 · 설정 항목 (경제냠냠과 동일)
   ============================================================ */

assert.equal(extractConst(appScript, "STEPS"), "6");
for (let step = 1; step <= 6; step += 1) {
  assert.match(html, new RegExp(`id="st${step}"`), `${step}단계 레일 항목이 있어야 합니다`);
}

const fields = extractConst(appScript, "FIELDS").replace(/[[\]"]/g, "").split(",").map((s) => s.trim());
for (const key of [
  "proxy", "csk", "base", "m1", "m2", "gmKey", "gmModel",
  "imgRoute", "imgStyle", "imgQuality", "oaKey", "imgModel",
  "ghToken", "ghRepo", "ghBranch", "clientId", "blogId", "ytKey", "channelId",
  "len", "imgCount"
]) {
  assert.ok(fields.includes(key), `설정 항목 ${key} 가 FIELDS 에 있어야 합니다`);
  assert.match(html, new RegExp(`id="${key}"`), `설정 항목 ${key} 입력칸이 있어야 합니다`);
}

// 설정은 localStorage + IndexedDB 에 영구 저장되고 입력 즉시 반영됩니다.
assert.match(appScript, /localStorage\.setItem\(KEY, JSON\.stringify\(cfg\)\)/);
assert.match(appScript, /idbSet\(cfg\)/);
assert.match(appScript, /indexedDB\.open\("qaplus-studio", 1\)/);
assert.doesNotMatch(appScript, /sessionStorage/, "설정은 탭을 닫아도 남아야 합니다");

// 경제냠냠 기본값 그대로
assert.equal(extractConst(appScript, "DEFAULT_PROXY").replace(/"/g, ""), "https://qa-plus-api.gohwansok.workers.dev");
assert.match(appScript, /m1: "gpt-5\.6-sol"/);
assert.match(appScript, /m2: "claude-opus-5"/);
assert.match(appScript, /gmModel: "gemini-3\.6-flash"/);
assert.match(appScript, /imgModel: "gpt-image-2"/);
assert.match(appScript, /len: "9000"/);
assert.match(appScript, /imgCount: "3"/);

/* ============================================================
   5. 순수 도우미 동작
   ============================================================ */

{
  const ctx = runFunctions(["joinContinuation"]);
  // 겹치는 꼬리를 최대 600자 범위에서 제거합니다.
  const base = "ABCDEFGHIJ" + "KEEP_ME_UNIQUE_TAIL_12345678901234";
  const next = "KEEP_ME_UNIQUE_TAIL_12345678901234" + "NEW_ONLY";
  assert.equal(ctx.joinContinuation(base, next), "ABCDEFGHIJKEEP_ME_UNIQUE_TAIL_12345678901234NEW_ONLY");
  assert.equal(ctx.joinContinuation("", "b"), "b");
  assert.equal(ctx.joinContinuation("a", ""), "a");
  // 30자 미만 우연한 겹침은 이어붙이지 않습니다.
  assert.equal(ctx.joinContinuation("hello", "hello world"), "hellohello world");
}

{
  const ctx = runFunctions(["getVideoId", "slugify", "normalizeSources", "validHttpUrl", "ghParse"], "", { URL });
  assert.equal(ctx.getVideoId("https://youtu.be/abcdefghijk"), "abcdefghijk");
  assert.equal(ctx.getVideoId("https://www.youtube.com/watch?v=abcdefghijk"), "abcdefghijk");
  assert.equal(ctx.getVideoId("https://www.youtube.com/shorts/abcdefghijk"), "abcdefghijk");
  assert.equal(ctx.getVideoId(""), "");
  assert.equal(ctx.slugify("CCP 한계기준 이탈"), "ccp-한계기준-이탈");
  // vm 컨텍스트가 다르므로 배열은 현재 렐름으로 옮겨 비교합니다.
  const plain = (value) => [...value];
  assert.deepEqual(
    plain(ctx.normalizeSources("https://www.mfds.go.kr/a\n메모\n https://haccp.or.kr/b ")),
    ["https://www.mfds.go.kr/a", "https://haccp.or.kr/b"]
  );
  // 저장소 칸에 주소를 통째로 넣어도 owner/repo 로 정리됩니다.
  assert.deepEqual(plain(ctx.ghParse("gohwansok-max/qaplus-blog-studio")), ["gohwansok-max", "qaplus-blog-studio"]);
  assert.deepEqual(plain(ctx.ghParse("https://github.com/gohwansok-max/qaplus-blog-studio.git")), ["gohwansok-max", "qaplus-blog-studio"]);
  assert.deepEqual(plain(ctx.ghParse("https://gohwansok-max.github.io/qaplus-blog-studio")), ["gohwansok-max", "qaplus-blog-studio"]);
}

{
  const ctx = runFunctions(["normalizeImageServiceError", "createImageServiceError", "isRetryableImageError", "isRetryableHttpStatus"]);
  const cases = [
    { message: "上游服务网络链路异常，请稍后重试", status: 502, expect: /일시적으로/ },
    { message: "Rate limit exceeded", status: 429, expect: /한도|잔액/ },
    { message: "Unauthorized invalid key", status: 401, expect: /인증/ },
    { message: "Forbidden", status: 403, expect: /인증/ },
    { message: "internal server error", status: 500, expect: /일시적으로/ },
    { message: "Failed to fetch", status: 0, expect: /연결하지 못/ },
    { message: "unsupported_country_region_territory", status: 403, expect: /인증|지역/ }
  ];
  for (const item of cases) {
    const normalized = ctx.normalizeImageServiceError(item.message, item.status);
    assert.match(normalized, item.expect, item.message);
    assert.doesNotMatch(normalized, /Bearer|sk-[A-Za-z0-9]/, "오류 문구에 키가 새면 안 됩니다");
    const error = ctx.createImageServiceError(item.message, item.status);
    assert.equal(error.status, item.status || 0);
  }
  assert.equal(ctx.isRetryableImageError({ status: 502, message: "x" }), true);
  assert.equal(ctx.isRetryableImageError({ status: 401, message: "인증 실패" }), false);
}

{
  // clean / stripFigs / textLen 은 화살표 상수라 const 형태로 가져옵니다.
  const prelude = [
    // vm 컨텍스트에서 const 는 전역 객체에 붙지 않으므로 대입문으로 넣습니다.
    `esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));`,
    `TBL_WRAP = "${/const TBL_WRAP = "([^"]*)";/.exec(appScript)[1]}";`,
    `clean = ${extractConst(appScript, "clean")};`,
    `stripFigs = ${extractConst(appScript, "stripFigs")};`,
    `textLen = ${extractConst(appScript, "textLen")};`
  ].join("\n");
  const ctx = runFunctions(["sanitizePostHtml", "styleForBlogger", "insertImages"], prelude);

  // 코드펜스와 문서 골격 태그를 걷어냅니다.
  assert.equal(ctx.clean("```html\n<p>본문</p>\n```"), "<p>본문</p>");

  // 그림 설명은 본문 글자 수에 포함하지 않습니다.
  const withFigure = "<p>가나다라마바사</p><figure><img src=\"x\"><figcaption>설명설명설명</figcaption></figure>";
  assert.equal(ctx.textLen(withFigure), 7);

  // 위험한 태그·속성 제거
  const dirty = '<h2>제목</h2><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">링크</a>';
  const safe = ctx.sanitizePostHtml(dirty);
  assert.doesNotMatch(safe, /<script/i);
  assert.doesNotMatch(safe, /onerror/i);
  assert.doesNotMatch(safe, /javascript:/i);
  assert.match(safe, /제목/);

  // Blogger 테마용 인라인 스타일 주입 — 표는 가로 스크롤 래퍼로 감쌉니다.
  const styled = ctx.styleForBlogger("<h2>제목</h2><table><thead><tr><th>항목</th></tr></thead><tbody><tr><td>값</td></tr></tbody></table>");
  assert.match(styled, /overflow-x:auto/);
  assert.match(styled, /border-collapse:collapse/);
  assert.match(styled, /border:1px solid #cfe0e2/);
  assert.match(styled, /overflow-wrap:break-word/);
  // 두 번 돌려도 래퍼가 중첩되지 않습니다.
  assert.equal(
    (ctx.styleForBlogger(styled).match(/overflow-x:auto/g) || []).length,
    (styled.match(/overflow-x:auto/g) || []).length
  );

  // 대표 이미지는 첫 h2 뒤, 본문 이미지는 h2 사이에 분산됩니다.
  const body = "<h2>가</h2><p>1</p><h2>나</h2><p>2</p><h2>다</h2><p>3</p>";
  const withImages = ctx.insertImages(body, [
    { src: "https://e/1.jpg", alt: "대표", role: "cover" },
    { src: "https://e/2.jpg", alt: "본문", role: "body" }
  ]);
  assert.equal((withImages.match(/<figure/g) || []).length, 2);
  assert.ok(withImages.indexOf("https://e/1.jpg") < withImages.indexOf("https://e/2.jpg"));
  assert.ok(withImages.indexOf("https://e/1.jpg") > withImages.indexOf("<h2>가</h2>"));
  assert.equal(ctx.insertImages(body, []), body);
}

/* ============================================================
   5-b. 필수 블록 보장
   실제 운영에서 보강 단계가 글 전체를 다시 쓰면서 무료자료 CTA·면책 문구를
   빠뜨리고 문장 중간에서 잘린 채 끝나, 발행 전 검사에 막혀 Blogger 로
   보낼 수 없는 일이 있었습니다. 모델 지시에만 의존하면 안 됩니다.
   ============================================================ */

assert.match(appScript, /function ensureRequiredBlocks\(html, input\)/);
assert.match(appScript, /function hasRequiredBlocks\(html\)/);
// 보강본이 필수 항목을 잃으면 길이가 늘었어도 채택하지 않습니다.
assert.match(appScript, /const keptBlocks = hasRequiredBlocks\(html2\) \|\| !hasRequiredBlocks\(html\)/);
assert.match(appScript, /longEnough && keptBlocks/);
assert.match(appScript, /보강본이 필수 항목 누락 · 원본 유지/);
// 발행 직전에 한 번 더 확실히 채웁니다.
assert.match(appScript, /html = sanitizePostHtml\(ensureRequiredBlocks\(html, input\)\)/);
// 이미 만든 글도 수동으로 고칠 수 있어야 합니다.
assert.match(html, /id="fixBlocks"/);

{
  const driveUrl = /const DRIVE_URL = "([^"]*)";/.exec(appScript)[1];
  const prelude = [
    `esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));`,
    `DRIVE_URL = ${JSON.stringify(driveUrl)};`,
    `DISCLAIMER_RE = ${/const DISCLAIMER_RE = ([^;]+);/.exec(appScript)[1]};`
  ].join("\n");
  const ctx = runFunctions(["ensureRequiredBlocks", "hasRequiredBlocks"], prelude);
  const input = { videoId: "t1c2XbNe3kM", topic: "HACCP 12절차" };

  // 실제로 나왔던 증상: CTA·면책 없음 + "<p>선행요건</p>" 로 잘려 끝남
  const broken = "<h2>제목</h2><p>본문입니다. 현장에서 확인해야 합니다.</p><p>선행요건</p>";
  assert.equal(ctx.hasRequiredBlocks(broken), false);

  const fixed = ctx.ensureRequiredBlocks(broken, input);
  assert.ok(fixed.includes("youtube-nocookie.com/embed/t1c2XbNe3kM"), "영상 임베드를 채워야 합니다");
  assert.ok(fixed.includes("drive.google.com"), "무료자료 CTA 를 채워야 합니다");
  assert.match(fixed, /일반 실무 참고용/, "면책 문구를 채워야 합니다");
  assert.doesNotMatch(fixed, /<p>선행요건<\/p>/, "잘린 꼬리를 버려야 합니다");
  assert.equal(ctx.hasRequiredBlocks(fixed), true);

  // 이미 온전한 글은 건드리지 않습니다(중복 삽입 금지).
  const again = ctx.ensureRequiredBlocks(fixed, input);
  assert.equal((again.match(/youtube-nocookie/g) || []).length, 1);
  assert.equal((again.match(/일반 실무 참고용/g) || []).length, 1);

  // 온전한 문장으로 끝나면 지우지 않습니다.
  const complete = '<h2>제목</h2><p>현장에서 반드시 확인해야 하는 항목입니다.</p>'
    + '<p><a href="' + driveUrl + '">자료</a></p><p>이 글은 일반 실무 참고용입니다.</p>';
  assert.match(ctx.ensureRequiredBlocks(complete, { videoId: "", topic: "x" }), /현장에서 반드시 확인해야 하는 항목입니다/);

  // 영상이 없으면 임베드를 넣지 않습니다.
  assert.doesNotMatch(ctx.ensureRequiredBlocks("<h2>제목</h2><p>본문입니다.</p>", { videoId: "", topic: "x" }), /youtube-nocookie/);

  // 이미 발행용 스타일이 입혀진 글(=<div> 래퍼 안)도 꼬리 정리가 되어야 합니다.
  // '누락 항목 채우기' 버튼은 대부분 이 상태의 글에 쓰입니다.
  const wrapped = '<div style="max-width:100%;overflow-wrap:break-word">'
    + "<h2>제목</h2><p>현장에서 확인해야 하는 항목입니다.</p><p>선행요건</p></div>";
  const wrappedFixed = ctx.ensureRequiredBlocks(wrapped, input);
  assert.doesNotMatch(wrappedFixed, /<p>선행요건<\/p>/, "래퍼 안의 잘린 꼬리도 버려야 합니다");
  assert.ok(wrappedFixed.includes("drive.google.com"));
  assert.match(wrappedFixed, /일반 실무 참고용/);
  // 덧붙인 내용이 래퍼 밖으로 새지 않아야 합니다.
  assert.ok(
    wrappedFixed.trim().endsWith("</div>"),
    "CTA·면책 문구는 본문 래퍼 안에 들어가야 합니다"
  );
}

/* ============================================================
   6. 이미지 경로 순서 · 영구 주소
   ============================================================ */

const genImageSource = extractFunction(appScript, "genImage");
assert.ok(
  genImageSource.indexOf("QA PLUS 중계") < genImageSource.indexOf("OpenAI 직접"),
  "자동 경로는 QA PLUS 중계를 먼저 시도해야 합니다"
);
assert.ok(
  genImageSource.indexOf("OpenAI 직접") < genImageSource.indexOf("OpenAI 프록시"),
  "지역 차단을 피하려면 직접 호출이 프록시보다 먼저여야 합니다"
);
assert.match(genImageSource, /errs\.push\(name \+ ": " \+ e\.message\)/, "경로별 실패 사유를 모아 보여 줍니다");

// 중계가 돌려준 영구 주소를 그대로 쓰고, b64 만 받은 경우에만 GitHub 로 올립니다.
assert.match(appScript, /item\.persistent_url \|\| item\.proxy_url \|\| item\.url/);
assert.match(appScript, /async function ghUpload\(path, b64\)/);
assert.match(appScript, /blog-images\//);
assert.match(appScript, /async function makeHostedImage\(spec, index, onRetry\)/);
assert.match(appScript, /attempt <= 3/, "이미지는 장당 최대 3회 확인");
// 성공한 이미지는 보존하고 실패한 슬롯만 이어서 만듭니다.
assert.match(appScript, /if \(doneSlots\.has\(i\)\) continue/);
assert.match(appScript, /pipe\.images = article\.images\.map/);

/* ============================================================
   7. 발행 · 버전 · 서비스워커
   ============================================================ */

assert.match(appScript, /function createBloggerPostPayload\(title, content, labels\)/);
assert.match(appScript, /posts\?isDraft=" \+ isDraft/);
assert.match(appScript, /if \(!response\.ok \|\| !data\.id\)/);
assert.match(appScript, /findExistingBloggerPost/, "같은 영상 중복 발행 방지");
assert.match(appScript, /scope:"https:\/\/www\.googleapis\.com\/auth\/blogger"/);
assert.doesNotMatch(appScript, /youtube\.force-ssl/);

assert.match(html, /<meta name="qa-plus-app-version" content="26">/);
assert.match(html, /id="appVersion"[^>]*>APP v26<\/span>/);
assert.equal(extractConst(appScript, "APP_VERSION").replace(/"/g, ""), "26");
assert.match(appScript, /serviceWorker\.register\("\.\/sw\.js\?v=" \+ APP_VERSION, \{scope:"\.\/", updateViaCache:"none"\}\)/);
assert.match(appScript, /new URL\("\.\/reset\.html", window\.location\.href\)/);
assert.match(swSource, /const CACHE_NAME = "qaplus-blog-studio-v26"/);
assert.doesNotMatch(swSource, /qaplus-blog-studio-v25/);
assert.match(resetSource, /const FALLBACK_VERSION = "26"/);
assert.match(resetSource, /key\.startsWith\("qaplus-blog-studio-"\)/);

// CSP 는 파이프라인이 실제로 부르는 호스트를 모두 허용해야 합니다.
const csp = /content="(default-src[^"]+)"/.exec(html)[1];
for (const host of [
  "https://*.workers.dev",
  "https://api.cheapai.im",
  "https://api.openai.com",
  "https://api.github.com",
  "https://generativelanguage.googleapis.com",
  "https://www.googleapis.com"
]) {
  assert.ok(csp.includes(host), `CSP connect-src 에 ${host} 가 있어야 합니다`);
}

/* ============================================================
   8. 워커 — 이중 경로 라우팅 + KV 영구 보관
   ============================================================ */

assert.match(workerSource, /function routeRequest\(pathname\)/);
assert.match(workerSource, /cheapsub: "https:\/\/api\.cheapai\.im"/);
assert.match(workerSource, /openai: "https:\/\/api\.openai\.com"/);
assert.match(workerSource, /route\.path === "\/v1\/images\/generations" && upstream\.ok/);
assert.match(workerSource, /function sniffImageType\(bytes\)/, "저장 형식을 매직 넘버로 판별해야 합니다");

{
  const routeSource = /function routeRequest[\s\S]*?\n}/.exec(workerSource)[0];
  const routeRequest = new Function("UPSTREAM_TARGETS", `${routeSource}; return routeRequest;`)({ cheapsub: 1, openai: 1 });
  assert.deepEqual(routeRequest("/cheapsub/v1/chat/completions"), { service: "cheapsub", path: "/v1/chat/completions" });
  assert.deepEqual(routeRequest("/openai/v1/images/generations"), { service: "openai", path: "/v1/images/generations" });
  // 구버전 앱이 쓰던 경로도 계속 동작해야 합니다.
  assert.deepEqual(routeRequest("/v1/chat/completions"), { service: "cheapsub", path: "/v1/chat/completions" });
}

console.log("stability-characterization tests: PASS");
