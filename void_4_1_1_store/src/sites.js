/* Void — per-site adapters. When a site changes its layout, fix it here only. */
(() => {
  "use strict";
  const root = typeof self !== "undefined" ? self : globalThis;
  const K = (root.VoidKit = root.VoidKit || {});

  const ADAPTERS = [
    {
      name: "chatgpt", label: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"],
      composer: ["#prompt-textarea", "div.ProseMirror[contenteditable='true']"],
      send: ["button[data-testid='send-button']", "button[aria-label*='Send' i]"]
    },
    {
      name: "gemini", label: "Gemini", hosts: ["gemini.google.com"],
      composer: ["rich-textarea .ql-editor", "div.ql-editor[contenteditable='true']"],
      send: ["button.send-button", "button[aria-label*='Send' i]"]
    },
    {
      name: "claude", label: "Claude", hosts: ["claude.ai"],
      composer: ["div.ProseMirror[contenteditable='true']", "div[contenteditable='true'][role='textbox']"],
      send: ["button[aria-label*='Send' i]"]
    }
  ];

  function forHost(host) {
    return ADAPTERS.find(a => a.hosts.includes(host)) || null;
  }

  const adapter = typeof location !== "undefined" ? forHost(location.hostname) : null;

  /** The editable element that contains `node`, or null. */
  function editableRoot(node) {
    if (!(node instanceof Element)) return null;
    if (node.matches("textarea")) return node;
    if (node.isContentEditable) {
      let r = node;
      while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
      return r;
    }
    return null;
  }

  /** The chat box: focused editable first, then the adapter's selectors, then a generic guess. */
  function composer() {
    const focused = editableRoot(document.activeElement);
    if (focused) return focused;
    for (const s of adapter?.composer || []) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return document.querySelector("textarea, [contenteditable='true']");
  }

  function isSendButton(btn) {
    if (!(btn instanceof Element)) return false;
    for (const s of adapter?.send || []) if (btn.matches(s)) return true;
    const label = (btn.getAttribute("aria-label") || btn.getAttribute("data-testid") || "").trim();
    return /^(send|submit)\b/i.test(label);
  }

  K.sites = { ADAPTERS, forHost, adapter, editableRoot, composer, isSendButton };
})();
