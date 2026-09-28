let interceptCount = 0;

async function checkProxy() {
  try {
    const r = await fetch('http://localhost:3333/sovereign/health');
    const d = await r.json();
    chrome.action.setTitle({ title: `Sovereign Shield — Active\nModel: ${d.model || (d.ollama_up ? 'none installed' : 'Ollama offline')}\nIntercepted: ${interceptCount}` });
    chrome.action.setBadgeBackgroundColor({ color: '#00cc66' });
  } catch {
    chrome.action.setTitle({ title: 'Sovereign Shield — Proxy offline\nRun: node proxy/index.js' });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ff4466' });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'INTERCEPTED') {
    interceptCount++;
    chrome.action.setBadgeText({ text: String(interceptCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ff4466' });
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: '🛡️ Sovereign Shield',
      message: `Sensitive query intercepted — answered by ${msg.model || 'local model'}`,
    });
  }
});

checkProxy();
setInterval(checkProxy, 6000);
