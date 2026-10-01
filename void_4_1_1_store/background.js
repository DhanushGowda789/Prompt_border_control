const DEFAULT_AI = {
  ollamaUrl: "http://127.0.0.1:11434",
  textModel: "llama3.2:3b",
  visionModel: "",           // opt-in: vision models are heavy, pick one in Settings
  autoModel: true            // if the chosen model is missing or cannot cope, use another installed one
};
const ORIGIN_RULE_ID = 1;

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  syncOriginRule();
});
chrome.runtime.onStartup.addListener(syncOriginRule);
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.ai) syncOriginRule(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === "void-ping") {
    // verify:true (used before an upload is checked) tests an unknown model once, so the answer is never a guess.
    (msg.verify ? withKeepAlive(() => ping(true)) : ping(false)).then(sendResponse).catch(e => sendResponse({ ok: false, error: friendly(e) }));
    return true;
  }
  if (msg?.type === "void-local-ai") {
    withKeepAlive(() => classify(msg)).then(sendResponse).catch(e => sendResponse({ ok: false, error: friendly(e) }));
    return true;
  }
  if (msg?.type === "void-check-model") {
    withKeepAlive(() => checkModel(msg)).then(sendResponse).catch(e => sendResponse({ ok: false, error: friendly(e) }));
    return true;
  }
});

// Streaming chat for "Run on local Ollama". The tab talks to us over a port; closing the port cancels the run.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "void-chat" || port.sender?.id !== chrome.runtime.id) return;
  const ctl = new AbortController();
  const send = m => { try { port.postMessage(m); } catch (_) {} };
  port.onDisconnect.addListener(() => ctl.abort());
  port.onMessage.addListener(async msg => {
    try {
      await withKeepAlive(() => chat(msg, t => send({ token: t }), ctl.signal));
      send({ done: true });
    } catch (e) { if (!ctl.signal.aborted) send({ error: friendly(e) }); }
  });
});

async function config() {
  const { ai } = await chrome.storage.local.get({ ai: DEFAULT_AI });
  const cfg = { ...DEFAULT_AI, ...ai };
  const u = new URL(cfg.ollamaUrl);            // throws on garbage, which is what we want
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Ollama URL must start with http:// or https://");
  cfg.base = u.origin;
  cfg.remote = !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  return cfg;
}

/* Ollama answers 403 to any Origin it doesn't know, and "chrome-extension://" is not on its default list.
   Rewrite the Origin of this extension's own requests to Ollama's address, so users don't have to set
   OLLAMA_ORIGINS. Scoped to requests started by this extension, so web pages gain nothing from it.
   If this fails, the OLLAMA_ORIGINS steps in the README still work. */
async function syncOriginRule() {
  try {
    const cfg = await config();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ORIGIN_RULE_ID],
      addRules: [{
        id: ORIGIN_RULE_ID, priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: cfg.base }] },
        condition: { urlFilter: `|${cfg.base}/`, resourceTypes: ["xmlhttprequest", "other"], initiatorDomains: [chrome.runtime.id] }
      }]
    });
  } catch (_) { /* best effort */ }
}

function friendly(e) {
  const m = String(e?.message || e);
  if (e?.name === "AbortError") return "The local model took too long to answer";
  if (/HTTP 403/.test(m)) return "Ollama blocked the extension. Set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.";
  if (/more system memory|out of memory|unable to allocate|not enough memory/i.test(m)) return "The local model needs more memory than this computer has free.";
  if (/HTTP 404|not found/i.test(m)) return "Ollama does not have that model. Pick an installed model in Settings, or run: ollama pull <model>";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Ollama is not reachable. Start it and check the address in Settings.";
  return m;
}

async function timedFetch(url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/* A Manifest V3 service worker is stopped after ~30 s without activity, which would kill a slow
   model load or a long document mid-request. Any extension API call resets that timer. */
async function withKeepAlive(fn) {
  const iv = setInterval(() => { try { chrome.runtime.getPlatformInfo(); } catch (_) {} }, 20000);
  try { return await fn(); } finally { clearInterval(iv); }
}

/* ====================== model discovery and compatibility ======================
   Goal: work with whatever models the user already has in Ollama.
   1. Read each model's real capabilities from Ollama (/api/show), falling back to name heuristics on old versions.
   2. Probe a model once with a tiny known document; cache the verdict per model build (digest).
   3. Use the chosen model if it works. If it is missing or cannot cope, move to the best other installed model.
   4. If none can cope, raise an error that lists every model and why, so the user sees it. */

const MEM_TTL = 10 * 60 * 1000;          // "out of memory" / "too slow" verdicts expire; the user may free RAM
const JSON_HDR = { "Content-Type": "application/json" };

function parseB(sz) {                      // "3.2B" -> 3.2, "270M" -> 0.27
  const m = /([\d.]+)\s*([mbt])/i.exec(String(sz || ""));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return /m/i.test(m[2]) ? n / 1000 : /t/i.test(m[2]) ? n * 1000 : n;
}

function analyzeModel(m, caps) {
  const name = m.name || "";
  const fam = String(m.details?.family || "").toLowerCase();
  const fams = (m.details?.families || []).map(f => String(f).toLowerCase()).join(" ");
  const paramSize = m.details?.parameter_size || "";
  const quant = m.details?.quantization_level || "";
  const b = parseB(paramSize);

  // Heuristics for old Ollama versions that do not report capabilities.
  let isEmbedding = /embed|bge-|minilm|nomic-bert|colbert|arctic-embed|snowflake/i.test(name) || /bert|embed/i.test(fam) || /bert|embed/i.test(fams);
  let hasVision = /clip|mllama|qwen2vl|qwen25vl|qwen2\.5vl/i.test(fams) ||
    /vision|llava|moondream|minicpm-v|bakllava|qwen2\.5-?vl|qwen2-?vl|qwen3-?vl|granite3\.2-vision|llama3\.2-vision/i.test(name) ||
    (/gemma3/i.test(name) && b > 1.5);                      // gemma3:1b is text-only
  let isThinking = /deepseek-r1|qwq|qwen3(?!-?vl)|gpt-oss|thinking|magistral|phi4-reasoning/i.test(name);

  // Real answer from Ollama wins.
  if (Array.isArray(caps)) {
    isEmbedding = caps.includes("embedding") && !caps.includes("completion");
    hasVision = caps.includes("vision");
    isThinking = caps.includes("thinking");
  }
  return { name, family: fam || "standard", parameterSize: paramSize, billions: b, quantization: quant,
    isEmbedding, hasVision, isThinking, caps: Array.isArray(caps) ? caps : null, sizeBytes: m.size || 0 };
}

function sameModel(have, want) {
  if (!want) return false;
  return have === want || have === `${want}:latest` || (!want.includes(":") && have.split(":")[0] === want);
}
function hasModel(models, want) { return models.some(n => sameModel(n, want)); }

async function apiPost(cfg, path, body, ms) {
  return timedFetch(`${cfg.base}${path}`, { method: "POST", headers: JSON_HDR, body: JSON.stringify(body) }, ms);
}

const showCache = new Map();
async function capabilitiesOf(cfg, m) {
  const key = `${m.name}|${m.digest || ""}`;
  if (showCache.has(key)) return showCache.get(key);
  let caps = null;
  try {
    const r = await apiPost(cfg, "/api/show", { model: m.name }, 3000);
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.capabilities)) caps = j.capabilities.map(String); }
  } catch (_) { /* old Ollama or busy: fall back to heuristics */ }
  showCache.set(key, caps);
  return caps;
}

let installedMemo = null;
/** Installed models with their analysed capabilities. Cached for 15 s. */
async function installed(cfg, fresh) {
  if (!fresh && installedMemo && installedMemo.base === cfg.base && Date.now() - installedMemo.at < 15000) return installedMemo.list;
  const res = await timedFetch(`${cfg.base}/api/tags`, {}, 2500);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = ((await res.json()).models || []).filter(m => m?.name);
  const list = await Promise.all(raw.map(async m => ({ name: m.name, digest: m.digest || "", raw: m, meta: analyzeModel(m, await capabilitiesOf(cfg, m)) })));
  installedMemo = { base: cfg.base, at: Date.now(), list };
  return list;
}

// ---- verdict cache ---------------------------------------------------------
const ckey = (m, kind) => `${m.name}|${m.digest.slice(0, 12)}|${kind}`;
async function compatAll() { return (await chrome.storage.local.get({ compat: {} })).compat || {}; }
async function compatPut(m, kind, entry) {
  const all = await compatAll();
  all[ckey(m, kind)] = { ...entry, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 80) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 80)) delete all[k];
  await chrome.storage.local.set({ compat: all });
}
function live(e) {
  if (!e) return null;
  if ((e.status === "memory" || e.status === "slow") && Date.now() - e.at > MEM_TTL) return null;
  return e;
}
const blocked = e => !!e && (e.status === "bad" || e.status === "memory" || e.status === "slow");

// ---- ranking ---------------------------------------------------------------
const FAMILY_SCORE = [[/qwen2\.5|qwen2(?![.\d])/i, 30], [/llama3/i, 28], [/gemma/i, 26], [/phi[34]/i, 24], [/mistral|ministral/i, 22],
  [/qwen3/i, 20], [/granite/i, 18], [/smollm|tinyllama/i, 4], [/deepseek-r1|qwq/i, 3]];
function score(x, kind) {
  const n = x.name, b = x.meta.billions;
  let sc = 0;
  for (const [re, v] of FAMILY_SCORE) if (re.test(n)) { sc = v; break; }
  if (b >= 3 && b <= 9) sc += 20; else if (b > 9 && b <= 15) sc += 14; else if (b >= 1 && b < 3) sc += 10; else if (b > 15 && b <= 35) sc += 2; else if (b > 35) sc -= 12; else if (b > 0 && b < 1) sc -= 6;
  if (x.meta.isThinking) sc -= 8;                       // slower, and its reasoning is wasted on a yes/no verdict
  if (kind === "text" && x.meta.hasVision) sc -= 4;     // keep vision models for images when something lighter exists
  if (/coder|code(?:llama|gemma)?\b|starcoder/i.test(n)) sc -= 12;
  if (/\b(?:base|text)\b|-base|-text/i.test(n)) sc -= 15;
  return sc;
}

function plan(cfg, list, kind) {
  const want = kind === "image" ? cfg.visionModel : cfg.textModel;
  const usable = list.filter(x => !x.meta.isEmbedding && (kind === "text" || x.meta.hasVision));
  const configured = usable.find(x => sameModel(x.name, want)) || null;
  // Vision is opt-in: if the user never chose an image model, do not start one on their own.
  const auto = cfg.autoModel !== false && !(kind === "image" && !want);
  const others = auto ? usable.filter(x => x !== configured).sort((a, b) => score(b, kind) - score(a, kind)) : [];
  return { want, configured, ordered: configured ? [configured, ...others] : others, all: list };
}

function whyNot(x, kind) {
  if (x.meta.isEmbedding) return "embedding model, cannot generate text";
  if (kind === "image" && !x.meta.hasVision) return "cannot read images";
  return "";
}

class NoModelError extends Error {
  constructor(kind, want, tried, list) {
    const parts = tried.map(t => `${t.model}: ${t.reason}`);
    for (const x of list) if (!tried.some(t => t.model === x.name)) { const w = whyNot(x, kind); if (w) parts.push(`${x.name}: ${w}`); }
    const hint = kind === "image" ? "Pick an installed vision model in Settings, or run: ollama pull qwen2.5vl:3b" : "Install one with: ollama pull llama3.2:3b";
    super(!list.length
      ? `Ollama has no models installed. ${hint}`
      : `None of the installed Ollama models can run Void's ${kind === "image" ? "image" : "privacy"} check${parts.length ? ` (${parts.join("; ")})` : ""}. ${hint}`);
    this.noModel = true; this.tried = tried;
  }
}

// ---- generation helpers ----------------------------------------------------
function errKind(e, kind) {
  const m = `${e?.detail || ""} ${e?.message || ""}`;
  if (e?.name === "AbortError") return "slow";
  if (/more system memory|out of memory|unable to allocate|not enough memory|cuda|insufficient/i.test(m)) return "memory";
  if (/does not support (?:generate|generation|completion)|embedding/i.test(m)) return "embedding";
  if (kind === "image" && /image|vision|multimodal|mmproj/i.test(m)) return "novision";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "network";
  return "error";
}
const REASON = {
  slow: "took too long to answer on this computer", memory: "needs more free memory than this computer has",
  embedding: "embedding model, cannot generate text", novision: "does not support images"
};

async function* ndjson(res) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) { try { yield JSON.parse(line); } catch (_) { /* partial or noise line */ } }
    }
  }
  if (buf.trim()) { try { yield JSON.parse(buf); } catch (_) {} }
}

/** Streams /api/generate. The timer restarts on every chunk, so it is an idle timeout, not a total one. */
async function stream(cfg, body, { idleMs, onChunk, signal }) {
  const ctl = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), idleMs); };
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort);
  arm();
  try {
    const res = await fetch(`${cfg.base}/api/generate`, {
      method: "POST", headers: JSON_HDR, body: JSON.stringify({ ...body, stream: true }), signal: ctl.signal
    });
    if (!res.ok) {
      let detail = "";
      try { const t = await res.text(); try { detail = JSON.parse(t).error || t; } catch (_) { detail = t; } } catch (_) {}
      const e = new Error(`Ollama HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
      e.status = res.status; e.detail = String(detail); throw e;
    }
    for await (const obj of ndjson(res)) {
      arm();
      if (obj.error) { const e = new Error(obj.error); e.detail = obj.error; throw e; }
      onChunk(obj);
      if (obj.done) break;
    }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

const warm = new Set();    // models already loaded this session: a cold load can take a minute, a warm one cannot

/** One JSON answer from one model. Tries schema, then plain JSON mode, then no format at all. */
async function generateJson(cfg, x, o) {
  const base = {
    model: x.name, prompt: o.prompt, keep_alive: "30m",
    options: { temperature: 0, num_ctx: o.numCtx, num_predict: x.meta.isThinking ? Math.max(o.numPredict, 1200) : o.numPredict }
  };
  if (o.imageBase64) base.images = [o.imageBase64];
  if (x.meta.isThinking) base.think = /gpt-oss/i.test(x.name) ? "low" : false;   // reasoning tokens would eat the answer budget
  const idleMs = warm.has(x.name) ? o.idleMs : Math.max(o.idleMs, 90000);

  const formats = [o.schema || "json", "json", null].filter((f, i, a) => a.findIndex(g => JSON.stringify(g) === JSON.stringify(f)) === i);
  let text = "";
  for (let i = 0; i < formats.length; i++) {
    text = "";
    const body = { ...base };
    if (formats[i]) body.format = formats[i];
    try {
      await stream(cfg, body, { idleMs, onChunk: c => { text += c.response || ""; } });
    } catch (e) {
      if (e.status === 400 && /think/i.test(e.detail || "") && body.think !== undefined) { delete base.think; i--; continue; }   // model has no thinking switch
      if (e.status === 400 && i < formats.length - 1 && errKind(e, o.kind) === "error") continue;                               // format not supported here
      throw e;
    }
    warm.add(x.name);
    const parsed = extractJson(text);
    if (parsed || i === formats.length - 1) return { text, parsed };
  }
  return { text, parsed: null };
}

// ---- probes ----------------------------------------------------------------
const PROBE_SCHEMA = { type: "object", properties: { sensitive: { type: "boolean" }, personal: { type: "boolean" }, categories: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, required: ["sensitive", "personal", "categories", "reason"] };
const PROBE_TEXT = `You are a privacy classifier. Decide whether the document contains personal or highly sensitive information about a real person (government IDs, contact details, home address, financial data).
Reply with JSON only: {"sensitive":boolean,"personal":boolean,"categories":string[],"reason":string}
<<<DOCUMENT
Name: Ravi Kumar
Aadhaar: 2345 6789 0124
Mobile: 9876543210
Home address: 12 MG Road, Bengaluru 560038
DOCUMENT>>>
Answer now with the JSON object only.`;
const PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** Live test of one model. Returns { status: ok|limited|bad|memory|slow, reason, ms } and stores it. */
async function probe(cfg, x, kind) {
  const t0 = Date.now();
  let out;
  try {
    if (kind === "image") {
      const r = await generateJson(cfg, x, { kind, prompt: 'Reply with JSON only: {"vision":true}', imageBase64: PROBE_PNG, numCtx: 4096, numPredict: 60, idleMs: 60000 });
      out = r.text.trim() ? { status: "ok", reason: "accepted an image and answered" } : { status: "bad", reason: "returned an empty answer for an image" };
    } else {
      const r = await generateJson(cfg, x, { kind, prompt: PROBE_TEXT, schema: PROBE_SCHEMA, numCtx: 2048, numPredict: 250, idleMs: 45000 });
      if (!r.parsed || typeof r.parsed.sensitive !== "boolean") out = { status: "bad", reason: "did not return valid JSON" };
      else if (r.parsed.sensitive !== true) out = { status: "limited", reason: "returns valid JSON but missed obvious personal data in the test" };
      else out = { status: "ok", reason: "returns valid JSON and spots personal data" };
    }
  } catch (e) {
    const k = errKind(e, kind);
    if (k === "network") throw e;
    out = { status: k === "slow" || k === "memory" ? k : "bad", reason: REASON[k] || friendly(e) };
  }
  out.ms = Date.now() - t0;
  await compatPut(x, kind, out);
  return out;
}

/** Best usable model for this job. Probes unknown models once; never returns a model known to fail. */
async function resolve(cfg, kind, skip = []) {
  const list = await installed(cfg);
  const pl = plan(cfg, list, kind);
  const all = await compatAll();
  const tried = [];
  let fallbackLimited = null, probes = 0;

  for (const x of pl.ordered) {
    if (skip.includes(x.name)) continue;
    let e = live(all[ckey(x, kind)]);
    if (blocked(e)) { tried.push({ model: x.name, status: e.status, reason: e.reason }); continue; }
    if (!e) {
      if (probes >= 3) break;                  // cap the wait; remaining models stay untested for next time
      probes++;
      e = await probe(cfg, x, kind);
      if (blocked(e)) { tried.push({ model: x.name, status: e.status, reason: e.reason }); continue; }
    }
    if (e.status === "limited" && pl.ordered.length > 1) { fallbackLimited = fallbackLimited || { x, e }; continue; }
    return { x, model: x.name, auto: x !== pl.configured, configured: pl.want, verdict: e, tried };
  }
  if (fallbackLimited) return { x: fallbackLimited.x, model: fallbackLimited.x.name, auto: fallbackLimited.x !== pl.configured, configured: pl.want, verdict: fallbackLimited.e, tried };
  throw new NoModelError(kind, pl.want, tried, list);
}

/** What ping reports without running anything: best guess from cached verdicts. Fast. */
async function peek(cfg, list, kind) {
  const pl = plan(cfg, list, kind);
  const all = await compatAll();
  const tried = [];
  for (const x of pl.ordered) {
    const e = live(all[ckey(x, kind)]);
    if (blocked(e)) { tried.push({ model: x.name, status: e.status, reason: e.reason }); continue; }
    return { model: x.name, auto: x !== pl.configured, configured: pl.want, verdict: e || null, tried, error: null };
  }
  return { model: "", auto: false, configured: pl.want, verdict: null, tried, error: new NoModelError(kind, pl.want, tried, list).message };
}

async function ping(verify) {
  const cfg = await config();
  const list = await installed(cfg, true);
  const modelDetails = {};
  for (const x of list) modelDetails[x.name] = x.meta;
  let t;
  if (verify) {
    try { const p = await resolve(cfg, "text"); t = { model: p.model, auto: p.auto, configured: p.configured, error: "" }; }
    catch (e) { if (!e.noModel) throw e; t = { model: "", auto: false, configured: cfg.textModel, error: e.message }; }
  } else t = await peek(cfg, list, "text");
  const v = await peek(cfg, list, "image");
  const note = x => x.auto && x.model ? (x.configured && list.some(m => sameModel(m.name, x.configured)) ? `"${x.configured}" cannot be used here` : `"${x.configured}" is not installed`) : "";
  return {
    ok: true, models: list.map(x => x.name), modelDetails, url: cfg.base, remote: cfg.remote,
    textModel: t.model || cfg.textModel, visionModel: v.model || cfg.visionModel,
    configuredText: cfg.textModel, configuredVision: cfg.visionModel,
    hasText: !!t.model, hasVision: !!v.model, autoText: t.auto, autoNote: note(t), problem: t.error || ""
  };
}

/** Compatibility check of one named model, with a live probe. Used by Settings. */
async function checkModel(msg) {
  const cfg = await config();
  const kind = msg.kind === "image" || msg.kind === "vision" ? "image" : "text";
  const name = msg.model || (kind === "image" ? cfg.visionModel : cfg.textModel);
  if (!name) return { ok: false, error: "No model specified to check." };

  const list = await installed(cfg, true);
  const x = list.find(m => sameModel(m.name, name));
  if (!x) return { ok: true, model: name, compatible: false, status: "incompatible", installed: false, reason: `Model "${name}" is not installed in Ollama. Run: ollama pull ${name}` };
  const bad = reason => ({ ok: true, model: x.name, compatible: false, status: "incompatible", installed: true, meta: x.meta, reason });
  if (x.meta.isEmbedding) return bad(`"${x.name}" is an embedding-only model. It cannot generate text or perform privacy checks.`);
  if (kind === "image" && x.meta.caps && !x.meta.hasVision) return bad(`"${x.name}" does not support images.`);

  const r = await probe(cfg, x, kind);
  const size = x.meta.parameterSize ? `, ${x.meta.parameterSize}` : "";
  if (r.status === "bad" || r.status === "memory" || r.status === "slow") return { ...bad(`${x.name} ${r.reason}.`), latencyMs: r.ms };
  const warn = r.status === "limited" || x.meta.isThinking;
  return {
    ok: true, model: x.name, compatible: true, status: warn ? "warning" : "compatible", installed: true, meta: x.meta, latencyMs: r.ms, jsonParsed: true,
    message: r.status === "limited" ? `Works, but weak: ${r.reason} (${r.ms}ms${size}). Pattern scan still catches IDs.`
      : x.meta.isThinking ? `Reasoning model verified (thinking is switched off for privacy checks, ${r.ms}ms${size})`
      : kind === "image" ? `Vision model verified (${r.ms}ms${size})` : `Model verified and compatible (${r.ms}ms${size})`
  };
}

/** Robust JSON extraction from any model output (thinking tokens, markdown code blocks, loose formatting) */
function extractJson(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  let cleaned = rawText;
  cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<thought[\s\S]*?<\/thought>/gi, "");
  cleaned = cleaned.replace(/^[\s\S]*?<\/think>/i, "");                          // opening tag was part of the prompt template
  cleaned = cleaned.replace(/^[\s\S]*?<think>([\s\S]*?)(?=\{)/gi, "");
  cleaned = cleaned.trim();
  if (!cleaned) return null;

  const okShape = v => v && typeof v === "object" && !Array.isArray(v);
  try { const v = JSON.parse(cleaned); if (okShape(v)) return v; } catch (_) {}

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) { try { const v = JSON.parse(fenceMatch[1].trim()); if (okShape(v)) return v; } catch (_) {} }

  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try { const v = JSON.parse(candidate); if (okShape(v)) return v; } catch (_) {}
    try {
      const repaired = candidate
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
        .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
      const v = JSON.parse(repaired); if (okShape(v)) return v;
    } catch (_) {}
  }

  // Last resort: pull the fields out of text that is not valid JSON at all.
  const sensitiveMatch = cleaned.match(/"?sensitive"?\s*:\s*(true|false)/i);
  const personalMatch = cleaned.match(/"?personal"?\s*:\s*(true|false)/i);
  const personMatch = cleaned.match(/"?contains_person"?\s*:\s*(true|false)/i);
  const reasonMatch = cleaned.match(/"?reason"?\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  const catMatch = cleaned.match(/"?categories"?\s*:\s*\[([^\]]*)\]/i);
  if (sensitiveMatch || personalMatch) {
    const cats = [];
    if (catMatch && catMatch[1]) { const re = /"([^"\\]*(?:\\.[^"\\]*)*)"/g; let m; while ((m = re.exec(catMatch[1])) !== null) cats.push(m[1]); }
    return {
      sensitive: sensitiveMatch ? sensitiveMatch[1].toLowerCase() === "true" : false,
      personal: personalMatch ? personalMatch[1].toLowerCase() === "true" : false,
      contains_person: personMatch ? personMatch[1].toLowerCase() === "true" : false,
      categories: cats, reason: reasonMatch ? reasonMatch[1] : ""
    };
  }
  return null;
}

/** One-shot JSON classification. If the model cannot cope, the next installed model is tried; the verdict is remembered. */
async function classify(msg) {
  const cfg = await config();
  const kind = msg.kind === "image" ? "image" : "text";
  const skip = [], failed = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const pick = await resolve(cfg, kind, skip);      // throws NoModelError with the reason for every model
    let r;
    try {
      r = await generateJson(cfg, pick.x, {
        kind, prompt: String(msg.prompt || ""), schema: msg.schema, imageBase64: kind === "image" ? msg.imageBase64 : undefined,
        numCtx: kind === "image" ? 4096 : 2048, numPredict: 250, idleMs: Math.min(Number(msg.timeoutMs) || 90000, 180000)
      });
    } catch (e) {
      const k = errKind(e, kind);
      if (k === "network" || !cfg.autoModel && k === "error") throw e;
      const reason = REASON[k] || friendly(e);
      await compatPut(pick.x, kind, { status: k === "slow" || k === "memory" ? k : "bad", reason });
      failed.push({ model: pick.model, reason }); skip.push(pick.model);
      continue;
    }
    if (!r.parsed) {
      await compatPut(pick.x, kind, { status: "bad", reason: "did not return valid JSON" });
      failed.push({ model: pick.model, reason: "did not return valid JSON" }); skip.push(pick.model);
      continue;
    }
    return { ok: true, model: pick.model, auto: pick.auto, configured: pick.configured, skipped: failed, result: r.parsed };
  }
  return { ok: true, model: failed.at(-1)?.model || "", result: { parseError: true, tried: failed } };
}

/** Drops <think>…</think> from a token stream, even when a tag is split across chunks. */
function thinkFilter(emit) {
  const OPEN = "<think>", CLOSE = "</think>";
  let buf = "", inside = false;
  const partial = (s, tag) => { for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n; return 0; };
  return {
    push(t) {
      buf += t;
      for (;;) {
        if (inside) {
          const i = buf.indexOf(CLOSE);
          if (i < 0) { buf = buf.slice(-(CLOSE.length - 1)); return; }
          buf = buf.slice(i + CLOSE.length); inside = false;
        } else {
          const i = buf.indexOf(OPEN);
          if (i < 0) { const keep = partial(buf, OPEN); if (buf.length > keep) emit(buf.slice(0, buf.length - keep)); buf = buf.slice(buf.length - keep); return; }
          if (i > 0) emit(buf.slice(0, i));
          buf = buf.slice(i + OPEN.length); inside = true;
        }
      }
    },
    end() { if (!inside && buf) emit(buf); buf = ""; }
  };
}

/** Free-form answer for "Run on local Ollama". Tokens go to onToken as they arrive. */
async function chat(msg, onToken, signal) {
  const cfg = await config();
  const kind = msg.kind === "image" ? "image" : "text";
  const pick = await resolve(cfg, kind);
  const x = pick.x;
  const body = {
    model: x.name, prompt: String(msg.prompt || ""), keep_alive: "30m",
    options: { temperature: 0.3, num_ctx: Math.max(2048, Math.min(Number(msg.numCtx) || 8192, 16384)) }
  };
  if (kind === "image" && msg.imageBase64) body.images = [msg.imageBase64];
  if (x.meta.isThinking) body.think = /gpt-oss/i.test(x.name) ? "low" : false;
  const filter = thinkFilter(onToken);
  const run = () => stream(cfg, body, { idleMs: warm.has(x.name) ? 120000 : 180000, signal, onChunk: o => { if (o.response) filter.push(o.response); } });
  try { await run(); }
  catch (e) {
    if (e.status === 400 && /think/i.test(e.detail || "") && body.think !== undefined) { delete body.think; await run(); }
    else throw e;
  }
  warm.add(x.name);
  filter.end();
}
