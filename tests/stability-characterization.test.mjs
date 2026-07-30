import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createDomShim } from "./lib/dom-shim.mjs";
import { extractConst, extractFunction, getAppScript, getHtmlSource } from "./lib/app-script.mjs";

const appScript = getAppScript();
const html = getHtmlSource();
const swSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sw.js"), "utf8");
const resetSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "reset.html"), "utf8");

new vm.Script(appScript, { filename: "index.html:inline-script" });

function runFunctions(names, prelude = "", contextExtras = {}) {
  const source = names.map((name) => extractFunction(appScript, name)).join("\n");
  const context = {
    DOMParser: createDomShim(),
    console,
    ...contextExtras
  };
  vm.runInNewContext(`${prelude}\n${source}`, context);
  return context;
}

// --- Source contracts: model fallback & expansion policy ---

assert.match(appScript, /const DEFAULT_CHAT_MODEL = "gpt-5\.6-sol"/);
assert.match(appScript, /const CLAUDE_OPUS_MODEL = "claude-opus-5"/);
assert.match(appScript, /const CLAUDE_SONNET_FALLBACK_MODEL = "claude-sonnet-5"/);
assert.match(appScript, /const CLAUDE_ARTICLE_MAX_CONTINUATIONS = 2/);
assert.match(appScript, /const CLAUDE_EMPTY_SAME_MODEL_RETRIES = 2/);
assert.match(appScript, /const EXPANSION_MAX_PASSES = 3/);
assert.match(appScript, /const EXPANSION_RECOVERY_PASSES = 1/);
assert.match(appScript, /const TARGET_LENGTH_RATIO = 0\.9/);
assert.match(appScript, /const DEFAULT_TARGET_CHARS = 6000/);
assert.match(appScript, /QUALITY_DENSITY_RULE/);
assert.match(appScript, /activeModel = CLAUDE_SONNET_FALLBACK_MODEL/);
assert.match(appScript, /settings\.claudeModel \|\| CLAUDE_OPUS_MODEL/);
assert.match(appScript, /emptyResponses < CLAUDE_EMPTY_SAME_MODEL_RETRIES/);
assert.match(appScript, /Claude Opus 빈 응답 반복 · Sonnet 예비 모델로 자동 전환/);
assert.match(appScript, /callOpenAiChatDetailed/);
assert.match(appScript, /4단계에서 Claude Opus·Sonnet 빈 응답이 반복되어 ChatGPT가 확장 조각을 대신 작성했습니다/);
assert.match(appScript, /maxContinuations = CLAUDE_ARTICLE_MAX_CONTINUATIONS/);
assert.match(appScript, /pass<=EXPANSION_MAX_PASSES/);
assert.match(appScript, /EXPANSION_RECOVERY_PASSES/);
assert.match(appScript, /isPipelineRunActive\(runId\)/);
assert.match(appScript, /input\.targetChars \* TARGET_LENGTH_RATIO/);
assert.match(appScript, /requiredTables = input\.targetChars >= 9000 \? 2 : 1/);
assert.match(appScript, /insertAdjacentHTML\("beforebegin",additionHtml\)/);
assert.match(appScript, /DISCLAIMER_TEXT_RE/);
assert.match(html, /option value="6000" selected/);
assert.match(html, /<meta name="qa-plus-app-version" content="20">/);
assert.match(html, /id="appVersion"[^>]*>APP v20<\/span>/);
assert.match(appScript, /const APP_VERSION = "20"/);
assert.match(appScript, /new URL\("\.\/reset\.html",window\.location\.href\)/);
assert.match(appScript, /serviceWorker\.register\(`\.\/sw\.js\?v=\$\{APP_VERSION\}`,\{scope:"\.\/",updateViaCache:"none"\}\)/);
assert.match(swSource, /const CACHE_NAME = "qaplus-blog-studio-v20"/);
assert.doesNotMatch(swSource, /qaplus-blog-studio-v19/);
assert.match(swSource, /new Request\(new URL\(path, self\.location\.href\), \{ cache: "reload" \}\)/);
assert.match(swSource, /new Request\(request, \{ cache: "no-store" \}\)/);
assert.match(resetSource, /const FALLBACK_VERSION = "20"/);
assert.match(resetSource, /registration\.unregister\(\)/);
assert.match(resetSource, /key\.startsWith\("qaplus-blog-studio-"\)/);
assert.match(appScript, /image\.persistent_url \|\| image\.proxy_url/);
assert.match(appScript, /durableUrl\.pathname\.startsWith\("\/blog-images\/"\)/);
assert.doesNotMatch(
  extractFunction(appScript,"requestBrollImage"),
  /return "data:image\/jpeg;base64/
);

const emptyFallbackBlock = appScript.slice(
  appScript.indexOf("if (!result.content)"),
  appScript.indexOf("if (result.stopReason === \"max_tokens\")")
);
assert.match(emptyFallbackBlock, /emptyResponses < CLAUDE_EMPTY_SAME_MODEL_RETRIES/);
assert.match(emptyFallbackBlock, /claude-opus/i);
assert.match(emptyFallbackBlock, /CLAUDE_SONNET_FALLBACK_MODEL/);
assert.ok(
  emptyFallbackBlock.indexOf("CLAUDE_EMPTY_SAME_MODEL_RETRIES") < emptyFallbackBlock.indexOf("CLAUDE_SONNET_FALLBACK_MODEL"),
  "Opus same-model retry must happen before Sonnet switch"
);

const expansionFallback = extractFunction(appScript, "callExpansionChunk");
assert.match(expansionFallback, /빈 응답|응답 본문이 비어|Opus·Sonnet/);
assert.match(expansionFallback, /callOpenAiChatDetailed/);
assert.match(expansionFallback, /gpt-5\.6-sol|fallbackResult/);
assert.ok(
  expansionFallback.indexOf("callClaude") < expansionFallback.indexOf("callOpenAiChatDetailed"),
  "ChatGPT safety net must run only after Claude empty-response failure"
);

// --- Claude article continuation pure helpers ---

{
  const ctx = runFunctions([
    "normalizeClaudeArticleEnvelope",
    "isClaudeArticleComplete",
    "mergeClaudeContinuation"
  ]);

  const incomplete = `<QAPLUS_RESULT>
<QAPLUS_TITLE>제목</QAPLUS_TITLE>
<QAPLUS_DESCRIPTION>설명</QAPLUS_DESCRIPTION>
<QAPLUS_HTML><p>첫 문단입니다.</p>`;
  assert.equal(ctx.isClaudeArticleComplete(incomplete), false);

  const continued = ctx.mergeClaudeContinuation(
    incomplete,
    `<p>이어진 문단입니다.</p></QAPLUS_HTML>
</QAPLUS_RESULT>`
  );
  assert.equal(ctx.isClaudeArticleComplete(continued), true);
  assert.match(continued, /첫 문단입니다/);
  assert.match(continued, /이어진 문단입니다/);
  assert.equal((continued.match(/첫 문단입니다/g) || []).length, 1);

  const overlapBase = "ABCDEFGHIJ" + "KEEP_ME_UNIQUE_TAIL_12345";
  const overlapNext = "KEEP_ME_UNIQUE_TAIL_12345" + "NEW_ONLY";
  assert.equal(
    ctx.mergeClaudeContinuation(overlapBase, overlapNext),
    "ABCDEFGHIJKEEP_ME_UNIQUE_TAIL_12345NEW_ONLY"
  );

  const htmlOnlyClose = `<QAPLUS_RESULT>
<QAPLUS_TITLE>A</QAPLUS_TITLE>
<QAPLUS_DESCRIPTION>B</QAPLUS_DESCRIPTION>
<QAPLUS_HTML><p>ok</p></QAPLUS_HTML>`;
  assert.equal(ctx.isClaudeArticleComplete(ctx.normalizeClaudeArticleEnvelope(htmlOnlyClose)), true);
}

// --- Stage 4 append merge + sanitizer ---

{
  const escapeHtmlFn = `function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[char]);
  }
  const DISCLAIMER_TEXT_RE = /일반 실무|최신 기준|면책/;`;
  const ctx = runFunctions(
    ["visibleTextLength", "sanitizePostHtml", "appendExpansionHtml", "parseClaudeAppendHtml"],
    escapeHtmlFn
  );

  const draftHtml = [
    "<article>",
    "<p>" + "기본본문".repeat(1600) + "</p>",
    "<table><tr><td>기존표1</td></tr></table>",
    "<p>본 글은 일반 실무 참고용이며 최신 기준을 확인해 주세요. 면책 문구입니다.</p>",
    "</article>"
  ].join("");

  const dirtyChunk = [
    "<QAPLUS_APPEND>",
    "<h2>확장 제목</h2>",
    "<p>" + "확장본문".repeat(1200) + "</p>",
    "<table><tr><td>추가표2</td></tr></table>",
    "<script>alert(1)</script>",
    "<img src=x onerror=\"alert(2)\">",
    "</QAPLUS_APPEND>"
  ].join("");

  const addition = ctx.parseClaudeAppendHtml(dirtyChunk);
  assert.doesNotMatch(addition, /<script/i);
  assert.doesNotMatch(addition, /onerror/i);
  assert.match(addition, /확장 제목/);
  assert.match(addition, /<table/i);

  const merged = ctx.appendExpansionHtml(draftHtml, addition);
  const disclaimerIndex = merged.indexOf("면책 문구");
  const expansionIndex = merged.indexOf("확장 제목");
  assert.ok(expansionIndex >= 0 && disclaimerIndex >= 0, "merge should keep expansion and disclaimer");
  assert.ok(expansionIndex < disclaimerIndex, "expansion must insert before disclaimer");
  assert.match(merged, /기존표1/);
  assert.match(merged, /추가표2/);
  assert.equal((merged.match(/기본본문/g) || []).length, 1600);
  assert.doesNotMatch(merged, /<script/i);
  assert.doesNotMatch(merged, /onerror/i);

  const length = ctx.visibleTextLength(merged);
  assert.ok(length >= 10800, `12,000자 목표 90% 이상이어야 함. actual=${length}`);
  assert.equal((merged.match(/<table[\s>]/gi) || []).length, 2);
}

// --- Image error Korean normalization ---

{
  const ctx = runFunctions(["normalizeImageServiceError", "createImageServiceError"]);
  const cases = [
    { message: "上游服务网络链路异常，请稍后重试", status: 502, expect: /상위 서비스|일시적으로/ },
    { message: "Rate limit exceeded", status: 429, expect: /한도|잔액/ },
    { message: "Unauthorized invalid key", status: 401, expect: /인증/ },
    { message: "Forbidden", status: 403, expect: /인증/ },
    { message: "internal server error", status: 500, expect: /상위 서비스|일시적으로/ },
    { message: "Failed to fetch", status: 0, expect: /연결하지 못/ }
  ];
  for (const item of cases) {
    const normalized = ctx.normalizeImageServiceError(item.message, item.status);
    assert.match(normalized, item.expect, item.message);
    assert.doesNotMatch(normalized, /Authorization|api[_-]?key|sk-/i);
    const error = ctx.createImageServiceError(item.message, item.status);
    assert.equal(error.status, item.status || 0);
    assert.match(error.message, item.expect);
  }
}

// --- Blogger payload / auth contracts (extend existing coverage) ---

{
  const payloadFn = extractFunction(appScript, "createBloggerPostPayload");
  const errorFn = extractFunction(appScript, "createBloggerApiError");
  const payloadContext = {};
  vm.runInNewContext(`${payloadFn}; result = createBloggerPostPayload("제목","<p>본문</p>",["A","","B"]);`, payloadContext);
  assert.deepEqual(Object.keys(payloadContext.result).sort(), ["content", "labels", "title"]);
  assert.doesNotMatch(payloadFn, /\bkind\b|\bblog\b|\bid\b/);

  const errorContext = {};
  vm.runInNewContext(`${errorFn}; r401 = createBloggerApiError({status:401},{error:{message:"expired"}},"발행"); r403 = createBloggerApiError({status:403},{error:{message:"denied"}},"발행");`, errorContext);
  assert.match(errorContext.r401.message, /다시 연결|토큰/);
  assert.match(errorContext.r403.message, /Blogger 발행 권한|권한을 모두 허용/);

  assert.match(appScript, /state\.bloggerWritable/);
  assert.match(appScript, /els\.publishBlogger\.disabled = !\(state\.post && state\.googleToken && state\.blogId && state\.bloggerWritable && !state\.busy\)/);
  assert.match(appScript, /posts\?isDraft=\$\{isDraft\}/);
  assert.match(appScript, /if \(!response\.ok \|\| !data\.id\)/);
}

// --- Busy / double-click guards remain present ---

assert.match(appScript, /function setBusy\(busy/);
assert.match(appScript, /state\.busy = busy/);
assert.match(appScript, /els\.publishBlogger\.disabled = true/);
assert.match(appScript, /setBusy\(false\)/);
assert.match(appScript, /finally\s*\{/);

// --- Constants that refactor may introduce must keep values ---

assert.equal(extractConst(appScript, "DEFAULT_CHAT_MODEL").replace(/"/g, ""), "gpt-5.6-sol");
assert.equal(extractConst(appScript, "CLAUDE_OPUS_MODEL").replace(/"/g, ""), "claude-opus-5");
assert.equal(extractConst(appScript, "CLAUDE_SONNET_FALLBACK_MODEL").replace(/"/g, ""), "claude-sonnet-5");
assert.equal(extractConst(appScript, "CLAUDE_ARTICLE_MAX_CONTINUATIONS"), "2");
assert.equal(extractConst(appScript, "EXPANSION_MAX_PASSES"), "3");
assert.equal(extractConst(appScript, "EXPANSION_RECOVERY_PASSES"), "1");
assert.equal(extractConst(appScript, "TARGET_LENGTH_RATIO"), "0.9");
assert.equal(extractConst(appScript, "DEFAULT_TARGET_CHARS"), "6000");

assert.match(appScript, /function delay\(ms\)/);
assert.match(appScript, /function isRetryableHttpStatus\(status\)/);
assert.match(appScript, /function safeJsonParse\(raw/);
assert.match(appScript, /const event = safeJsonParse\(payload\)/);

console.log("stability-characterization tests: PASS");
