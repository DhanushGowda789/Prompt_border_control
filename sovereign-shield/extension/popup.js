function modelLabel(h) {
  if (!h.ollama_up) return 'Ollama offline';
  if (!h.model) return 'none installed';
  const tag = h.source === 'pinned' ? ' (pinned)' : (h.source === 'running' ? '' : ' (idle)');
  return h.model + tag;
}

async function refresh() {
  try {
    const h = await fetch('http://localhost:3333/sovereign/health').then(r => r.json());
    document.getElementById('dot').className = 'dot on';
    document.getElementById('st').textContent = 'Proxy active';
    document.getElementById('model').textContent = modelLabel(h);
  } catch {
    document.getElementById('dot').className = 'dot off';
    document.getElementById('st').textContent = 'Proxy offline - run: node index.js';
  }
  try {
    const evs = await fetch('http://localhost:3333/sovereign/events').then(r => r.json());
    document.getElementById('ic').textContent = evs.filter(e => e.intercepted).length;
    document.getElementById('pc').textContent = evs.filter(e => !e.intercepted).length;
  } catch {}
}

refresh();
setInterval(refresh, 3000);
