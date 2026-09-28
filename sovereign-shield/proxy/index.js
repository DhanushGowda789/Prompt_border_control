/**
 * Sovereign Shield — Local Proxy
 * HTTP on port 3333 (proxy) + port 3334 (dashboard)
 *
 * Run: node index.js
 */

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { classifyText, extractText } from './classifier.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROXY_PORT = 3333;
const DASH_PORT  = 3334;

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// Optional pin. If unset, the model is auto-detected from Ollama on every request
// (running model first, then most recently modified installed model).
const PINNED_MODEL = process.env.OLLAMA_MODEL || null;

// ── Live model detection ──────────────────────────────────────────────────
let lastSeenRunning = null;           // sticky: Ollama unloads idle models after ~5 min
let modelCache = { at: 0, value: null };
const CACHE_MS = 2000;

async function ollamaGet(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(`${OLLAMA_URL}${path}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Returns { model, source, running[], installed[], ollama_up }
 * source: 'pinned' | 'running' | 'last-used' | 'installed' | 'none'
 */
async function getModelInfo(force = false) {
  if (!force && Date.now() - modelCache.at < CACHE_MS) return modelCache.value;

  let running = [], installed = [], up = true;
  try {
    const ps = await ollamaGet('/api/ps');
    running = (ps.models || []).map(m => m.name || m.model);
  } catch { up = false; }
  if (up) {
    try {
      const tags = await ollamaGet('/api/tags');
      installed = (tags.models || [])
        .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at))
        .map(m => m.name || m.model);
    } catch { /* ps worked, tags failed: carry on */ }
  }

  if (running.length) lastSeenRunning = running[0];

  let model = null, source = 'none';
  if (PINNED_MODEL)                                                   { model = PINNED_MODEL;    source = 'pinned'; }
  else if (running.length)                                            { model = running[0];      source = 'running'; }
  else if (lastSeenRunning && installed.includes(lastSeenRunning))    { model = lastSeenRunning; source = 'last-used'; }
  else if (installed.length)                                          { model = installed[0];    source = 'installed'; }

  const value = { model, source, running, installed, ollama_up: up };
  modelCache = { at: Date.now(), value };
  return value;
}

// ── Allowed upstream targets ──────────────────────────────────────────────
const TARGETS = {
  'api.openai.com':                      'https://api.openai.com',
  'api.anthropic.com':                   'https://api.anthropic.com',
  'generativelanguage.googleapis.com':   'https://generativelanguage.googleapis.com',
};

// ── In-memory event log ───────────────────────────────────────────────────
const events = [];
const sseClients = new Set();

function emit(event) {
  const entry = { ...event, id: `${Date.now()}-${Math.random()}`, ts: new Date().toISOString() };
  events.unshift(entry);
  if (events.length > 200) events.pop();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
  const tag = entry.intercepted ? '🛡️  INTERCEPTED' : '✅ PASSED    ';
  console.log(`[${tag}] score=${entry.result?.score ?? 0} → ${entry.route}`);
  console.log(`         "${entry.preview}"`);
}

// ── Proxy app ─────────────────────────────────────────────────────────────
const proxy = express();
proxy.use(cors({ origin: '*' }));
proxy.use(express.json({ limit: '10mb' }));

// Health check
proxy.get('/sovereign/health', async (_req, res) => {
  const info = await getModelInfo();
  res.json({
    status: 'ok',
    model: info.model,          // the model that will actually answer
    source: info.source,        // how it was chosen
    running: info.running,      // currently loaded in Ollama
    installed: info.installed,
    ollama_up: info.ollama_up,
    ollama: OLLAMA_URL,
  });
});

// Event log (for dashboard initial load)
proxy.get('/sovereign/events', (_req, res) => res.json(events));

// SSE live stream
proxy.get('/sovereign/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Main intercept route ──────────────────────────────────────────────────
// Pattern: POST /proxy/<host>/<path>
proxy.post('/proxy/*', async (req, res) => {
  const targetPath = req.params[0]; // e.g. "api.openai.com/v1/chat/completions"
  const body = req.body;
  const text = extractText(body);
  const result = classifyText(text);
  const preview = text.slice(0, 80).replace(/\n/g, ' ') + (text.length > 80 ? '…' : '');

  if (result.sensitive) {
    const info = await getModelInfo(true);   // fresh lookup, never stale on the request path
    const shownModel = info.model || 'no model found';
    emit({ intercepted: true, route: `LOCAL → Ollama (${shownModel})`, preview, result, target: targetPath, model: info.model });
    try {
      if (!info.ollama_up) throw new Error('cannot reach Ollama at ' + OLLAMA_URL);
      if (!info.model)     throw new Error('no models installed. Run: ollama pull <model>');
      const resp = await callOllama(body, text, info.model);
      return res.json(resp);
    } catch (err) {
      return res.status(502).json({
        error: {
          message: `Sovereign proxy: Ollama unavailable — ${err.message}. Run: ollama serve`,
          type: 'sovereign_proxy_error',
        },
        _sovereign: { intercepted: true, error: true },
      });
    }
  }

  // Pass through
  const [host, ...rest] = targetPath.split('/');
  const base = TARGETS[host];
  if (!base) return res.status(400).json({ error: `Unknown target host: ${host}` });

  emit({ intercepted: false, route: `PASS → ${host}`, preview, result, target: targetPath });

  try {
    const url = `${base}/${rest.join('/')}`;
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!['host', 'content-length', 'connection'].includes(k)) fwdHeaders[k] = v;
    }
    fwdHeaders['content-type'] = 'application/json';

    const upstream = await fetch(url, { method: 'POST', headers: fwdHeaders, body: JSON.stringify(body) });
    const upText = await upstream.text();

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) res.setHeader(k, v);
    });
    res.send(upText);
  } catch (err) {
    res.status(502).json({ error: `Upstream error: ${err.message}` });
  }
});

// ── Ollama caller ─────────────────────────────────────────────────────────
async function callOllama(originalBody, rawText, model) {
  const messages = originalBody.messages || [{ role: 'user', content: rawText }];
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: originalBody.temperature ?? 0.7, num_predict: originalBody.max_tokens ?? 1024 },
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const used = d.model || model;   // Ollama's own report of what answered
  return {
    id: `chatcmpl-sovereign-${Date.now()}`,
    object: 'chat.completion',
    model: `ollama/${used}`,
    sovereign: true,
    choices: [{ index: 0, message: { role: 'assistant', content: d.message?.content || '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: d.prompt_eval_count || 0, completion_tokens: d.eval_count || 0, total_tokens: (d.prompt_eval_count || 0) + (d.eval_count || 0) },
    _sovereign: { intercepted: true, local_model: used, note: 'Answered locally. Your data never left this device.' },
  };
}

// ── Dashboard app ─────────────────────────────────────────────────────────
const dash = express();
dash.use(cors({ origin: '*' }));
dash.get('/', (_req, res) => res.sendFile(join(__dir, 'dashboard.html')));
dash.get('/dashboard.js', (_req, res) => res.sendFile(join(__dir, 'dashboard.js')));

// ── Start both servers ────────────────────────────────────────────────────
proxy.listen(PROXY_PORT, async () => {
  const info = await getModelInfo(true);
  const modelLabel = info.model ? `${info.model} (${info.source})` : (info.ollama_up ? 'none installed' : 'Ollama offline');
  console.log(`
╔═══════════════════════════════════════════════════╗
║        🛡️  Sovereign Shield Proxy — v1.0         ║
╠═══════════════════════════════════════════════════╣
║  Proxy endpoint : http://localhost:${PROXY_PORT}           ║
║  Dashboard      : http://localhost:${DASH_PORT}           ║
║  Ollama         : ${OLLAMA_URL}      ║
║  Local model    : ${modelLabel.slice(0, 30).padEnd(30)}║
╠═══════════════════════════════════════════════════╣
║  score ≥ 6  →  LOCAL (Ollama)                    ║
║  score < 6  →  CLOUD (pass-through)              ║
╚═══════════════════════════════════════════════════╝
`);
});

dash.listen(DASH_PORT, () =>
  console.log(`📊  Dashboard live at http://localhost:${DASH_PORT}`));
