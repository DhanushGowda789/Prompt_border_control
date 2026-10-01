const $ = id => document.getElementById(id);
const K = self.VoidKit;
const SYNC_DEFAULTS = {
  uploadGate: true, stripImageMetadata: true, strictMode: false, alwaysAsk: false, engine: "auto", categories: {}
};
const AI_DEFAULTS = { ollamaUrl: "http://127.0.0.1:11434", textModel: "llama3.2:3b", visionModel: "", autoModel: true };
const VISION_HINT = /vision|llava|moondream|minicpm-v|bakllava|gemma3|qwen2\.5vl|qwen2-vl|granite3\.2-vision/i;

let savedTimer = 0;
function flashSaved() {
  $("saved").classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("show"), 1000);
}

function switchRow(id, name, desc, checked, onChange) {
  const row = document.createElement("div");
  row.className = "item";
  const text = document.createElement("div");
  const label = document.createElement("label"); label.className = "name"; label.htmlFor = id; label.textContent = name;
  const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = desc;
  text.append(label, hint);
  const sw = document.createElement("label"); sw.className = "switch";
  const input = document.createElement("input"); input.type = "checkbox"; input.id = id; input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  sw.append(input, document.createElement("span"));
  row.append(text, sw);
  return row;
}

async function init() {
  const s = { ...SYNC_DEFAULTS, ...(await chrome.storage.sync.get(SYNC_DEFAULTS)) };

  const box = $("categories");
  for (const [id, title, desc] of K.detect.CATEGORIES) {
    box.append(switchRow("cat-" + id, title, desc, s.categories[id] !== false, async on => {
      const { categories } = await chrome.storage.sync.get({ categories: {} });
      categories[id] = on;
      await chrome.storage.sync.set({ categories });
      flashSaved();
    }));
  }

  for (const key of ["uploadGate", "stripImageMetadata", "strictMode", "alwaysAsk"]) {
    $(key).checked = !!s[key];
    $(key).addEventListener("change", async e => { await chrome.storage.sync.set({ [key]: e.target.checked }); flashSaved(); });
  }

  $("engine").value = s.engine;
  $("engine").addEventListener("change", async e => {
    await chrome.storage.sync.set({ engine: e.target.value });
    syncEngineUi(); flashSaved();
  });
  syncEngineUi();

  const { ai } = await chrome.storage.local.get({ ai: AI_DEFAULTS });
  const cfg = { ...AI_DEFAULTS, ...ai };
  $("ollamaUrl").value = cfg.ollamaUrl;
  fillModels([], cfg);
  refreshModels(cfg);
  $("ollamaUrl").addEventListener("input", checkRemote);
  checkRemote();

  $("autoModel").checked = cfg.autoModel !== false;
  $("autoModel").addEventListener("change", async e => {
    const { ai } = await chrome.storage.local.get({ ai: AI_DEFAULTS });
    await chrome.storage.local.set({ ai: { ...AI_DEFAULTS, ...ai, autoModel: e.target.checked } });
    flashSaved();
  });
  $("scanModels").addEventListener("click", scanAllModels);
  $("test").addEventListener("click", saveAndTest);
  $("checkCompat").addEventListener("click", checkCompatibilityAction);
  $("textModel").addEventListener("change", updateModelBadges);
  $("visionModel").addEventListener("change", updateModelBadges);
  $("resetStats").addEventListener("click", async () => { await chrome.storage.local.remove("stats"); showStats(); flashSaved(); });
  showStats();
}

function syncEngineUi() {
  const v = $("engine").value;
  $("ollamaBox").hidden = v === "chrome" || v === "rules";
}

function loopback(host) { return ["127.0.0.1", "localhost", "[::1]"].includes(host); }

function checkRemote() {
  try { $("remoteWarn").hidden = loopback(new URL($("ollamaUrl").value).hostname); }
  catch (_) { $("remoteWarn").hidden = true; }
}

function ping() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "void-ping" }, r => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
    });
  });
}

function checkModel(model, kind) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "void-check-model", model, kind, probe: true }, r => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
    });
  });
}

let latestModelDetails = {};

function fillModels(installed, cfg, details = {}) {
  latestModelDetails = details || {};

  const buildOption = (name, preferVision = false) => {
    const meta = latestModelDetails[name] || {};
    const tags = [];
    if (meta.parameterSize) tags.push(meta.parameterSize);
    if (meta.isThinking) tags.push("Reasoning");
    if (meta.hasVision && !preferVision) tags.push("Vision");
    if (meta.isEmbedding) tags.push("Incompatible: Embedding");

    const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
    const missing = installed.length && !installed.includes(name);
    const opt = new Option(missing ? `${name} (not installed)` : `${name}${tagStr}`, name);
    if (meta.isEmbedding && !preferVision) {
      opt.dataset.incompatible = "true";
    }
    return opt;
  };

  const fillText = (sel, current) => {
    sel.textContent = "";
    const list = [...installed];
    if (current && !list.includes(current)) list.unshift(current);

    const standard = [];
    const embedding = [];

    for (const name of list) {
      const meta = latestModelDetails[name] || {};
      if (meta.isEmbedding) embedding.push(name);
      else standard.push(name);
    }

    if (standard.length && embedding.length) {
      const grp1 = document.createElement("optgroup");
      grp1.label = "Generative Text Models (Compatible)";
      standard.forEach(n => grp1.append(buildOption(n, false)));
      sel.append(grp1);

      const grp2 = document.createElement("optgroup");
      grp2.label = "Embedding Models (Incompatible)";
      embedding.forEach(n => grp2.append(buildOption(n, false)));
      sel.append(grp2);
    } else {
      list.forEach(n => sel.append(buildOption(n, false)));
    }
    sel.value = current;
  };

  const fillVision = (sel, current) => {
    sel.textContent = "";
    sel.append(new Option("None (metadata strip only)", ""));
    const list = [...installed];
    if (current && !list.includes(current)) list.unshift(current);

    const vision = [];
    const other = [];

    for (const name of list) {
      const meta = latestModelDetails[name] || {};
      if (meta.hasVision || VISION_HINT.test(name)) vision.push(name);
      else if (!meta.isEmbedding) other.push(name);
    }

    if (vision.length) {
      const grp1 = document.createElement("optgroup");
      grp1.label = "Vision / Multimodal Models (Recommended)";
      vision.forEach(n => grp1.append(buildOption(n, true)));
      sel.append(grp1);
    }
    if (other.length) {
      const grp2 = document.createElement("optgroup");
      grp2.label = "Other Installed Models";
      other.forEach(n => grp2.append(buildOption(n, true)));
      sel.append(grp2);
    }
    sel.value = current;
  };

  fillText($("textModel"), cfg.textModel);
  fillVision($("visionModel"), cfg.visionModel);
  updateModelBadges();
}

function updateModelBadges() {
  const textName = $("textModel").value;
  const visionName = $("visionModel").value;

  const tBadge = $("textModelBadge");
  const tStatus = $("textModelStatus");
  const vBadge = $("visionModelBadge");
  const vStatus = $("visionModelStatus");

  // Update text model indicator
  if (textName && latestModelDetails[textName]) {
    const meta = latestModelDetails[textName];
    tBadge.className = "badge show";
    tBadge.textContent = meta.parameterSize || meta.family || "AI Model";

    tStatus.className = "compat-indicator show";
    if (meta.isEmbedding) {
      tStatus.className = "compat-indicator show bad";
      tStatus.textContent = "Incompatible: Embedding models cannot generate text or check prompts.";
    } else if (meta.isThinking) {
      tStatus.className = "compat-indicator show warn";
      tStatus.textContent = "Reasoning model: thinking tokens will be automatically filtered.";
    } else {
      tStatus.className = "compat-indicator show ok";
      tStatus.textContent = "Compatible for prompt and document privacy scanning.";
    }
  } else {
    tBadge.className = "badge";
    tStatus.className = "compat-indicator";
  }

  // Update vision model indicator
  if (visionName) {
    const meta = latestModelDetails[visionName] || {};
    vBadge.className = "badge show";
    vBadge.textContent = meta.parameterSize || (meta.hasVision ? "Vision" : "Image Model");

    vStatus.className = "compat-indicator show";
    if (meta.isEmbedding) {
      vStatus.className = "compat-indicator show bad";
      vStatus.textContent = "Incompatible: Embedding models do not support image inspection.";
    } else if (meta.hasVision || VISION_HINT.test(visionName)) {
      vStatus.className = "compat-indicator show ok";
      vStatus.textContent = "Vision model ready for photo and document image inspection.";
    } else {
      vStatus.className = "compat-indicator show warn";
      vStatus.textContent = "Notice: Model may be text-only. Run 'Check Model Compatibility' to verify.";
    }
  } else {
    vBadge.className = "badge";
    vStatus.className = "compat-indicator";
  }
}

async function refreshModels(cfg) {
  const r = await ping();
  if (r?.ok) fillModels(r.models, cfg, r.modelDetails);
}

function mk(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function compatTile(kind, item) {
  const isOk = item.compatible, isWarn = item.status === "warning";
  const tile = mk("div", "compat-stat " + (isOk ? (isWarn ? "warn" : "ok") : "bad"));
  tile.append(mk("span", "lbl", kind), mk("div", "val", isOk ? (isWarn ? "Compatible (with a note)" : "Fully compatible") : "Incompatible"));
  const name = mk("div", "hint"); name.style.marginTop = "4px"; name.append(mk("b", null, item.model || ""));
  const msg = mk("div", "muted", item.message || item.reason || item.error || (isOk ? "Ready for use" : "Not supported")); msg.style.marginTop = "2px";
  tile.append(name, msg);
  return tile;
}

async function checkCompatibilityAction() {
  const reportBox = $("compatReport");
  const textModel = $("textModel").value, visionModel = $("visionModel").value;
  reportBox.hidden = false; reportBox.textContent = "";
  if (!textModel) { reportBox.append(mk("p", "bad", "Please select a text model first.")); return; }
  reportBox.append(mk("p", "loading", "Running compatibility checks on the selected models…"));
  const grid = mk("div", "compat-grid");
  grid.append(compatTile("Text model", { model: textModel, ...(await checkModel(textModel, "text")) }));
  if (visionModel) grid.append(compatTile("Vision model", { model: visionModel, ...(await checkModel(visionModel, "vision")) }));
  reportBox.textContent = "";
  reportBox.append(mk("h3", null, "Model compatibility report"), grid);
  updateModelBadges();
}

/** Tests every installed model, one after another, and lets the user pick a working one. */
async function scanAllModels() {
  const box = $("compatReport"), btn = $("scanModels");
  box.hidden = false; box.textContent = "";
  const names = Object.keys(latestModelDetails);
  if (!names.length) { box.append(mk("p", "bad", "No installed models found. Start Ollama and press \"Save and test connection\" first.")); return; }
  btn.disabled = true;
  const status = mk("p", "loading", "Testing installed models. The first test of a large model can take a minute…");
  const grid = mk("div", "compat-grid");
  box.append(mk("h3", null, "Installed models"), status, grid);
  let working = 0;
  for (const name of names) {
    status.textContent = `Testing ${name}…`;
    const meta = latestModelDetails[name] || {};
    const res = meta.isEmbedding
      ? { compatible: false, reason: "Embedding-only model. It cannot generate text, so Void can't use it." }
      : await checkModel(name, "text");
    const tile = compatTile(meta.parameterSize ? `${meta.parameterSize}${meta.hasVision ? " · vision" : ""}` : (meta.hasVision ? "vision" : "model"), { model: name, ...res });
    if (res.compatible) {
      working++;
      const use = mk("button", null, "Use as text model"); use.type = "button"; use.style.marginTop = "8px";
      use.onclick = async () => { $("textModel").value = name; updateModelBadges(); await saveAndTest(); };
      tile.append(use);
    }
    grid.append(tile);
  }
  status.textContent = working ? `${working} of ${names.length} installed model${names.length === 1 ? "" : "s"} can run Void's checks.` : "None of the installed models can run Void's checks. Install one with: ollama pull llama3.2:3b";
  status.className = working ? "muted" : "bad";
  btn.disabled = false;
}

async function saveAndTest() {
  const out = $("testResult");
  out.className = ""; out.textContent = "Testing connection and models…";
  let url;
  try {
    url = new URL($("ollamaUrl").value.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch (_) { out.className = "bad"; out.textContent = "Enter an address that starts with http:// or https://"; return; }

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    const origins = [`${url.protocol}//${url.hostname}/*`];
    const granted = await chrome.permissions.request({ origins });
    if (!granted) { out.className = "bad"; out.textContent = "Permission to reach that address was not granted."; return; }
  }
  const cfg = { ollamaUrl: url.origin, textModel: $("textModel").value || AI_DEFAULTS.textModel, visionModel: $("visionModel").value, autoModel: $("autoModel").checked };
  await chrome.storage.local.set({ ai: cfg });
  $("ollamaUrl").value = cfg.ollamaUrl;

  const r = await ping();
  if (!r?.ok) { out.className = "bad"; out.textContent = r?.error || "Could not reach Ollama."; return; }
  fillModels(r.models, cfg, r.modelDetails);
  if (!r.models.length) { out.className = "bad"; out.textContent = "Connected, but no models are installed yet. Run: ollama pull llama3.2:3b"; return; }
  if (!r.hasText) { out.className = "bad"; out.textContent = r.problem || `Connected, but "${cfg.textModel}" cannot be used. Pick one from the list.`; return; }

  const usable = r.textModel;                           // the chosen model, or the one Void will switch to
  const probe = await checkModel(usable, "text");
  if (!probe.compatible) {
    out.className = "bad";
    out.textContent = `Connected, but "${usable}" failed the compatibility test: ${probe.reason || "not compatible"}. ${cfg.autoModel ? "Void will try your other installed models when it needs one." : "Turn on \"Use another installed model\" or pick a different model."}`;
    return;
  }
  out.className = probe.status === "warning" ? "warn" : "ok";
  out.textContent = r.autoText
    ? `Connected. ${r.autoNote}, so Void will use "${usable}" (verified).`
    : probe.status === "warning" ? `Connected. "${usable}" works with a note: ${probe.message}` : `Connected. "${usable}" verified and fully compatible.`;
  flashSaved();
}

async function showStats() {
  const { stats } = await chrome.storage.local.get({ stats: null });
  const el = $("activity");
  if (!stats) { el.textContent = "Nothing checked yet."; return; }
  const parts = Object.entries(stats.byCat || {}).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, n]) => `${(K.detect.CATEGORIES.find(c => c[0] === k) || [k, k])[1].toLowerCase()} ${n}`);
  el.textContent = `${stats.redactions} redaction${stats.redactions === 1 ? "" : "s"}, ${stats.scanned} file${stats.scanned === 1 ? "" : "s"} checked, ${stats.blocked} blocked, ${stats.local || 0} run locally.` +
    (parts.length ? ` Most common: ${parts.join(", ")}.` : "");
}

init();

// Avatar eye tracking
(function() {
  let currentX = 0, currentY = 0;
  let targetX = 0, targetY = 0;
  const eyes = document.querySelectorAll(".avatar .eye");
  const avatarBtn = document.getElementById("avatarLogo");

  document.addEventListener("mousemove", e => {
    if (!avatarBtn) return;
    const rect = avatarBtn.getBoundingClientRect();
    const avatarX = rect.left + rect.width / 2;
    const avatarY = rect.top + rect.height / 2;
    const dx = e.clientX - avatarX;
    const dy = e.clientY - avatarY;
    const angle = Math.atan2(dy, dx);
    const dist = Math.min(Math.hypot(dx, dy) / 15, 5); // max shift 5px
    targetX = Math.cos(angle) * dist;
    targetY = Math.sin(angle) * dist;
  });

  function animateEyes() {
    currentX += (targetX - currentX) * 0.15;
    currentY += (targetY - currentY) * 0.15;
    eyes.forEach(eye => {
      eye.style.transform = `translate(${currentX}px, ${currentY}px)`;
    });
    requestAnimationFrame(animateEyes);
  }
  animateEyes();
})();
