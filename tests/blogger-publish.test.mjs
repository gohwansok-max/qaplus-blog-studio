/**
 * Blogger 발행 계약 테스트 — 페이로드 · 오류 문구 · 블로그 ID 조회 · 중복 방지
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, getAppScript } from "./lib/app-script.mjs";

const appScript = getAppScript();
new vm.Script(appScript, { filename: "index.html:inline-script" });

const payloadFn = extractFunction(appScript, "createBloggerPostPayload");
const errorFn = extractFunction(appScript, "createBloggerApiError");
const resolveBlogIdFn = extractFunction(appScript, "resolveBlogId");
const findExistingFn = extractFunction(appScript, "findExistingBloggerPost");

/* ---------- 발행 페이로드 ---------- */

const payloadContext = {};
vm.runInNewContext(`${payloadFn}; result = createBloggerPostPayload(
  "  테스트 제목  ",
  "<p>본문</p>",
  ["HACCP", "", "식품안전"]
);`, payloadContext);
const payload = JSON.parse(JSON.stringify(payloadContext.result));

assert.deepEqual(payload, {
  title: "테스트 제목",
  content: "<p>본문</p>",
  labels: ["HACCP", "식품안전"]
});
// Blogger API 가 요구하는 세 키만 보냅니다. kind/blog/id 를 붙이면 400 이 납니다.
assert.deepEqual(Object.keys(payload).sort(), ["content", "labels", "title"]);
assert.doesNotMatch(payloadFn, /\bkind\b|\bblog\b|\bid\b/);

// 라벨은 최대 10개
const manyLabelsContext = {};
vm.runInNewContext(
  `${payloadFn}; result = createBloggerPostPayload("제목","<p>x</p>",Array.from({length:14},(_,i)=>"L"+i));`,
  manyLabelsContext
);
assert.equal(manyLabelsContext.result.labels.length, 10);

/* ---------- 오류 문구 ---------- */

const errorContext = {};
vm.runInNewContext(`${errorFn};
  r401 = createBloggerApiError({status:401},{error:{message:"expired"}},"Blogger 글 발행");
  r403 = createBloggerApiError({status:403},{error:{message:"The caller does not have permission"}},"Blogger 글 발행");
  r500 = createBloggerApiError({status:500},{error:{message:"backend error"}},"Blogger 글 발행");
`, errorContext);
assert.match(errorContext.r401.message, /다시 연결|토큰/);
assert.equal(errorContext.r401.status, 401);
assert.match(errorContext.r403.message, /Blogger 발행 권한|권한을 모두 허용/);
assert.equal(errorContext.r403.status, 403);
assert.match(errorContext.r500.message, /backend error/);

/* ---------- 블로그 ID 자동 조회 ---------- */

{
  const calls = [];
  const context = {
    BLOG_URL: "https://qaplus-haccp.blogspot.com/",
    gToken: "test-token",
    cfg: { blogId: "" },
    save: () => {},
    $: () => ({ value: "" }),
    URL,
    fetch: async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "5694600166844060136" }) };
    }
  };
  await vm.runInNewContext(`(async () => {
    ${errorFn}
    ${resolveBlogIdFn}
    result = await resolveBlogId();
  })()`, context);
  assert.equal(context.result, "5694600166844060136");
  assert.match(calls[0], /blogs\/byurl\?url=/);

  // 이미 저장된 ID 가 있으면 네트워크를 타지 않습니다.
  const cached = { cfg: { blogId: "999" }, fetch: () => { throw new Error("불필요한 호출"); }, save: () => {}, $: () => ({}), BLOG_URL: "x", gToken: "t", URL };
  await vm.runInNewContext(`(async () => {
    ${errorFn}
    ${resolveBlogIdFn}
    result = await resolveBlogId();
  })()`, cached);
  assert.equal(cached.result, "999");
}

/* ---------- 중복 발행 방지 ---------- */

{
  // 히스토리에 있으면 즉시 반환합니다.
  const fromHistory = {
    gToken: "t", URL,
    fetch: () => { throw new Error("불필요한 호출"); }
  };
  await vm.runInNewContext(`(async () => {
    ${errorFn}
    ${findExistingFn}
    result = await findExistingBloggerPost("blog1","vid1","제목",{id:"post-9",url:"https://x/9"});
  })()`, fromHistory);
  assert.equal(fromHistory.result.id, "post-9");

  // 본문에 영상 ID 가 들어 있는 글을 찾아냅니다.
  const byVideo = {
    gToken: "t", URL,
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [
        { id: "other", title: "관계없는 글", content: "<p>없음</p>" },
        { id: "match", title: "다른 제목", content: "<iframe src=\"https://www.youtube-nocookie.com/embed/vid1\"></iframe>" }
      ] })
    })
  };
  await vm.runInNewContext(`(async () => {
    ${errorFn}
    ${findExistingFn}
    result = await findExistingBloggerPost("blog1","vid1","새 제목",null);
  })()`, byVideo);
  assert.equal(byVideo.result.id, "match");

  // 영상 ID 가 없으면 제목이 정확히 같은 글로 판단합니다.
  const byTitle = {
    gToken: "t", URL,
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ items: [{ id: "titled", title: "  CCP 이탈 조치 ", content: "<p>x</p>" }] })
    })
  };
  await vm.runInNewContext(`(async () => {
    ${errorFn}
    ${findExistingFn}
    result = await findExistingBloggerPost("blog1","","CCP 이탈 조치",null);
  })()`, byTitle);
  assert.equal(byTitle.result.id, "titled");

  // 일치하는 글이 없으면 null — 새 글로 발행합니다.
  const none = {
    gToken: "t", URL,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })
  };
  await vm.runInNewContext(`(async () => {
    ${errorFn}
    ${findExistingFn}
    result = await findExistingBloggerPost("blog1","vid2","없는 제목",null);
  })()`, none);
  assert.equal(none.result, null);
}

/* ---------- 발행 흐름 계약 ---------- */

// 기본값은 임시저장, 기존 글이 있으면 사용자 확인 후 PUT 으로 업데이트합니다.
assert.match(appScript, /value="draft" checked|name="publishMode"/);
assert.match(appScript, /const isDraft = mode === "draft"/);
assert.match(appScript, /window\.confirm\(/);
assert.match(appScript, /method:updating \? "PUT" : "POST"/);
assert.match(appScript, /posts\?isDraft=" \+ isDraft/);
assert.match(appScript, /if \(!response\.ok \|\| !data\.id\)/);
// 발행 전 검사를 통과하지 못하면 요청을 보내지 않습니다.
assert.match(appScript, /try \{ validatePost\(false\); \} catch \(e\) \{ showNotice\(e\.message, "error"\); return; \}/);
// 401/403 이면 토큰을 버리고 재연결을 요구합니다.
assert.match(appScript, /if \(e\?\.status === 401 \|\| e\?\.status === 403\) \{\s*gToken = "";/);
// 발행 성공 시 영상 ID 기준으로 이력을 남깁니다.
assert.match(appScript, /history\[videoId\] = \{id:data\.id/);
assert.match(appScript, /localStorage\.setItem\(HISTORY_KEY, JSON\.stringify\(history\)\)/);
// Blogger 권한만 요청합니다.
assert.match(appScript, /scope:"https:\/\/www\.googleapis\.com\/auth\/blogger https:\/\/www\.googleapis\.com\/auth\/youtube\.readonly"/);

console.log("blogger-publish tests: PASS");
