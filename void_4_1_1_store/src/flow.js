/* Void — pure decision helpers. No DOM, no network, so they can be unit tested in Node. */
(() => {
  "use strict";
  const root = typeof self !== "undefined" ? self : globalThis;
  const K = (root.VoidKit = root.VoidKit || {});

  /** Characters we can afford to send to a model. Non-Latin scripts (Hindi, Tamil...) cost
      several tokens per character, so a fixed character limit silently overflows the context
      window and Ollama drops the *start* of the prompt, which is where the instructions are. */
  function budget(text, max) {
    const n = Math.min(text.length, 4000);
    let wide = 0;
    for (let i = 0; i < n; i++) if (text.charCodeAt(i) > 127) wide++;
    const f = n ? wide / n : 0;
    return Math.max(1500, Math.floor(max / (1 + 2.5 * f)));
  }

  /** Start, middle and end of a long text, so a hit late in the file is still seen. */
  function sample(text, max) {
    if (text.length <= max) return text;
    const a = Math.floor(max * 0.5), b = Math.floor(max * 0.25);
    const mid = Math.floor(text.length / 2);
    return `${text.slice(0, a)}\n[...]\n${text.slice(mid - b / 2, mid + b / 2)}\n[...]\n${text.slice(-b)}`;
  }

  /**
   * Decides whether the user is asked anything before an upload, and which buttons they get.
   *   flagged     : number of files with findings
   *   unscanned   : number of files the local AI could not check (no Ollama, timeout, no vision model)
   *   alwaysAsk   : the "ask before every upload" setting
   *   canRedact   : every flagged file is a text file Void can redact
   *   canRunLocal : Ollama is running and at least one file can be sent to it
   *   count       : number of files in the upload
   * Returns null when the upload can go ahead without asking.
   */
  function plan({ flagged = 0, unscanned = 0, alwaysAsk = false, canRedact = false, canRunLocal = false, count = 1 }) {
    if (!flagged && !unscanned && !alwaysAsk) return null;
    const many = count > 1;
    const kind = flagged ? "flagged" : unscanned ? "unscanned" : "confirm";
    const title = {
      flagged: many ? "Void found sensitive content in these files" : "Void found sensitive content in this file",
      unscanned: many ? "Void couldn't scan these files with AI" : "Void couldn't scan this file with AI",
      confirm: many ? "Upload these files?" : "Upload this file?"
    }[kind];
    const sub = {
      flagged: "Nothing has been uploaded yet. Choose what happens next.",
      unscanned: "Only the built-in pattern scan could run. Nothing has been uploaded yet.",
      confirm: "Nothing has been uploaded yet."
    }[kind];

    const buttons = [{ id: "block", label: "Block upload" }];
    buttons.push({ id: "allow", label: kind === "flagged" ? "Upload anyway" : "Upload" });
    if (canRunLocal) buttons.push({ id: "local", label: "Run on local LLM" });
    if (canRedact && kind === "flagged") buttons.push({ id: "redact", label: "Redact and upload" });

    // The highlighted button is the safest useful choice, never plain "upload anyway".
    const main = kind === "confirm" ? "allow"
      : buttons.some(b => b.id === "redact") ? "redact"
      : buttons.some(b => b.id === "local") ? "local" : "block";
    for (const b of buttons) b.main = b.id === main;
    return { kind, title, sub, buttons };
  }

  K.flow = { budget, sample, plan };
  if (typeof module !== "undefined" && module.exports) module.exports = K.flow;
})();
