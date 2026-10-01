(() => {
  "use strict";
  const K = self.VoidKit;
  if (!K || !K.detect || !K.files || !K.flow || !K.engine || !K.sites || !K.ui) return;
  if (self.__voidBooted) return;
  self.__voidBooted = true;

  // ---- settings ------------------------------------------------------------
  const DEFAULTS = {
    enabled: true, mode: "auto", uploadGate: true, stripImageMetadata: true,
    strictMode: false, alwaysAsk: false, engine: "auto", disabledSites: {}, categories: {}
  };
  let settings = { ...DEFAULTS };
  const site = K.sites.adapter;

  // After the extension is reloaded or updated, old content scripts are orphaned.
  // Every handler checks this first so the page is never broken by a dead script.
  function alive() { try { return !!chrome.runtime?.id; } catch (_) { return false; } }
  const active = () => settings.enabled && !(site && settings.disabledSites && settings.disabledSites[site.name]);

  chrome.storage.sync.get(DEFAULTS).then(s => { settings = { ...DEFAULTS, ...s }; }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (!alive()) return;
    if (area === "sync") {
      for (const k of Object.keys(DEFAULTS)) if (ch[k]) settings[k] = ch[k].newValue;
      if (ch.engine) K.engine.reset();
    }
    if (area === "local" && ch.ai) K.engine.reset();
  });

  // ---- activity counters (counts only, never values) ----------------------
  const pending = { redactions: 0, byCat: {}, scanned: 0, flagged: 0, blocked: 0, local: 0 };
  let flushTimer = 0;
  function bump(fn) { fn(pending); clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1500); }
  async function flush() {
    if (!alive()) return;
    const snap = JSON.parse(JSON.stringify(pending));
    pending.redactions = pending.scanned = pending.flagged = pending.blocked = pending.local = 0; pending.byCat = {};
    try {
      const { stats } = await chrome.storage.local.get({
        stats: { since: Date.now(), redactions: 0, byCat: {}, scanned: 0, flagged: 0, blocked: 0, local: 0 }
      });
      stats.redactions += snap.redactions; stats.scanned += snap.scanned;
      stats.flagged += snap.flagged; stats.blocked += snap.blocked; stats.local = (stats.local || 0) + snap.local;
      for (const [k, n] of Object.entries(snap.byCat)) stats.byCat[k] = (stats.byCat[k] || 0) + n;
      await chrome.storage.local.set({ stats });
    } catch (_) { /* stats are best-effort */ }
  }

  // ---- prompt box ----------------------------------------------------------
  const isField = el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  const valueOf = el => (isField(el) ? el.value : (el.innerText || el.textContent || ""));
  const squash = s => s.replace(/\s+/g, "");

  function setValue(el, value) {
    if (isField(el)) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter ? setter.call(el, value) : (el.value = value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    // Rich editors (ProseMirror, Quill) keep their own document model, so
    // writing textContent is ignored. Use real editing commands instead.
    el.focus();
    const sel = getSelection();
    sel.removeAllRanges(); sel.selectAllChildren(el);
    let ok = false;
    try { ok = document.execCommand(value ? "insertText" : "delete", false, value || undefined); } catch (_) {}
    if (ok && squash(valueOf(el)) === squash(value)) return;

    bypassPaste = true;
    try {
      sel.removeAllRanges(); sel.selectAllChildren(el);
      const dt = new DataTransfer(); dt.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } finally { bypassPaste = false; }
    if (squash(valueOf(el)) === squash(value)) return;

    el.textContent = value;   // last resort for plain contenteditable
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  function intercept(el, event) {
    if (!el || !active()) return false;
    const raw = valueOf(el);
    if (!raw) return false;
    const hits = K.detect.scan(raw, settings.categories);
    if (!hits.length) return false;
    const summary = K.detect.summarize(hits).join(" · ");
    bump(p => { p.redactions += hits.length; for (const h of hits) p.byCat[h.cat] = (p.byCat[h.cat] || 0) + 1; });

    if (settings.mode === "warn") { K.ui.toast("Sensitive data detected", summary, "warn"); return false; }
    event.preventDefault(); event.stopImmediatePropagation();
    setValue(el, K.detect.redact(raw, hits));
    K.ui.toast("Sensitive text removed", `${summary} was removed from your message. Check it, then send again.`);
    return true;
  }

  document.addEventListener("keydown", e => {
    if (!alive() || !active()) return;
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing) return;
    const el = K.sites.editableRoot(e.target);
    if (el) intercept(el, e);
  }, true);

  document.addEventListener("click", e => {
    if (!alive() || !active()) return;
    const btn = e.target instanceof Element ? e.target.closest("button,[role='button']") : null;
    if (!btn || !K.sites.isSendButton(btn)) return;
    const el = K.sites.composer();
    if (el) intercept(el, e);
  }, true);

  let inputTimer = 0;
  document.addEventListener("input", e => {
    if (!alive() || !active()) return;
    const el = K.sites.editableRoot(e.target);
    if (!el) return;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      const hits = K.detect.scan(valueOf(el), settings.categories);
      if (hits.length && !K.ui.hasToast()) {
        const tail = settings.mode === "auto" ? " Void will redact it when you send." : "";
        K.ui.toast("Sensitive data detected", K.detect.summarize(hits).join(" · ") + "." + tail, "warn");
      }
    }, 350);
  }, true);

  // ---- file inspection -----------------------------------------------------
  // What Void does with an upload:
  //   1. Reads the file's CONTENT on this device (text, Office, PDF, image pixels). The file name is only a hint.
  //   2. Runs the pattern scan on that content. Any hit flags the file; the AI can't overrule it.
  //   3. If nothing matched, asks local Ollama to judge the content (skipped when step 2 already flagged it).
  //   4. Flagged, or couldn't be checked by AI  ->  the user chooses. Otherwise the upload goes through.
  const MAX_TEXT = 5 * 1024 * 1024, MAX_PDF = 30 * 1024 * 1024, MAX_OFFICE = 60 * 1024 * 1024;
  const TEXT_EXT = new Set(("txt csv tsv md markdown json jsonl xml html htm log yaml yml toml ini cfg conf env sql " +
    "js jsx ts tsx py rb go rs java kt c h cpp cs php sh bat ps1 tex srt vtt rtf eml vcf ics svg").split(" "));
  const OFFICE = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);
  const LEGACY = new Set(["doc", "xls", "ppt"]);
  const IMAGE = /^image\/(jpeg|png|webp|gif|bmp|avif|heic|heif)$/;
  const NAME_RE = /(aadhaar|aadhar|passport|pan[\s_-]?card|driving[\s_-]?licen[cs]e|voter[\s_-]?id|bank[\s_-]?statement|salary[\s_-]?slip|payslip|form[\s_-]?16|credit[\s_-]?card|birth[\s_-]?certificate|(?:^|[^a-z])(?:itr|ssn)(?:[^a-z]|$))/i;

  const uniq = a => [...new Set(a.filter(Boolean))];
  const engineOn = () => settings.engine !== "rules";

  // The same file is never sent to the model twice.
  const aiCache = new Map();
  const cacheKey = (f, label) => `${f.name}|${f.size}|${f.lastModified}|${label}`;
  function remember(k, v) { aiCache.set(k, v); if (aiCache.size > 30) aiCache.delete(aiCache.keys().next().value); }

  const newReport = file => ({
    file, name: file.name || "pasted file",
    findings: [],      // real problems: these trigger the choice dialog
    hints: [],         // shown in the dialog, never enough on their own to flag a file
    notes: [],         // shown in the toast afterwards
    unscanned: "",     // why local AI could not check this file (empty = it did, or AI is switched off)
    output: null, redacted: null, inspected: false, hitCount: 0, hitCats: [], text: "", isImage: false
  });

  async function inspectImage(file, rep, eng) {
    rep.inspected = true; rep.isImage = true;
    let meta = { exif: false, gps: false };
    try { meta = K.files.exifInfo(new Uint8Array(await file.slice(0, 262144).arrayBuffer())); } catch (_) {}

    const canStrip = settings.stripImageMetadata && /^image\/(jpeg|png|webp)$/.test(file.type);
    if (canStrip) {
      try {
        rep.output = await K.files.sanitizeImage(file);
        rep.notes.push(meta.gps ? "Location data removed from the photo" : meta.exif ? "Photo metadata removed" : "Image metadata removed");
      } catch (_) {
        if (meta.gps) rep.findings.push("The photo contains GPS location data and could not be cleaned");
        else rep.notes.push("Image metadata could not be removed");
      }
    } else if (meta.gps) rep.findings.push("The photo contains GPS location data");

    if (eng.vision) {
      try {
        const key = cacheKey(file, eng.label + "|img");
        let ai = aiCache.get(key);
        if (!ai) { ai = await K.engine.classifyImage(settings.engine, await K.files.imageForModel(file)); remember(key, ai); }
        if (ai.contains_person) rep.findings.push("The image appears to contain a person");
        else if (ai.personal) rep.findings.push("The image appears to be personal");
        if (ai.sensitive) rep.findings.push(...(ai.categories.length ? ai.categories : ["Sensitive content"]));
        if ((ai.sensitive || ai.personal || ai.contains_person) && ai.reason) rep.findings.push(ai.reason);
      } catch (e) { rep.unscanned = rep.unscanned || `The image check failed (${e.message})`; }
    } else if (eng.text && engineOn()) {
      // Ollama is running but no vision model is chosen: the image is not analysed.
      if (settings.strictMode) rep.unscanned = rep.unscanned || "Image content was not analysed (no local vision model)";
      else rep.notes.push("Image content was not analysed (no local vision model)");
    }
    return rep;
  }

  async function inspectDocument(file, ext, rep, eng) {
    let text = "", unreadable = false, isText = false, partial = "";
    const textLike = TEXT_EXT.has(ext) || file.type.startsWith("text/") ||
      file.type === "application/json" || file.type === "application/xml";
    try {
      if (textLike) {
        isText = true; text = await file.slice(0, MAX_TEXT).text();
        if (file.size > MAX_TEXT) partial = "Only the first 5 MB of this file was checked";
      } else if (OFFICE.has(ext)) {
        if (file.size > MAX_OFFICE) throw new Error("Office file too large");
        text = await K.files.officeText(file, ext);
      } else if (ext === "pdf" || file.type === "application/pdf") {
        if (file.size > MAX_PDF) throw new Error("PDF too large");
        text = await K.files.pdfText(file);
        if (!squash(text).length || !K.files.looksLikeText(text)) unreadable = true;   // empty, or glyph IDs instead of letters
      } else if (LEGACY.has(ext)) unreadable = true;
      else {                                  // video, audio, archives, unknown types
        if (settings.strictMode) rep.unscanned = rep.unscanned || "Void does not read this type of file";
        return rep;
      }
    } catch (_) { unreadable = true; }

    rep.inspected = true;
    if (unreadable) {
      rep.findings.push(ext === "pdf"
        ? "This PDF has no readable text (scanned, image-based or unusual fonts), so Void could not check it"
        : "Void cannot read this file format locally, so it could not check it");
    }
    if (!text) return rep;
    if (unreadable && ext === "pdf" && !K.files.looksLikeText(text)) text = text.replace(/[^\x20-\x7e\n]/g, " ");   // still scan whatever is plain ASCII
    if (text.length > K.detect.MAX_SCAN) partial = partial || "Only the first 2 million characters of this file were checked";
    if (partial) rep.unscanned = rep.unscanned || partial;
    rep.text = text;

    // Content first: the pattern scan runs on what is inside the file.
    const hits = K.detect.scan(text, settings.categories);
    if (hits.length) {
      rep.hitCount = hits.length;
      rep.hitCats = hits.map(h => h.cat);
      rep.findings.push(...K.detect.summarize(hits));
      if (isText && file.size <= MAX_TEXT) {
        rep.redacted = new File([K.detect.redact(text, hits)], file.name, { type: file.type, lastModified: Date.now() });
      }
      return rep;      // already flagged, and the AI can't overrule that: don't spend seconds asking a model
    }

    if (ext === "pdf" && squash(text).length < 30) {
      rep.findings.push("This PDF has no readable text (scanned, image-based or unusual fonts), so Void could not check it");
      return rep;
    }

    // Autonomous document analysis layer (Void evaluates document on its own before/alongside AI)
    const analysis = K.detect.analyzeDocument ? K.detect.analyzeDocument(text, file.name, settings.categories) : null;
    const isSuspicious = Boolean(analysis?.suspicious || rep.nameHint);

    if (eng.text && !unreadable && squash(text).length >= 40) {
      try {
        const key = cacheKey(file, eng.label);
        let ai = aiCache.get(key);
        if (!ai) { ai = await K.engine.classifyText(settings.engine, text, file.name, !!rep.nameHint); remember(key, ai); }
        if (ai.sensitive || ai.personal) {
          rep.findings.push(...ai.categories.map(c => `AI: ${c}`));
          rep.findings.push(ai.reason ? `AI: ${ai.reason}` : "AI: personal or sensitive content");
        }
      } catch (e) {
        // Fallback layer: If the document was successfully parsed on its own, has 0 pattern hits,
        // and has no suspicious keywords or name hints, do NOT block the upload on an AI timeout.
        if (settings.strictMode || isSuspicious) {
          rep.unscanned = rep.unscanned || `The AI check failed (${e.message}); only the pattern scan ran`;
        } else {
          rep.notes.push("Verified by built-in scan (local AI was slow or unavailable)");
        }
      }
    }
    return rep;
  }

  async function inspectFile(file, eng) {
    const rep = newReport(file);
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    // The name is a hint, not a verdict: it never flags a file by itself.
    if (NAME_RE.test(file.name)) { rep.nameHint = true; rep.hints.push("The file name suggests an identity or financial document"); }
    // No local AI at all: nothing can be double-checked, so the user decides.
    if (engineOn() && !eng.text) {
      rep.unscanned = eng.noModel ? "Ollama is running, but none of its installed models can run Void's check" : "no local AI is running";
    }
    return IMAGE.test(file.type) ? inspectImage(file, rep, eng) : inspectDocument(file, ext, rep, eng);
  }

  /** "Run on local Ollama": the user's message and the file go to the local model instead of the website. */
  async function runLocal(reports, eng) {
    const docs = reports.filter(r => r.text).map(r => ({ name: r.name, text: r.text }));
    const imgs = reports.filter(r => r.isImage);
    const notes = [];
    let kind = "text", b64 = "";
    if (!docs.length) {
      if (!imgs.length || !eng.vision) { K.ui.toast("Nothing to run", "Void could not read these files for the local model.", "warn"); return; }
      kind = "image";
      try { b64 = await K.files.imageForModel(imgs[0].file); }
      catch (_) { K.ui.toast("Could not read the image", "The local model was not started.", "warn"); return; }
      if (imgs.length > 1) notes.push(`Only the first image (${imgs[0].name}) is used.`);
    } else {
      if (imgs.length) notes.push("Images are left out, because the text model can't read them.");
      if (K.engine.chatPrompt(docs, "").truncated) notes.push("The file is long, so only the first part was given to the model.");
    }
    const used = kind === "image" ? [imgs[0]] : reports.filter(r => r.text);
    const left = reports.filter(r => !used.includes(r) && !r.isImage).length;
    if (left > 0) notes.push(`${left} file${left > 1 ? "s" : ""} could not be read and ${left > 1 ? "were" : "was"} left out.`);

    const box = K.sites.composer();
    bump(p => { p.local += reports.length; });
    K.ui.localPanel({
      label: eng.label,
      files: used.map(r => r.name),
      notes, prompt: box ? valueOf(box).trim() : "", defaultPrompt: kind === "image" ? "Describe this image." : "Summarize this document.",
      start: (question, onToken) => kind === "image"
        ? K.engine.chat({ kind: "image", prompt: question, imageBase64: b64 }, onToken)
        : K.engine.chat({ kind: "text", prompt: K.engine.chatPrompt(docs, question).prompt }, onToken)
    });
  }

  /** Returns the files to upload (possibly cleaned or redacted), or null if nothing should be uploaded. */
  async function guardFiles(files) {
    K.ui.scanning(true);
    const reports = [];
    let eng;
    try {
      eng = await K.engine.status(settings.engine);
      for (const f of files) {
        try { reports.push(await inspectFile(f, eng)); }
        catch (_) {
          const r = newReport(f); r.findings.push("Void hit an error while checking this file"); r.inspected = true;
          reports.push(r);
        }
      }
    } finally { K.ui.scanning(false); }
    bump(p => { p.scanned += files.length; });

    const flagged = reports.filter(r => r.findings.length);
    const unscanned = reports.filter(r => r.unscanned && !r.findings.length);
    const plan = K.flow.plan({
      flagged: flagged.length, unscanned: unscanned.length, alwaysAsk: settings.alwaysAsk, count: files.length,
      canRedact: flagged.length > 0 && flagged.every(r => r.redacted),
      canRunLocal: (eng.tier === "ollama" || eng.text) && reports.some(r => r.text || (r.isImage && eng.vision))
    });

    let choice = null, useRedacted = false;
    if (plan) {
      if (flagged.length) bump(p => { p.flagged += flagged.length; });
      const listed = plan.kind === "confirm" ? reports : reports.filter(r => r.findings.length || r.unscanned);
      choice = await K.ui.dialog(plan, listed.map(r => ({
        name: r.name,
        lines: [...uniq(r.findings), ...(r.unscanned ? [`Not checked by AI: ${r.unscanned}`] : []), ...r.hints,
          ...(!r.findings.length && !r.unscanned ? ["No sensitive content found"] : [])]
      })), !eng.text && engineOn() && eng.detail ? eng.detail : "");

      if (choice === "block") {
        bump(p => { p.blocked += listed.length; });
        K.ui.toast("Upload blocked", "Nothing was sent to the website.");
        return null;
      }
      if (choice === "local") { await runLocal(reports, eng); return null; }
      useRedacted = choice === "redact";
      if (useRedacted) bump(p => { for (const r of flagged) { p.redactions += r.hitCount; for (const c of r.hitCats) p.byCat[c] = (p.byCat[c] || 0) + 1; } });
    }

    const out = reports.map(r => (useRedacted && r.redacted) || r.output || r.file);
    const notes = uniq(reports.flatMap(r => r.notes)).slice(0, 2);
    const skipped = reports.filter(r => !r.inspected).length;
    if (skipped) notes.push(`${skipped} file${skipped > 1 ? "s" : ""} of a type Void does not read`);
    if (plan) K.ui.toast(useRedacted ? "Redacted and uploading" : "Upload allowed", notes.join(" · "), "warn");
    else if (reports.some(r => r.inspected)) K.ui.toast("Safe to upload", uniq([eng.label, ...notes]).join(" · "));
    else K.ui.toast("Not inspected", notes.join(" · "), "warn");
    return out;
  }

  // ---- upload paths: file picker, paste, drag-and-drop ---------------------
  let chain = Promise.resolve();
  const enqueue = fn => (chain = chain.catch(() => {}).then(fn));
  const passthrough = new WeakSet();
  let bypassPaste = false, bypassDrop = false;
  const toDT = files => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); return dt; };

  document.addEventListener("change", e => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.files?.length) return;
    if (passthrough.has(input)) { passthrough.delete(input); return; }
    if (!alive() || !active() || !settings.uploadGate) return;
    e.stopImmediatePropagation();               // the site must not see the original file yet
    const original = [...input.files];
    enqueue(async () => {
      try {
        const out = await guardFiles(original);
        if (!out) { input.value = ""; return; }
        input.files = toDT(out).files;
        passthrough.add(input);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {
        input.value = "";
        K.ui.toast("Upload blocked", "Void could not check the file safely, so nothing was sent.", "warn");
      }
    });
  }, true);

  document.addEventListener("paste", e => {
    if (bypassPaste || !alive() || !active() || !settings.uploadGate) return;
    const cd = e.clipboardData;
    if (!cd || !cd.files.length) return;
    // Word and Excel put a picture of the text on the clipboard next to the text.
    // Only treat it as a file paste when there is no text alongside.
    if (cd.getData("text/plain")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const files = [...cd.files], target = e.target;
    enqueue(async () => {
      try {
        const out = await guardFiles(files);
        if (!out) return;
        bypassPaste = true;
        try { target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: toDT(out), bubbles: true, cancelable: true })); }
        finally { bypassPaste = false; }
      } catch (_) { K.ui.toast("Paste blocked", "Void could not check the file safely.", "warn"); }
    });
  }, true);

  document.addEventListener("drop", e => {
    if (bypassDrop || !alive() || !active() || !settings.uploadGate) return;
    const dt = e.dataTransfer;
    if (!dt || !dt.files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const files = [...dt.files], { clientX, clientY } = e;
    let target = e.target;
    const settle = () => {                        // clear any "drop files here" overlay the site is showing
      try { (document.body || document.documentElement).dispatchEvent(new DragEvent("dragleave", { bubbles: true })); } catch (_) {}
    };
    enqueue(async () => {
      try {
        const out = await guardFiles(files);
        if (!out) { settle(); return; }
        if (!(target && target.isConnected)) target = document.elementFromPoint(clientX, clientY) || document.body;
        bypassDrop = true;
        try { target.dispatchEvent(new DragEvent("drop", { dataTransfer: toDT(out), bubbles: true, cancelable: true, clientX, clientY })); }
        finally { bypassDrop = false; }
      } catch (_) { settle(); K.ui.toast("Drop blocked", "Void could not check the file safely.", "warn"); }
    });
  }, true);
})();
