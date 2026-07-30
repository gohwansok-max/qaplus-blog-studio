import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
const appScript = scripts.at(-1);

assert.ok(appScript, "inline application script should exist");
new vm.Script(appScript, { filename: "index.html:inline-script" });

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} body is incomplete`);
}

const payloadFunction = extractFunction(appScript, "createBloggerPostPayload");
const payloadContext = {};
vm.runInNewContext(`${payloadFunction}; result = createBloggerPostPayload(
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
assert.deepEqual(Object.keys(payload).sort(), ["content", "labels", "title"]);

const errorFunction = extractFunction(appScript, "createBloggerApiError");
const errorContext = {};
vm.runInNewContext(`${errorFunction}; result = createBloggerApiError(
  { status: 403 },
  { error: { message: "The caller does not have permission" } },
  "Blogger 글 발행"
);`, errorContext);
assert.match(errorContext.result.message, /Blogger 발행 권한/);
assert.equal(errorContext.result.status, 403);

const resolveBlogIdFunction = extractFunction(appScript, "resolveBlogId");
const resolveWriteAccessFunction = extractFunction(appScript, "resolveBloggerWriteAccess");
const accessCalls = [];
const accessContext = {
  BLOG_URL:"https://qaplus-haccp.blogspot.com/",
  state:{ googleToken:"test-token", blogId:"", bloggerWritable:false },
  fetch:async (url) => {
    accessCalls.push(String(url));
    if (String(url).includes("/blogs/byurl")) {
      return { ok:true, status:200, json:async () => ({ id:"5694600166844060136" }) };
    }
    return {
      ok:true,
      status:200,
      json:async () => ({
        blog_user_info:{
          userId:"02207174247840499887",
          blogId:"5694600166844060136",
          hasAdminAccess:true
        }
      })
    };
  }
};
await vm.runInNewContext(`(async () => {
  ${errorFunction}
  ${resolveBlogIdFunction}
  ${resolveWriteAccessFunction}
  result = await resolveBloggerWriteAccess();
})()`, accessContext);
assert.equal(accessContext.state.bloggerWritable, true);
assert.equal(accessContext.result.hasAdminAccess, true);
assert.match(accessCalls[1], /\/users\/self\/blogs\/5694600166844060136$/);

const fetchVideosFunction = extractFunction(appScript, "fetchQaPlusVideos");
const videoCalls = [];
const videoContext = {
  YOUTUBE_HANDLE:"@qaplus_haccp",
  state:{googleToken:"test-token",youtubeOwned:false,youtubeChannel:null,youtubeVideos:[]},
  els:{youtubeStatus:{},loadYoutube:{disabled:true}},
  setBadge:() => {},
  renderYoutubeVideos:() => {},
  googleApi:async (url) => {
    videoCalls.push(String(url));
    if (String(url).includes("forHandle=")) {
      return {items:[{id:"target-channel",contentDetails:{relatedPlaylists:{uploads:"uploads-list"}}}]};
    }
    if (String(url).includes("mine=true")) throw new Error("connected account has no YouTube channel");
    return {items:[{contentDetails:{videoId:"video-1"},snippet:{title:"HACCP 공개 영상"}}]};
  }
};
await vm.runInNewContext(`(async () => {
  ${fetchVideosFunction}
  result = await fetchQaPlusVideos();
})()`, videoContext);
assert.equal(videoContext.result.length,1);
assert.equal(videoContext.state.youtubeOwned,false);
assert.equal(videoContext.state.youtubeChannel.id,"target-channel");
assert.equal(videoContext.els.loadYoutube.disabled,false);
assert.ok(videoCalls.some((url) => url.includes("mine=true")));
assert.ok(videoCalls.some((url) => url.includes("playlistItems")));

assert.match(appScript, /GOOGLE_SCOPES[\s\S]*?\.join\(" "\)/);
assert.match(appScript, /hasGrantedAllScopes/);
assert.doesNotMatch(appScript, /youtube\.force-ssl/);
assert.match(appScript, /youtubeOk = videos\.length > 0/);
assert.match(appScript, /Blogger와 YouTube의 관리 계정이 달라도 정상/);
assert.doesNotMatch(appScript, /QA PLUS 계정으로 다시 연결|채널을 소유한 Google 계정으로 다시 연결/);
assert.match(appScript, /users\/self\/blogs\/\$\{encodeURIComponent\(blogId\)\}/);
assert.match(appScript, /state\.bloggerWritable/);
assert.match(appScript, /JSON\.stringify\(createBloggerPostPayload/);
assert.doesNotMatch(payloadFunction, /\bkind\b|\bblog\b|\bid\b/);

console.log("blogger-publish tests: PASS");
