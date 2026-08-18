import fs from "node:fs";

const path = "/home/ubuntu/qaplus-blog-studio/qa-plus-api-worker.js";
const source = fs.readFileSync(path, "utf8");
const normalized = source.replaceAll("\\\\", "\\");
if (normalized === source) throw new Error("Normalizing target was not found.");
fs.writeFileSync(path, normalized);
console.log("Normalized worker escape sequences.");
