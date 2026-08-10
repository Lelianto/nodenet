import { spawn } from "node:child_process";
import fs from "node:fs";

const cli = process.env.NODENET_MCP_BIN
  ?? new URL("../dist/cli/cli.js", import.meta.url).pathname;
const cwd = process.env.NODENET_MCP_CWD
  ?? "/Users/leliantopradana/Documents/PlugNPlay/ab-testing-medium/living-context-driven-development-with-nodenet";
const executable = process.env.NODENET_MCP_BIN ? cli : process.execPath;
const child = spawn(executable, [cli, "mcp"], { cwd, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const inbox = [];
let pending = [];
const waiters = new Map();
let nextId = 1;

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function sendRequest(method, params, options = {}) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  if (options.notify) delete payload.id;
  child.stdin.write(JSON.stringify(payload) + "\n");
  if (options.notify) return Promise.resolve();
  return new Promise((resolve) => waiters.set(id, resolve)).then((m) => m);
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log("RAW:", line.slice(0, 300)); continue; }
    if (msg.id !== undefined && msg.id !== null && waiters.has(msg.id)) {
      const resolve = waiters.get(msg.id);
      waiters.delete(msg.id);
      resolve(msg);
    } else {
      inbox.push(msg);
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(300);
const init = await sendRequest("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "dogfood-probe", version: "0.1.0" },
});
console.log("--- initialize ---");
console.log("serverInfo:", init.result?.serverInfo);
console.log("protocolVersion:", init.result?.protocolVersion);

sendRequest("notifications/initialized", {}, { notify: true });
await sleep(200);

const tools = await sendRequest("tools/list", {});
const names = tools.result?.tools?.map((t) => t.name) ?? [];
console.log("--- tools/list (default preset) ---");
console.log("count:", names.length, "| tools:", names.join(", "));

const call = await sendRequest("tools/call", { name: "ask", arguments: { question: "where is context trigger evaluation implemented" } });
const res = call.result;
console.log("--- tools/call ask (transport) ---");
console.log("content array length:", Array.isArray(res?.content) ? res.content.length : "n/a");
console.log("has structuredContent:", !!res?.structuredContent);
const data = res?.structuredContent?.data;
if (data) {
  console.log("structuredContent keys:", Object.keys(data).join(", "));
  console.log("has codeContext:", "codeContext" in data, "| has selectionReason:", "selectionReason" in data);
  console.log("recommendedFiles:", JSON.stringify(data.recommendedFiles));
  console.log("schemaVersion:", res.structuredContent.schemaVersion, "| trust:", res.structuredContent.trust, "| tool:", res.structuredContent.tool);
}

const ctx = await sendRequest("tools/call", { name: "context", arguments: { target: "TriggerEvaluator", detail: "route" } });
const cdata = ctx.result?.structuredContent?.data;
console.log("--- tools/call context route (transport) ---");
console.log("content array length:", Array.isArray(ctx.result?.content) ? ctx.result.content.length : "n/a");
console.log("route codeEvidence count:", Array.isArray(cdata?.codeEvidence) ? cdata.codeEvidence.length : "n/a");
console.log("has codeContext:", "codeContext" in (cdata ?? {}), "| has selectionReason:", "selectionReason" in (cdata ?? {}));

child.kill();

const audit = fs.readFileSync(cwd + "/.nodenet/token-log.jsonl", "utf8");
const lines = audit.trim().split("\n").slice(-6);
console.log("--- token-log tail ---");
for (const l of lines) console.log(l);