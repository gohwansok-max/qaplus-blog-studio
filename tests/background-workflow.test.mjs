import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const workerSource = fs.readFileSync(path.join(root, "qa-plus-api-worker.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const wranglerSource = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");

const executableWorkerSource = workerSource
  .replace('import { WorkflowEntrypoint } from "cloudflare:workers";', 'class WorkflowEntrypoint { constructor(env) { this.env = env; } }')
  .replace('import { NonRetryableError } from "cloudflare:workflows";', 'class NonRetryableError extends Error {}');
const workerUrl = "data:text/javascript;base64," + Buffer.from(executableWorkerSource).toString("base64");
const worker = (await import(workerUrl)).default;

function kvMock() {
  const records = new Map();
  return {
    records,
    async get(key) { return records.get(key) || null; },
    async put(key, value) { records.set(key, value); }
  };
}

const jobs = kvMock();
const started = [];
const env = {
  BLOG_JOBS: jobs,
  BLOG_IMAGES: { async getWithMetadata() { return { value: null, metadata: null }; } },
  BLOG_WORKFLOW: {
    async create(options) { started.push(options); return { id: options.id }; },
    async get() { return { async terminate() {} }; }
  },
  QA_PLUS_ACCESS_KEY: "local-test-access-key"
};

function request(pathname, method = "GET", headers = {}, body) {
  return new Request("https://qa-plus-api.gohwansok.workers.dev" + pathname, {
    method,
    headers: { Origin: "https://gohwansok-max.github.io", ...headers },
    body
  });
}

const createResponse = await worker.fetch(
  request("/jobs", "POST", {
    "X-QA-PLUS-ACCESS-KEY": "local-test-access-key",
    "Content-Type": "application/json"
  }, JSON.stringify({
    topic: "HACCP 위생 전실 점검 방법",
    script: "서버 작업 등록 유효성 검사용 대본입니다. ".repeat(8),
    category: "HACCP",
    targetChars: 9000,
    imgCount: 3,
    sources: ["https://www.mfds.go.kr/"]
  })),
  env
);
const createText = await createResponse.text();
assert.equal(createResponse.status, 202, "서버 작업은 즉시 접수되어야 합니다: " + createText);
const created = JSON.parse(createText);
assert.ok(created.job.id.startsWith("qaplus-"));
assert.ok(created.jobKey.startsWith("key-"));
assert.equal(created.job.status, "queued");
assert.equal("jobKey" in created.job, false, "작업 조회 응답에 비밀 작업 키를 노출하지 않습니다");
assert.equal(started.length, 1, "워크플로 인스턴스를 한 번만 생성합니다");
assert.equal(started[0].params.jobId, created.job.id);

const noJobKey = await worker.fetch(request("/jobs/" + created.job.id, "GET", {
  "X-QA-PLUS-ACCESS-KEY": "local-test-access-key"
}), env);
assert.equal(noJobKey.status, 404, "작업 키 없이는 상태를 조회할 수 없습니다");

const statusResponse = await worker.fetch(request("/jobs/" + created.job.id, "GET", {
  "X-QA-PLUS-ACCESS-KEY": "local-test-access-key",
  "X-QA-PLUS-JOB-KEY": created.jobKey
}), env);
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.job.id, created.job.id);
assert.equal(status.job.status, "queued");
assert.equal("jobKey" in status.job, false);

const unauthorized = await worker.fetch(request("/jobs", "POST", {
  "X-QA-PLUS-ACCESS-KEY": "wrong-key",
  "Content-Type": "application/json"
}, JSON.stringify({topic: "테스트", script: "x".repeat(150)})), env);
assert.equal(unauthorized.status, 401, "작업실 접근 키가 다르면 생성할 수 없습니다");

assert.match(workerSource, /class BlogGenerationWorkflow extends WorkflowEntrypoint/);
assert.match(workerSource, /retries: \{limit: 6, delay: "10 seconds", backoff: "exponential"\}/);
assert.match(workerSource, /JOB_TTL_SECONDS = 60 \* 60 \* 24 \* 14/);
assert.match(workerSource, /X-QA-PLUS-ACCESS-KEY/);
assert.match(workerSource, /X-QA-PLUS-JOB-KEY/);
assert.match(wranglerSource, /binding = "BLOG_JOBS"/);
assert.match(wranglerSource, /binding = "BLOG_WORKFLOW"/);
assert.match(wranglerSource, /class_name = "BlogGenerationWorkflow"/);
assert.match(appSource, /const SERVER_JOB_KEY = KEY \+ "\.server-job"/);
assert.match(appSource, /async function startServerBlogJob\(input\)/);
assert.match(appSource, /async function resumeServerJob\(\)/);
assert.match(appSource, /applyServerJobResult\(job\)/);
assert.match(appSource, /document\.addEventListener\("visibilitychange"/);

console.log("background workflow tests: PASS");
