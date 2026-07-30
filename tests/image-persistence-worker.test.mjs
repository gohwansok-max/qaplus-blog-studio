import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here,"..");
const workerSource = fs.readFileSync(path.join(root,"qa-plus-api-worker.js"),"utf8");
const wranglerSource = fs.readFileSync(path.join(root,"wrangler.toml"),"utf8");
const workerModuleUrl = "data:text/javascript;base64," + Buffer.from(workerSource).toString("base64");
const worker = (await import(workerModuleUrl)).default;

function createKvMock() {
  const objects = new Map();
  return {
    objects,
    namespace:{
      async put(key,body,options = {}) {
        objects.set(key,{
          bytes:new Uint8Array(body),
          metadata:options.metadata || {}
        });
      },
      async getWithMetadata(key) {
        const item = objects.get(key);
        if (!item) return {value:null,metadata:null};
        return {
          value:item.bytes.buffer.slice(
            item.bytes.byteOffset,
            item.bytes.byteOffset + item.bytes.byteLength
          ),
          metadata:item.metadata
        };
      }
    }
  };
}

function generationRequest() {
  return new Request("https://qa-plus-api.gohwansok.workers.dev/v1/images/generations",{
    method:"POST",
    headers:{
      Origin:"https://gohwansok-max.github.io",
      Authorization:"Bearer test-key",
      "Content-Type":"application/json"
    },
    body:JSON.stringify({model:"gpt-image-2",prompt:"mock"})
  });
}

const originalFetch = globalThis.fetch;

try {
  {
    const kv = createKvMock();
    const imageBytes = new Uint8Array([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0xff,0xd9]);
    globalThis.fetch = async (url) => {
      assert.match(String(url),/api\.cheapsub\.im\/v1\/images\/generations$/);
      return new Response(JSON.stringify({
        data:[{b64_json:Buffer.from(imageBytes).toString("base64")}]
      }),{
        status:200,
        headers:{"Content-Type":"application/json"}
      });
    };

    const response = await worker.fetch(generationRequest(),{BLOG_IMAGES:kv.namespace});
    assert.equal(response.status,200);
    const data = await response.json();
    assert.equal(data.data.length,1);
    assert.match(data.data[0].persistent_url,/^https:\/\/qa-plus-api\.gohwansok\.workers\.dev\/blog-images\/generated\/[a-f0-9]{64}\.jpg$/);
    assert.equal(data.data[0].url,data.data[0].persistent_url);
    assert.equal(data.data[0].proxy_url,data.data[0].persistent_url);
    assert.equal("b64_json" in data.data[0],false);
    assert.equal(kv.objects.size,1);

    const publicImage = await worker.fetch(new Request(data.data[0].persistent_url),{BLOG_IMAGES:kv.namespace});
    assert.equal(publicImage.status,200);
    assert.equal(publicImage.headers.get("Content-Type"),"image/jpeg");
    assert.match(publicImage.headers.get("Cache-Control"),/max-age=31536000/);
    assert.equal(publicImage.headers.get("Access-Control-Allow-Origin"),"*");
    assert.deepEqual(new Uint8Array(await publicImage.arrayBuffer()),imageBytes);
  }

  {
    const kv = createKvMock();
    const imageBytes = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({
          data:[{proxy_url:"/v1/images/proxy?url=https%3A%2F%2Ffile.kayops.com%2Ffile%2Fmock.png"}]
        }),{
          status:200,
          headers:{"Content-Type":"application/json"}
        });
      }
      assert.equal(String(url),"https://api.cheapsub.im/v1/images/proxy?url=https%3A%2F%2Ffile.kayops.com%2Ffile%2Fmock.png");
      return new Response(imageBytes,{
        status:200,
        headers:{"Content-Type":"image/png"}
      });
    };

    const response = await worker.fetch(generationRequest(),{BLOG_IMAGES:kv.namespace});
    const data = await response.json();
    assert.equal(response.status,200);
    assert.match(data.data[0].persistent_url,/\.png$/);
    assert.equal(fetchCount,2);
    assert.equal(kv.objects.size,1);
  }

  {
    globalThis.fetch = async () => new Response(JSON.stringify({
      data:[{proxy_url:"https://example.com/not-allowed.jpg"}]
    }),{
      status:200,
      headers:{"Content-Type":"application/json"}
    });
    const kv = createKvMock();
    const response = await worker.fetch(generationRequest(),{BLOG_IMAGES:kv.namespace});
    assert.equal(response.status,502);
    const data = await response.json();
    assert.match(data.error.message,/영구 저장소/);
    assert.equal(kv.objects.size,0);
  }
} finally {
  globalThis.fetch = originalFetch;
}

assert.match(wranglerSource,/\[\[kv_namespaces\]\]/);
assert.match(wranglerSource,/binding = "BLOG_IMAGES"/);
assert.match(wranglerSource,/id = "c8b59db591e545049c2b1401a691d592"/);
assert.match(workerSource,/const PUBLIC_IMAGE_PREFIX = "\/blog-images\/"/);
assert.match(workerSource,/persistGeneratedImages/);

console.log("image-persistence-worker tests: PASS");
