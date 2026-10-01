/* Void — on-page UI. Lives in a closed shadow root so site CSS can't break it.
   Everything is built with DOM APIs (no innerHTML), so file names can't inject markup. */
(() => {
  "use strict";
  const K = (self.VoidKit = self.VoidKit || {});

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .wrap{position:fixed;inset:0;pointer-events:none;z-index:2147483647;
      font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      --bg:#09090b;--panel:#141417;--line:#27272a;--fg:#ffffff;--mute:#a1a1aa;--acc:#ffffff;--accfg:#000000;--warn:#d4d4d8;--shadow:rgba(0,0,0,.75)}
    @media (prefers-color-scheme:light){.wrap{--bg:#ffffff;--panel:#f4f4f5;--line:#e4e4e7;--fg:#09090b;--mute:#71717a;--acc:#000000;--accfg:#ffffff;--warn:#52525b;--shadow:rgba(0,0,0,.25)}}
    .toast,.pill{position:fixed;top:16px;right:16px;pointer-events:auto;max-width:min(400px,calc(100vw - 32px));
      display:flex;gap:11px;align-items:flex-start;padding:12px 14px;border:1px solid var(--line);border-radius:14px;
      background:var(--bg);color:var(--fg);box-shadow:0 18px 60px var(--shadow);animation:in .18s ease-out}
    .pill{top:auto;bottom:20px;align-items:center;padding:9px 14px;border-radius:99px}
    .mark{flex:0 0 30px;height:30px;border-radius:9px;display:grid;place-items:center;font-weight:800;color:#000000;
      background:#ffffff;box-shadow:0 0 14px rgba(255,255,255,.25)}
    .toast.warn .mark{background:#e4e4e7;color:#000000}
    .title{font-weight:650}
    .text{color:var(--mute);font-size:12px;margin-top:2px;overflow-wrap:anywhere}
    .x{margin-left:auto;border:0;background:none;color:var(--mute);font-size:18px;line-height:1;cursor:pointer;padding:0 2px}
    .spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--acc);animation:sp .8s linear infinite}
    .veil{position:fixed;inset:0;pointer-events:auto;display:grid;place-items:center;padding:16px;background:rgba(6,4,12,.66)}
    .card{width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:22px;border:1px solid var(--line);border-radius:18px;
      background:var(--bg);color:var(--fg);box-shadow:0 30px 100px var(--shadow)}
    h2{margin:0 0 4px;font-size:17px;font-weight:650}
    .sub{margin:0 0 14px;color:var(--mute);font-size:12px}
    .file{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel);margin-bottom:8px}
    .file b{display:block;font-size:12px;overflow-wrap:anywhere}
    .file ul{margin:6px 0 0;padding-left:18px;color:var(--mute);font-size:12px}
    .note{margin:12px 0 0;color:var(--mute);font-size:11px}
    .row{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap}
    button.b{font:inherit;font-size:12px;border-radius:10px;padding:9px 14px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--fg)}
    button.b.main{background:var(--acc);border-color:var(--acc);color:var(--accfg)}
    button:focus-visible,textarea:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
    .card.wide{width:min(680px,100%)}
    textarea.q{display:block;width:100%;min-height:64px;resize:vertical;padding:9px 11px;font:inherit;font-size:13px;color:var(--fg);
      background:var(--panel);border:1px solid var(--line);border-radius:10px}
    .lbl{display:block;margin:12px 0 5px;font-size:12px;font-weight:650}
    pre.out{margin:12px 0 0;padding:10px 12px;min-height:56px;max-height:42vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;
      font:13px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:12px}
    .state{margin:8px 0 0;min-height:16px;color:var(--mute);font-size:11px}
    @keyframes in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
    @keyframes sp{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.toast,.pill{animation:none}.spin{animation-duration:2.4s}}
  `;

  let host = null, wrap = null;
  function ensure() {
    if (host && host.isConnected) return wrap;
    host = document.createElement("div");
    host.setAttribute("data-void", Math.random().toString(36).slice(2));
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style"); style.textContent = CSS;
    wrap = document.createElement("div"); wrap.className = "wrap";
    shadow.append(style, wrap);
    (document.documentElement || document).appendChild(host);
    return wrap;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---- toast ---------------------------------------------------------------
  let toastNode = null, toastTimer = 0;
  function toast(title, text, kind) {
    const w = ensure();
    toastNode?.remove(); clearTimeout(toastTimer);
    const t = el("div", "toast" + (kind === "warn" ? " warn" : ""));
    t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
    const body = el("div"); body.append(el("div", "title", title));
    if (text) body.append(el("div", "text", text));
    const x = el("button", "x", "×"); x.setAttribute("aria-label", "Dismiss");
    x.onclick = () => t.remove();
    t.append(el("div", "mark", "V"), body, x);
    w.appendChild(t); toastNode = t;
    toastTimer = setTimeout(() => t.remove(), 6500);
  }
  function hasToast() { return !!(toastNode && toastNode.isConnected); }

  // ---- scanning pill (ref-counted) ----------------------------------------
  let pill = null, pillUsers = 0;
  function scanning(on, text) {
    if (on) {
      pillUsers++;
      if (!pill || !pill.isConnected) {
        pill = el("div", "pill"); pill.setAttribute("role", "status");
        pill.append(el("div", "spin"), el("div", "title", text || "Checking file locally…"));
        ensure().appendChild(pill);
      }
    } else if (--pillUsers <= 0) { pillUsers = 0; pill?.remove(); pill = null; }
  }

  // ---- choice dialog -------------------------------------------------------
  /** plan: from VoidKit.flow.plan(); files: [{name, lines:string[]}]; note: optional small print.
      Resolves to the id of the button pressed ("block" | "allow" | "local" | "redact"). Esc means block. */
  function dialog(plan, files, note) {
    return new Promise(resolve => {
      const w = ensure();
      const veil = el("div", "veil");
      const card = el("div", "card");
      card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-labelledby", "vt"); card.setAttribute("aria-describedby", "vs");
      const h = el("h2", null, plan.title); h.id = "vt";
      const sub = el("p", "sub", plan.sub); sub.id = "vs";
      card.append(h, sub);
      for (const f of files.slice(0, 6)) {
        const box = el("div", "file"); box.append(el("b", null, f.name));
        if (f.lines.length) {
          const ul = el("ul");
          for (const line of f.lines.slice(0, 6)) ul.append(el("li", null, line));
          if (f.lines.length > 6) ul.append(el("li", null, `and ${f.lines.length - 6} more`));
          box.append(ul);
        }
        card.append(box);
      }
      if (files.length > 6) card.append(el("p", "note", `and ${files.length - 6} more files`));
      if (note) card.append(el("p", "note", note));
      card.append(el("p", "note", "Void checks files on your device. If you upload, the website receives the file."));

      const row = el("div", "row");
      const buttons = plan.buttons.map(b => {
        const btn = el("button", "b" + (b.main ? " main" : ""), b.label);
        btn.type = "button";
        btn.onclick = () => done(b.id);
        return btn;
      });
      row.append(...buttons);
      card.append(row); veil.append(card); w.appendChild(veil);

      const prevFocus = document.activeElement;
      const done = v => { veil.remove(); try { prevFocus?.focus?.(); } catch (_) {} resolve(v); };

      veil.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); done("block"); }
        else if (e.key === "Tab") {
          const i = buttons.indexOf(e.target);   // shadow retargeting keeps this reliable
          const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
          e.preventDefault(); buttons[next].focus();
        }
      }, true);
      veil.addEventListener("keyup", e => e.stopPropagation(), true);
      (buttons[plan.buttons.findIndex(b => b.main)] || buttons[0]).focus();
    });
  }

  // ---- local Ollama panel --------------------------------------------------
  /** o: { label, files:string[], notes:string[], prompt, defaultPrompt,
           start(question, onToken) -> { done:Promise, cancel() } }
      Non-blocking: returns immediately, the panel closes itself. */
  function localPanel(o) {
    const w = ensure();
    const veil = el("div", "veil");
    const card = el("div", "card wide");
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "lt");
    const h = el("h2", null, "Running on your computer"); h.id = "lt";
    card.append(h, el("p", "sub", `${o.label}. Nothing is uploaded to the website.`));
    const list = el("div", "file"); list.append(el("b", null, o.files.slice(0, 4).join(", ") + (o.files.length > 4 ? ` and ${o.files.length - 4} more` : "")));
    card.append(list);
    for (const n of o.notes || []) card.append(el("p", "note", n));

    const lab = el("label", "lbl", "Your message"); lab.htmlFor = "lq";
    const ta = el("textarea", "q"); ta.id = "lq"; ta.value = o.prompt || o.defaultPrompt;
    const state = el("p", "state"); state.setAttribute("role", "status");
    const out = el("pre", "out"); out.setAttribute("aria-live", "polite");
    const row = el("div", "row");
    const close = el("button", "b", "Close"), copy = el("button", "b", "Copy answer"), run = el("button", "b main", "Run");
    for (const b of [close, copy, run]) b.type = "button";
    row.append(close, copy, run);
    card.append(lab, ta, row, state, out); veil.append(card); w.appendChild(veil);

    let handle = null, text = "";
    const busy = on => { run.textContent = on ? "Stop" : (text ? "Run again" : "Run"); };
    function start() {
      if (handle) { handle.cancel(); handle = null; state.textContent = "Stopped."; busy(false); return; }
      text = ""; out.textContent = ""; state.textContent = "Waiting for the model…";
      const mine = handle = o.start(ta.value.trim() || o.defaultPrompt, t => {
        text += t; out.textContent = text; out.scrollTop = out.scrollHeight; state.textContent = "Answering…";
      });
      busy(true);
      mine.done.then(() => { if (handle === mine) { handle = null; state.textContent = "Done."; busy(false); } })
        .catch(e => { if (handle === mine) { handle = null; state.textContent = ""; out.textContent = (text ? text + "\n\n" : "") + "Error: " + (e.message || e); busy(false); } });
    }
    const prevFocus = document.activeElement;
    const shut = () => { handle?.cancel(); veil.remove(); try { prevFocus?.focus?.(); } catch (_) {} };
    close.onclick = shut; run.onclick = start;
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); state.textContent = "Copied."; } catch (_) { state.textContent = "Could not copy. Select the text and copy it."; }
    };

    const stops = [ta, close, copy, run];
    veil.addEventListener("keydown", e => {
      e.stopPropagation();                    // the site must not see typing inside Void's panel
      if (e.key === "Escape") { e.preventDefault(); shut(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target === ta) { e.preventDefault(); if (!handle) start(); }
      else if (e.key === "Tab") {
        const i = stops.indexOf(e.target);
        const next = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : (i + 1) % stops.length;
        e.preventDefault(); stops[next].focus();
      }
    }, true);
    for (const t of ["keyup", "keypress", "paste"]) veil.addEventListener(t, e => e.stopPropagation(), true);

    if ((o.prompt || "").trim()) { busy(false); start(); } else { busy(false); ta.focus(); ta.select(); }
  }

  K.ui = { toast, hasToast, scanning, dialog, localPanel };
})();
