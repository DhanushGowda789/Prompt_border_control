/**
 * Sovereign Shield — Content Script
 * Patches window.fetch to intercept AI API calls and route through local proxy.
 * Runs in MAIN world so it can override page-level fetch.
 */
(function () {
  'use strict';

  const PROXY = 'http://localhost:3333/proxy';

  const AI_HOSTS = [
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
  ];

  const SENSITIVE_RULES = [
    { category: 'PII', label: 'Personal information', color: '#f97316', patterns: [
      /\b\d{3}-\d{2}-\d{4}\b/g,
      /\b\d{16}\b|\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,
      /\b(passport|driver['\s]*s? licen[sc]e|aadhaar|pan\s+card|voter\s+id)\b/gi,
      /\b(ssn|social security|date of birth|home address|national id)\b/gi,
    ] },
    { category: 'HEALTH', label: 'Health data', color: '#ef476f', patterns: [
      /\b(diagnosed\s+with|diagnosis\s+of|medical record|patient data|prescription for)\b/gi,
      /\b(HIV|AIDS|cancer|diabetes|hypertension|depression|bipolar|schizophrenia)\b/gi,
      /\b(medical history|health record|medication|mental health|lab results|hospital record)\b/gi,
    ] },
    { category: 'FINANCIAL', label: 'Financial data', color: '#eab308', patterns: [
      /\b(account\s*(number|no\.?|#)|routing\s*(number|no\.?)|iban|swift\s*code)\b/gi,
      /\b(bank account|wire transfer|tax return|salary details|payroll)\b/gi,
    ] },
    { category: 'CONFIDENTIAL', label: 'Confidential information', color: '#8b5cf6', patterns: [
      /\b(classified|top\s+secret|confidential|proprietary|non-disclosure|NDA)\b/gi,
      /\b(government contract|defense contract|statement of work|national security)\b/gi,
    ] },
  ];

  const editorState = new WeakMap();

  function isAI(url) {
    try {
      const h = new URL(url).hostname;
      return AI_HOSTS.some(a => h === a || h.endsWith('.' + a));
    } catch { return false; }
  }

  function findSensitiveMatches(text) {
    const matches = [];
    for (const rule of SENSITIVE_RULES) {
      for (const pattern of rule.patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
          matches.push({ start: match.index, end: match.index + match[0].length, rule });
          if (!match[0].length) pattern.lastIndex++;
        }
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const match of matches) {
      const previous = merged[merged.length - 1];
      if (previous && match.start <= previous.end) {
        previous.end = Math.max(previous.end, match.end);
        previous.rules.add(match.rule);
      } else {
        merged.push({ ...match, rules: new Set([match.rule]) });
      }
    }
    return merged;
  }

  function selectionOffset(editor) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length;
  }

  function restoreSelection(editor, offset) {
    if (offset == null) return;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= node.nodeValue.length;
    }
  }

  function unwrapDecorations(editor) {
    editor.querySelectorAll('span[data-sovereign-mark]').forEach(mark => {
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
    editor.normalize();
  }

  function decorateEditor(editor) {
    if (!editor.isConnected || editor.dataset.sovereignDecorating === 'true') return;
    const text = editor.textContent || '';
    const matches = findSensitiveMatches(text);
    const state = editorState.get(editor) || {};
    if (state.text === text && state.matchCount === matches.length) return;
    const offset = selectionOffset(editor);
    editor.dataset.sovereignDecorating = 'true';
    unwrapDecorations(editor);
    if (matches.length) {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      let cursor = 0;
      while ((node = walker.nextNode())) {
        nodes.push({ node, start: cursor, end: cursor + node.nodeValue.length });
        cursor += node.nodeValue.length;
      }
      for (const target of nodes.reverse()) {
        const localMatches = matches.filter(match => match.start >= target.start && match.end <= target.end);
        if (!localMatches.length) continue;
        const fragment = document.createDocumentFragment();
        let localCursor = 0;
        for (const match of localMatches) {
          const start = match.start - target.start;
          const end = match.end - target.start;
          fragment.append(document.createTextNode(target.node.nodeValue.slice(localCursor, start)));
          const mark = document.createElement('span');
          mark.dataset.sovereignMark = 'true';
          mark.title = [...match.rules].map(rule => rule.label).join(' / ');
          mark.style.textDecoration = `underline 2px ${[...match.rules][0].color}`;
          mark.style.textDecorationSkipInk = 'none';
          mark.style.textUnderlineOffset = '3px';
          mark.textContent = target.node.nodeValue.slice(start, end);
          fragment.append(mark);
          localCursor = end;
        }
        fragment.append(document.createTextNode(target.node.nodeValue.slice(localCursor)));
        target.node.replaceWith(fragment);
      }
    }
    restoreSelection(editor, offset);
    editorState.set(editor, { text, matchCount: matches.length });
    editor.dataset.sovereignDecorating = 'false';
    updateWarning(editor, matches);
  }

  function updateWarning(editor, matches) {
    let warning = editor.parentElement?.querySelector('[data-sovereign-warning]');
    if (!matches.length) {
      warning?.remove();
      editor.removeAttribute('aria-describedby');
      return;
    }
    if (!warning) {
      warning = document.createElement('div');
      warning.dataset.sovereignWarning = 'true';
      warning.setAttribute('role', 'status');
      warning.style.cssText = 'font:12px system-ui,sans-serif;color:#b42318;background:#fff4ed;border:1px solid #f8b195;border-radius:8px;padding:6px 10px;margin:6px 0;z-index:2147483646;';
      editor.parentElement?.insertBefore(warning, editor);
    }
    const categories = [...new Set(matches.flatMap(match => [...match.rules].map(rule => rule.label)))];
    warning.textContent = `Sovereign Shield found ${matches.length} sensitive ${matches.length === 1 ? 'match' : 'matches'}: ${categories.join(', ')}`;
  }

  function monitorChatGPT() {
    if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname)) return;
    const scan = () => document.querySelectorAll('[contenteditable="true"]').forEach(decorateEditor);
    const observer = new MutationObserver(() => {
      clearTimeout(monitorChatGPT.timer);
      monitorChatGPT.timer = setTimeout(scan, 120);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('input', event => {
      if (event.target.matches?.('[contenteditable="true"]')) decorateEditor(event.target);
    }, true);
    scan();
  }

  // ── Patch fetch ──────────────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url ?? '';

    const method = (init?.method || (input?.method) || 'GET').toUpperCase();

    if (!isAI(url) || method !== 'POST') {
      return _fetch(input, init);
    }

    const parsed = new URL(url);
    const proxyUrl = `${PROXY}/${parsed.hostname}${parsed.pathname}${parsed.search}`;

    // Copy headers — preserve auth tokens so they pass through
    let headers = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else {
        headers = { ...init.headers };
      }
    }
    headers['x-sovereign-intercepted'] = '1';

    try {
      const resp = await _fetch(proxyUrl, { ...init, method: 'POST', headers });
      // Check if intercepted — clone so we don't consume the body
      resp.clone().json().then(data => {
        if (data?._sovereign?.intercepted) {
          showToast();
          window.dispatchEvent(new CustomEvent('sovereign:intercepted', { detail: data._sovereign }));
        }
      }).catch(() => {});
      return resp;
    } catch (err) {
      // Proxy down — fall back to original
      console.warn('[Sovereign Shield] Proxy unreachable, falling back to direct call:', err.message);
      return _fetch(input, init);
    }
  };

  // ── Patch XHR ────────────────────────────────────────────────────────────
  const _XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new _XHR();
    const _open = xhr.open.bind(xhr);
    let _url = '';
    xhr.open = function (method, url, ...rest) {
      _url = url;
      if (method.toUpperCase() === 'POST' && isAI(url)) {
        try {
          const p = new URL(url);
          return _open(method, `${PROXY}/${p.hostname}${p.pathname}${p.search}`, ...rest);
        } catch {}
      }
      return _open(method, url, ...rest);
    };
    return xhr;
  };

  // ── Toast notification ───────────────────────────────────────────────────
  function showToast() {
    if (!document.getElementById('_ss_style')) {
      const s = document.createElement('style');
      s.id = '_ss_style';
      s.textContent = `
        #_ss_toast {
          position:fixed;top:16px;right:16px;z-index:2147483647;
          background:#0e0e20;color:#00cc66;padding:10px 16px;
          border-radius:8px;font-family:monospace;font-size:13px;
          border:1px solid #00cc66;pointer-events:none;
          animation:_ss_fade 3s ease forwards;
        }
        @keyframes _ss_fade {
          0%{opacity:0;transform:translateY(-8px)}
          12%{opacity:1;transform:translateY(0)}
          75%{opacity:1}
          100%{opacity:0}
        }`;
      (document.head || document.documentElement).appendChild(s);
    }
    const old = document.getElementById('_ss_toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.id = '_ss_toast';
    t.textContent = '🛡️  Query intercepted — answered locally';
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  console.log('[Sovereign Shield] Monitoring AI API calls on this page');
  monitorChatGPT();
})();
