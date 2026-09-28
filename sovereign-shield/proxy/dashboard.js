const PRESETS = {
  safe: 'Explain the difference between TCP and UDP protocols.',
  pii: 'My SSN is 123-45-6789 and date of birth is March 4 1990, help me fill this form.',
  health: 'I was recently diagnosed with HIV and my doctor prescribed antiretrovirals.',
  gov: 'Review these classified defense contract terms for RFP-2024-0891 statement of work.',
  fin: 'My bank account number is 987654321 and routing number 021000021, set up a wire transfer.',
};

let events = [];
let selId = null;
let src = null;

function connect() {
  if (src) src.close();
  src = new EventSource('http://localhost:3333/sovereign/stream');
  src.onopen = () => {
    document.getElementById('dot').className = 'dot on';
    document.getElementById('status').textContent = 'Proxy connected';
  };
  src.onmessage = e => addEvent(JSON.parse(e.data));
  src.onerror = () => {
    document.getElementById('dot').className = 'dot';
    document.getElementById('status').textContent = 'Proxy offline - run: node index.js';
  };
}

function modelLabel(h) {
  if (!h.ollama_up) return 'Ollama offline';
  if (!h.model) return 'none installed';
  const tag = h.source === 'pinned' ? ' (pinned)' : (h.source === 'running' ? '' : ' (idle)');
  return h.model + tag;
}

async function refreshModel() {
  try {
    const h = await fetch('http://localhost:3333/sovereign/health').then(r => r.json());
    document.getElementById('sm').textContent = modelLabel(h);
  } catch {
    document.getElementById('sm').textContent = 'Proxy offline';
  }
}

async function loadInitial() {
  try {
    await refreshModel();
    const evs = await fetch('http://localhost:3333/sovereign/events').then(r => r.json());
    for (const e of [...evs].reverse()) addEvent(e, false);
  } catch {}
}

function addEvent(ev, prepend = true) {
  if (events.find(e => e.id === ev.id)) return;
  if (prepend) events.unshift(ev); else events.push(ev);
  updateStats();
  renderFeed();
  if (selId === ev.id) renderDetail(ev);
}

function updateStats() {
  const ic = events.filter(e => e.intercepted).length;
  const pc = events.filter(e => !e.intercepted).length;
  document.getElementById('si').textContent = ic;
  document.getElementById('sp').textContent = pc;
  document.getElementById('sr').textContent = (ic + pc) ? Math.round(ic / (ic + pc) * 100) + '%' : '-';
}

function renderFeed() {
  const feed = document.getElementById('feed');
  document.getElementById('empty')?.remove();
  feed.innerHTML = '';
  for (const ev of events) {
    const item = document.createElement('div');
    item.className = `ev ${ev.intercepted ? 'int' : 'pas'}${selId === ev.id ? ' sel' : ''}`;
    const time = new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tags = (ev.result?.triggers || []).map(tr =>
      `<span class="tag" style="color:${tr.color}">${tr.icon} ${tr.label}</span>`).join('');
    item.innerHTML = `
      <div class="r1">
        <span class="bdg ${ev.intercepted ? 'i' : 'p'}">${ev.intercepted ? 'BLOCKED' : 'PASS'}</span>
        <span class="route">${esc(ev.route)}</span>
        <span class="ts">${time}</span>
      </div>
      <div class="preview">${esc(ev.preview || '')}</div>
      <div class="tags">${tags || '<span class="tag" style="color:var(--muted)">no sensitive patterns</span>'}</div>`;
    item.addEventListener('click', () => {
      selId = ev.id;
      renderFeed();
      renderDetail(ev);
    });
    feed.appendChild(item);
  }
}

function renderDetail(ev) {
  const score = ev.result?.score ?? 0;
  const triggerHtml = (ev.result?.triggers || []).map(tr => `
    <div class="tri">
      <span class="trico">${tr.icon}</span>
      <div style="flex:1">
        <div class="trin" style="color:${tr.color}">${tr.label}</div>
        <div class="trim">${(tr.matched || []).join(', ')}</div>
        <div class="sbar"><div class="sfill" style="width:${Math.min(tr.score / 30 * 100, 100)}%;background:${tr.color}"></div></div>
      </div>
      <div class="trisc" style="color:${tr.color}">${tr.score}</div>
    </div>`).join('') || '<div class="dv" style="color:var(--muted)">No sensitive patterns detected</div>';

  document.getElementById('det').innerHTML = `
    <div class="dsec"><div class="dl">Decision</div>
      <div class="dv" style="color:${ev.intercepted ? 'var(--red)' : 'var(--green)'};font-weight:700;font-size:13px">
        ${ev.intercepted ? 'INTERCEPTED - Answered by local Ollama model' : 'PASSED - Forwarded to cloud API'}
      </div>
    </div>
    <div class="dsec"><div class="dl">Sensitivity score</div><div class="dv">
      <span style="font-size:22px;font-weight:700;color:${score >= 6 ? 'var(--red)' : 'var(--green)'}">${score}</span>
      <span style="color:var(--muted)"> / threshold: ${ev.result?.threshold ?? 6}</span>
      <div class="sbar" style="margin-top:8px;height:5px"><div class="sfill" style="width:${Math.min(score / 40 * 100, 100)}%;background:${score >= 6 ? 'var(--red)' : 'var(--green)'}"></div></div>
    </div></div>
    <div class="dsec"><div class="dl">Triggers found</div>${triggerHtml}</div>
    <div class="dsec"><div class="dl">Query preview</div><div class="dv">${esc(ev.preview || '(empty)')}</div></div>
    <div class="dsec"><div class="dl">Routed to</div><div class="dv">${esc(ev.route)}</div></div>
    <div class="dsec"><div class="dl">Timestamp</div><div class="dv">${new Date(ev.ts).toLocaleString()}</div></div>`;
}

async function testClassify() {
  const text = document.getElementById('ti').value.trim();
  if (!text) return;
  const resultBox = document.getElementById('rb');
  resultBox.className = 'show';
  resultBox.textContent = 'Classifying...';
  try {
    const response = await fetch('http://localhost:3333/proxy/api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    });
    const data = await response.json();
    if (data._sovereign?.intercepted && !data._sovereign?.error) {
      resultBox.innerHTML = `<span style="color:var(--red)">INTERCEPTED</span> - Sensitive query answered locally by Ollama.<br><span style="color:var(--muted)">Response: ${esc((data.choices?.[0]?.message?.content || '').slice(0, 150))}...</span>`;
    } else if (data._sovereign?.error || data.error?.type === 'sovereign_proxy_error') {
      resultBox.innerHTML = '<span style="color:var(--red)">INTERCEPTED</span> - Sensitive! Ollama is not running (start it with ollama serve).';
    } else {
      resultBox.innerHTML = '<span style="color:var(--green)">PASSED</span> - No sensitive content. Would forward to cloud API with original auth headers.';
    }
  } catch {
    resultBox.innerHTML = '<span style="color:var(--red)">Proxy offline</span> - Start it with cd proxy && node index.js';
  }
}

function preset(key) {
  document.getElementById('ti').value = PRESETS[key];
  document.getElementById('rb').className = '';
}

function clearFeed() {
  events = [];
  selId = null;
  document.getElementById('si').textContent = 0;
  document.getElementById('sp').textContent = 0;
  document.getElementById('sr').textContent = '-';
  document.getElementById('feed').innerHTML = '<div class="empty" id="empty"><div class="big">🔍</div><div>Feed cleared</div></div>';
  document.getElementById('det').innerHTML = '<div class="dph"><span style="font-size:28px">👆</span><span>Click an event to inspect</span></div>';
}

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.getElementById('clear-feed').addEventListener('click', clearFeed);
document.getElementById('classify').addEventListener('click', testClassify);
document.querySelectorAll('[data-preset]').forEach(button => {
  button.addEventListener('click', () => preset(button.dataset.preset));
});
document.getElementById('ti').addEventListener('keydown', event => {
  if (event.key === 'Enter') testClassify();
});

setInterval(() => {
  if (src?.readyState === EventSource.CLOSED) connect();
}, 4000);
loadInitial();
connect();
setInterval(refreshModel, 3000);  // keep the model card live
