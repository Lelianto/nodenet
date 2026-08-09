import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

export interface GraphDevServerOptions {
  root: string;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  debounceMs?: number;
  render(): string;
}

export interface GraphDevServer {
  url: string;
  rebuild(): void;
  close(): Promise<void>;
}

const CLIENT = `<script>
(()=>{let state={};try{state=JSON.parse(sessionStorage.getItem("nodenet:view")||"{}")||{}}catch{}
const capture=()=>{const search=document.querySelector(".search");state={scrollX,scrollY,search:search&&search.value||""};sessionStorage.setItem("nodenet:view",JSON.stringify(state))};
if(state.search){const apply=()=>{const el=document.querySelector(".search");if(el){el.value=state.search;el.dispatchEvent(new Event("input"))}};setTimeout(apply,50)}scrollTo(state.scrollX||0,state.scrollY||0);
const es=new EventSource("/__nodenet/events");es.addEventListener("reload",()=>{capture();location.reload()});
es.addEventListener("error",()=>{let box=document.getElementById("nodenet-live-error");if(!box){box=document.createElement("div");box.id="nodenet-live-error";box.style="position:fixed;right:12px;top:64px;z-index:99999;background:#7f1d1d;color:white;padding:10px 14px;border-radius:8px;font:12px system-ui";document.body.appendChild(box)}box.textContent="Live connection interrupted — retrying…"});
window.addEventListener("beforeunload",capture);
})();</script>`;

export function withLiveReloadClient(html: string): string {
  return html.includes("</body>") ? html.replace("</body>", `${CLIENT}</body>`) : html + CLIENT;
}

export async function startGraphDevServer(options: GraphDevServerOptions): Promise<GraphDevServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("Graph live server is loopback-only. Use a reverse proxy with authentication for remote access.");
  }
  let html = withLiveReloadClient(options.render());
  let lastError: string | undefined;
  const clients = new Set<http.ServerResponse>();
  const notify = (event: "reload" | "error", data: string): void => {
    for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const rebuild = (): void => {
    try {
      html = withLiveReloadClient(options.render());
      lastError = undefined;
      notify("reload", new Date().toISOString());
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
      notify("error", lastError);
    }
  };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && pathname === "/__nodenet/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write(`event: ready\ndata: ${JSON.stringify({ error: lastError })}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "GET" && pathname === "/__nodenet/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: lastError === undefined, error: lastError ?? null }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}/`;
  let timer: NodeJS.Timeout | undefined;
  const ignored = new Set([".git", "node_modules", "dist", "coverage", ".nodenet"]);
  const watcher = fs.watch(options.root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const segments = filename.split(path.sep);
    if (segments.some((segment) => ignored.has(segment))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, options.debounceMs ?? 350);
  });
  if (options.openBrowser !== false) openSystemBrowser(url);
  return {
    url,
    rebuild,
    close: async () => {
      if (timer) clearTimeout(timer);
      watcher.close();
      for (const client of clients) client.end();
      await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    },
  };
}

export function openSystemBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
