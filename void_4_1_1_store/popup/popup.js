const $ = id => document.getElementById(id);
const K = self.VoidKit;
const DEFAULTS = { enabled: true, mode: "auto", engine: "auto", disabledSites: {} };
let settings = { ...DEFAULTS };
let siteAdapter = null;

function paint() {
  $("enabled").checked = settings.enabled;
  $("mode").value = settings.mode;
  $("state").textContent = settings.enabled ? "Protecting your prompts and uploads" : "Paused";
  $("dot").classList.toggle("on", settings.enabled);
  if (siteAdapter) $("site").checked = !settings.disabledSites[siteAdapter.name];
}

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  // Reading tab.url works only for hosts we already have access to, so this
  // needs no extra permission and stays empty on unrelated sites.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) siteAdapter = K.sites.forHost(new URL(tab.url).hostname);
  } catch (_) {}
  if (siteAdapter) {
    $("siteRow").hidden = false;
    $("siteName").textContent = `On ${siteAdapter.label}`;
  }
  paint();
  showStats();
  showEngine();
}

$("enabled").addEventListener("change", e => {
  settings.enabled = e.target.checked; chrome.storage.sync.set({ enabled: settings.enabled }); paint();
});
$("mode").addEventListener("change", e => chrome.storage.sync.set({ mode: e.target.value }));
$("site").addEventListener("change", e => {
  const disabledSites = { ...settings.disabledSites };
  if (e.target.checked) delete disabledSites[siteAdapter.name]; else disabledSites[siteAdapter.name] = true;
  settings.disabledSites = disabledSites;
  chrome.storage.sync.set({ disabledSites });
});
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("avatarLogo").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Avatar eye tracking
let currentX = 0, currentY = 0;
let targetX = 0, targetY = 0;
const eyes = document.querySelectorAll(".avatar .eye");

document.addEventListener("mousemove", e => {
  const avatarBtn = $("avatarLogo");
  if (!avatarBtn) return;
  const rect = avatarBtn.getBoundingClientRect();
  const avatarX = rect.left + rect.width / 2;
  const avatarY = rect.top + rect.height / 2;
  const dx = e.clientX - avatarX;
  const dy = e.clientY - avatarY;
  const angle = Math.atan2(dy, dx);
  const dist = Math.min(Math.hypot(dx, dy) / 10, 4);
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
async function showStats() {
  const { stats } = await chrome.storage.local.get({ stats: null });
  if (!stats) { $("stats").textContent = "Nothing checked yet"; return; }
  const r = stats.redactions, f = stats.scanned;
  $("stats").textContent = `${r} redaction${r === 1 ? "" : "s"} · ${f} file${f === 1 ? "" : "s"} checked`;
}

function pingOllama() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "void-ping" }, r => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
    });
  });
}

async function showEngine() {
  const box = document.querySelector(".engine");
  const set = (cls, title, text) => { box.className = "engine motion-item " + cls; $("engineTitle").textContent = title; $("engineText").textContent = text; };
  const choice = settings.engine;

  if (choice === "rules") return set("limited", "Pattern scan only", "You chose to skip AI checks. Pattern matching still runs on everything.");

  if (choice === "auto" || choice === "ollama") {
    const r = await pingOllama();
    if (r?.ok && r.hasText) {
      if (r.modelDetails && r.modelDetails[r.textModel]?.isEmbedding) {
        return set("limited", "Incompatible Ollama model", `"${r.textModel}" is an embedding model and cannot check prompts. Open Settings to select a text model.`);
      }
      const how = r.autoText ? `${r.autoNote}, so Void picked "${r.textModel}" automatically. ` : "";
      return set("good", `Ollama · ${r.textModel}`, how + (r.hasVision ? "Documents and images are checked by AI on your computer." : "Documents are checked by AI on your computer. Images get their metadata removed."));
    }
    var ollamaProblem = r?.ok ? (r.problem || `Ollama is running but "${r.textModel}" is not installed.`) : (r?.error || "Ollama is not running.");
  }
  if (choice === "auto" || choice === "chrome") {
    try {
      if (typeof LanguageModel !== "undefined" && (await LanguageModel.availability()) === "available") {
        return set("good", "Chrome built-in AI", "Documents are checked by the AI built into this browser.");
      }
    } catch (_) {}
  }
  set("limited", "Pattern scan only", `${ollamaProblem || "No local AI found."} Void still catches IDs, cards, keys and passwords. Open Settings to add AI checks.`);
}

init();
