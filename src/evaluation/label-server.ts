import http from "node:http";
import type { AddressInfo } from "node:net";
import { openSystemBrowser } from "../visualization/dev-server.js";
import { loadLabels, saveLabel } from "./store.js";
import type { EvaluationDataset, EvaluationLabel, EvaluationRun, FeedbackClass } from "./types.js";
import { FEEDBACK_CLASSES } from "./types.js";

export interface LabelServerOptions { root: string; dataset: EvaluationDataset; run?: EvaluationRun; port?: number; openBrowser?: boolean }
export interface LabelServer { url: string; close(): Promise<void> }

export async function startLabelServer(options: LabelServerOptions): Promise<LabelServer> {
  const server = http.createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; connect-src 'self'");
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderLabelApp(options.dataset, options.run, loadLabels(options.root, options.dataset.id)));
      return;
    }
    if (request.method === "GET" && request.url === "/api/state") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ dataset: options.dataset, run: options.run ?? null, labels: loadLabels(options.root, options.dataset.id) }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/labels") {
      readJson(request, 64_000).then((raw) => {
        const label = validateEvaluationLabel(raw, options.dataset);
        saveLabel(options.root, label);
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify(label));
      }).catch((cause) => {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/`;
  if (options.openBrowser !== false) openSystemBrowser(url);
  return { url, close: () => new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve())) };
}

function readJson(request: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) reject(new Error("Label request is too large.")); else chunks.push(chunk); });
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Label request must be valid JSON.")); } });
    request.on("error", reject);
  });
}

export function validateEvaluationLabel(raw: unknown, dataset: EvaluationDataset): EvaluationLabel {
  if (typeof raw !== "object" || raw === null) throw new Error("Label must be an object.");
  const item = raw as Record<string, unknown>;
  const pullRequest = Number(item["pullRequest"]);
  if (!dataset.cases.some((entry) => entry.number === pullRequest)) throw new Error("Pull request is not in this dataset.");
  if (!["pass", "warn", "block"].includes(String(item["expectedOutcome"]))) throw new Error("Expected outcome is invalid.");
  if (!(FEEDBACK_CLASSES as readonly unknown[]).includes(item["feedbackClass"])) throw new Error("Feedback class is invalid.");
  if (!["low", "medium", "high"].includes(String(item["confidence"]))) throw new Error("Confidence is invalid.");
  if (typeof item["labeler"] !== "string" || !item["labeler"].trim()) throw new Error("Labeler is required.");
  return {
    schemaVersion: "1",
    datasetId: dataset.id,
    pullRequest,
    expectedOutcome: item["expectedOutcome"] as EvaluationLabel["expectedOutcome"],
    expectedReviewers: Array.isArray(item["expectedReviewers"]) ? item["expectedReviewers"].filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [],
    hardenedImpactExpected: item["hardenedImpactExpected"] === true,
    feedbackClass: item["feedbackClass"] as FeedbackClass,
    confidence: item["confidence"] as EvaluationLabel["confidence"],
    notes: typeof item["notes"] === "string" ? item["notes"].slice(0, 10_000) : "",
    labeler: item["labeler"].trim().slice(0, 200),
    createdAt: new Date().toISOString(),
  };
}

export function renderLabelApp(dataset: EvaluationDataset, run: EvaluationRun | undefined, labels: EvaluationLabel[]): string {
  const data = JSON.stringify({ dataset, run: run ?? null, labels }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NodeNet Decision Lab</title><style>
:root{color-scheme:dark;--bg:#07111f;--panel:#101c30;--line:#2b3a52;--text:#edf4ff;--muted:#8fa1b9;--accent:#5ed0ff;--ok:#4ade80;--warn:#fbbf24;--bad:#fb7185}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px Inter,system-ui,sans-serif}.top{height:60px;display:flex;align-items:center;padding:0 22px;border-bottom:1px solid var(--line);gap:16px}.brand{font-size:18px;font-weight:750}.brand span{color:var(--accent)}.progress{margin-left:auto;color:var(--muted)}main{display:grid;grid-template-columns:300px minmax(0,1fr) 360px;height:calc(100vh - 60px)}aside,.form{background:var(--panel);overflow:auto;padding:18px}.list{border-right:1px solid var(--line)}.form{border-left:1px solid var(--line)}.case{padding:11px;border:1px solid transparent;border-radius:9px;cursor:pointer;margin-bottom:5px}.case:hover,.case.active{background:#17253b;border-color:#39516f}.case small{display:block;color:var(--muted);margin-top:4px}.content{padding:28px;overflow:auto}.eyebrow{color:var(--accent);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-size:25px;margin:9px 0}a{color:var(--accent)}.meta{display:flex;gap:14px;color:var(--muted);margin-bottom:24px}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}.hidden-answer{padding:30px;text-align:center;color:var(--muted)}label{display:block;color:var(--muted);margin:15px 0 6px}select,input,textarea,button{width:100%;font:inherit;color:var(--text);background:#091426;border:1px solid var(--line);border-radius:8px;padding:10px}textarea{min-height:90px;resize:vertical}button{background:linear-gradient(90deg,#0891b2,#4f46e5);border:0;font-weight:700;cursor:pointer;margin-top:16px}.reveal{background:#17253b;border:1px solid var(--line)}.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:3px 8px;margin:3px;color:#cbd5e1}.status{margin-top:10px;color:var(--ok)}@media(max-width:900px){main{grid-template-columns:1fr}.list{display:none}.form{border-left:0}.content{min-height:50vh}}
</style></head><body><header class="top"><div class="brand"><span>NodeNet</span> Decision Lab</div><div id="dataset"></div><div class="progress" id="progress"></div></header><main><aside class="list"><div class="eyebrow">Cases</div><div id="cases"></div></aside><section class="content" id="content"></section><aside class="form"><div class="eyebrow">Human label</div><label>Expected outcome</label><select id="outcome"><option>pass</option><option>warn</option><option>block</option></select><label>Expected reviewers (comma separated)</label><input id="reviewers"><label><input id="hardened" type="checkbox" style="width:auto"> Hardened impact expected</label><label>Feedback class</label><select id="feedback"><option>correct</option><option>false-positive</option><option>wrong-reviewer</option><option>missed-impact</option><option>excluded</option></select><label>Confidence</label><select id="confidence"><option>high</option><option>medium</option><option>low</option></select><label>Your name or handle</label><input id="labeler"><label>Notes</label><textarea id="notes"></textarea><button id="save">Save and next</button><div class="status" id="status"></div></aside></main><script>
const DATA=${data};let index=0,revealed=false;const byPr=new Map(DATA.labels.map(x=>[x.pullRequest,x]));const runByPr=new Map((DATA.run&&DATA.run.cases||[]).map(x=>[x.pullRequest,x]));
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function drawList(){document.getElementById("dataset").textContent=DATA.dataset.id;document.getElementById("progress").textContent=byPr.size+" / "+DATA.dataset.cases.length+" labeled";document.getElementById("cases").innerHTML=DATA.dataset.cases.map((c,i)=>'<div class="case '+(i===index?'active':'')+'" data-i="'+i+'"><b>#'+c.number+' '+esc(c.title)+'</b><small>'+(byPr.has(c.number)?'✓ labeled':'not labeled')+'</small></div>').join("");document.querySelectorAll('.case').forEach(x=>x.onclick=()=>{index=Number(x.dataset.i);revealed=false;draw()})}
function draw(){drawList();const c=DATA.dataset.cases[index],r=runByPr.get(c.number),old=byPr.get(c.number);document.getElementById("content").innerHTML='<div class="eyebrow">Pull request #'+c.number+'</div><h1>'+esc(c.title)+'</h1><div class="meta"><span>'+esc(c.authorLogin||'unknown author')+'</span><span>'+esc(c.baseRef)+' ← '+esc(c.headRef)+'</span><span>'+(c.merged?'merged':'not merged')+'</span></div><div class="card"><b>Observed GitHub activity</b><p>Requested: '+(c.requestedReviewers.map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'none')+'</p><p>Submitted reviews: '+(c.submittedReviewers.map(x=>'<span class="pill">'+esc(x)+'</span>').join('')||'none')+'</p><a href="'+esc(c.url)+'" target="_blank" rel="noreferrer">Open pull request ↗</a></div>'+(revealed?'<div class="card"><b>NodeNet result</b><p>'+(r&&r.decision?esc(r.decision.outcome.toUpperCase()+' · '+r.decision.severity+' · '+r.decision.decisionId):esc(r&&r.error||'No replay result'))+'</p><p>'+(r&&r.decision?r.decision.requiredApprovals.map(x=>'<span class="pill">'+esc(x.target)+'</span>').join(''):'')+'</p></div>':'<div class="card hidden-answer">NodeNet answer is hidden to reduce labeling bias.<button class="reveal" id="reveal">Reveal after deciding</button></div>');if(!revealed)document.getElementById('reveal').onclick=()=>{revealed=true;draw()};for(const [id,key] of [['outcome','expectedOutcome'],['feedback','feedbackClass'],['confidence','confidence'],['notes','notes'],['labeler','labeler']])document.getElementById(id).value=old&&old[key]||document.getElementById(id).value;document.getElementById('reviewers').value=old?old.expectedReviewers.join(', '):'';document.getElementById('hardened').checked=old&&old.hardenedImpactExpected||false}
document.getElementById('save').onclick=async()=>{const c=DATA.dataset.cases[index];const body={pullRequest:c.number,expectedOutcome:outcome.value,expectedReviewers:reviewers.value.split(',').map(x=>x.trim()).filter(Boolean),hardenedImpactExpected:hardened.checked,feedbackClass:feedback.value,confidence:confidence.value,notes:notes.value,labeler:labeler.value};const res=await fetch('/api/labels',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await res.json();if(!res.ok){status.textContent=value.error;return}byPr.set(c.number,value);status.textContent='Saved';index=Math.min(index+1,DATA.dataset.cases.length-1);revealed=false;draw()};draw();
</script></body></html>`;
}
