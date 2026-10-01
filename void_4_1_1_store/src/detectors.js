/* Void — pattern detectors. Pure functions, no DOM, no network. */
(() => {
  "use strict";
  const root = typeof self !== "undefined" ? self : globalThis;
  const K = (root.VoidKit = root.VoidKit || {});

  // ---- checksums -----------------------------------------------------------
  const D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
  ];
  const P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
  ];
  function verhoeff(num) {
    let c = 0;
    const digits = num.split("").reverse().map(Number);
    for (let i = 0; i < digits.length; i++) c = D[c][P[i % 8][digits[i]]];
    return c === 0;
  }

  function luhn(s) {
    if (s.length < 13 || s.length > 19) return false;
    let sum = 0, dbl = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let n = s.charCodeAt(i) - 48;
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n; dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  function ibanOk(s) {
    s = s.replace(/\s/g, "").toUpperCase();
    if (s.length < 15 || s.length > 34) return false;
    const r = s.slice(4) + s.slice(0, 4);
    let rem = 0;
    for (const ch of r) {
      const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
      for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
    return rem === 1;
  }


  // ---- address helpers ------------------------------------------------------
  const STREET_SUFFIX = "road|rd|street|st|avenue|ave|lane|ln|boulevard|blvd|nagar|colony|layout|marg|chowk|cross|apartments?|residency|enclave|extension|puram|vihar|terrace|highway|hwy|drive|circle|nivas|bhavan|society|sector|villas?|towers?";
  const STREETISH = new RegExp("\\b(?:" + STREET_SUFFIX + "|village|vill|district|dist|tehsil|taluk|post office|floor|block|phase|stage|main|gali|mohalla|complex|heights|building|bldg)\\b", "i");
  // Comma separated locality parts that may follow a street, then an optional 6-digit PIN.
  const SEGS = "(?:\\s*,\\s*[A-Za-z0-9][\\w'\\u2019/-]*(?:[ ][\\w'\\u2019/-]+){0,3}){0,5}(?:[\\s,-]*\\b\\d{6}\\b)?";
  // Free text after an address label: up to a few comma separated parts, never the whole paragraph.
  const TAIL_FREE = "[^\\n,;]{2,70}(?:\\s*,\\s*[^\\n,;]{1,60}){0,6}";
  const STOP_WORD = /\s+(?:and|but|also|then|please|pls|plz|so|because|which|where|call|phone|mobile|mob|contact|email|e-mail|kindly|thanks|thank)\b/i;
  function cutAtStopWord(v) { const i = v.search(STOP_WORD); return i > 8 ? v.slice(0, i) : v; }
  function streetLineOk(v) {
    const body = v.replace(/^\W*(?:no|h\.?\s?no|d\.?\s?no)\b\.?/i, "");
    const first = (body.match(/^\W*(\S+)/) || [, ""])[1];
    const houseLike = /[/-]/.test(first) || /^\d+[A-Za-z]$/.test(first);
    return /,/.test(body) || houseLike || /[A-Z][a-z]+/.test(body.replace(/^\W*\d\S*/, ""));
  }
  const IN_PLACES = "Bengaluru|Bangalore|Mumbai|New Delhi|Delhi|Chennai|Hyderabad|Kolkata|Pune|Ahmedabad|Jaipur|Lucknow|Noida|Gurgaon|Gurugram|Ghaziabad|Faridabad|Kochi|Cochin|Thiruvananthapuram|Trivandrum|Coimbatore|Mysuru|Mysore|Mangaluru|Mangalore|Hubballi|Hubli|Nagpur|Indore|Bhopal|Patna|Ranchi|Bhubaneswar|Visakhapatnam|Vizag|Vijayawada|Surat|Vadodara|Chandigarh|Dehradun|Guwahati|Madurai|Thane|Navi Mumbai|Nashik|Kanpur|Agra|Varanasi|Amritsar|Ludhiana|" +
    "Karnataka|Maharashtra|Tamil Nadu|Telangana|Kerala|Gujarat|Rajasthan|Uttar Pradesh|Madhya Pradesh|West Bengal|Bihar|Odisha|Orissa|Andhra Pradesh|Punjab|Haryana|Assam|Jharkhand|Uttarakhand|Himachal Pradesh|Goa|Chhattisgarh|India";
  const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";

  // ---- rules ---------------------------------------------------------------
  // `cat` is the user-facing toggle. Order = priority when matches overlap.
  const RULES = [
    { id: "privkey", cat: "secrets", label: "Private key",
      re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g },
    { id: "apikey", cat: "secrets", label: "API key or token",
      re: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,})\b/g },
    { id: "jwt", cat: "secrets", label: "Login token (JWT)",
      re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
    { id: "card", cat: "card", label: "Payment card number",
      re: /(?<![\d])(?:\d[ -]?){12,18}\d(?!\d)/g,
      ok: m => { const d = m.replace(/\D/g, ""); return /^[2-6]/.test(d) && luhn(d); } },
    { id: "aadhaar", cat: "aadhaar", label: "Aadhaar number",
      re: /(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
      ok: m => verhoeff(m.replace(/\D/g, "")) },
    { id: "iban", cat: "iban", label: "IBAN",
      re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, ok: ibanOk },
    { id: "pan", cat: "pan", label: "PAN number",
      re: /\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b/gi },
    { id: "ssn", cat: "ssn", label: "US Social Security number",
      re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
    { id: "upi", cat: "upi", label: "UPI ID",
      re: /\b[\w.-]{2,}@(?:ok(?:axis|hdfcbank|icici|sbi)|ybl|ibl|axl|paytm|apl|upi|oksbi|sbi|axisbank|icici|hdfcbank|postbank|idfcbank|kotak|indus|barodampay|federal|airtel|pnb|boi|cnrb)\b/gi },
    { id: "email", cat: "email", label: "Email address",
      re: /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,63}\b/gi },
    { id: "otp", cat: "otp", label: "One-time code",
      re: /\b(?:OTP|one[- ]time (?:password|code|pin)|verification code|security code)\s*(?:is|:|=)?\s*\d{4,8}\b/gi },
    { id: "password", cat: "password", label: "Password",
      re: /\b(?:password|passcode|passwd|pwd)\s*(?:is|:|=)\s*\S+/gi },
    // Address family. Several rules share cat "address" (one user toggle). Priority = order.
    // 1) "address: ...", "my address is ...", "ship to: ...", "r/o ...", "c/o ..."
    { id: "address", cat: "address", label: "Address",
      re: new RegExp(
        "(?<!\\b(?:e-?mail|ip|mac|web|wallet|url|btc|eth|crypto)\\s)" +
        "(?:\\b(?:(?:home|permanent|residential|postal|mailing|current|present|office|billing|shipping|delivery|correspondence|full|my|our|his|her|their)\\s+)?(?:address|addr)\\b" +
        "|\\b(?:ship(?:ping)?|deliver(?:y)?|bill(?:ing)?)\\s+to\\b)" +
        "(?:\\s*(?:\\b(?:is|are|was)\\b|[:=\\u2013\\u2014-])\\s*|[ \\t]*\\r?\\n\\s*)" + TAIL_FREE, "gi"),
      trim: cutAtStopWord, ok: v => /\d/.test(v) || STREETISH.test(v) },
    { id: "address", cat: "address", label: "Address",
      re: new RegExp("(?:\\b(?:resid(?:ing|es|ed)|[sdwcr]\\/o)\\s+(?:at\\s+)?|\\u092a\\u0924\\u093e\\s*[:=-]\\s*)" + TAIL_FREE, "gi"),
      trim: cutAtStopWord, ok: v => /\d|\b(?:road|rd|street|nagar|colony|village|vill|dist|district|post|po)\b/i.test(v) || /^[^\s]+\s+[A-Z]/.test(v) },
    // 2) "I live at 12 Rose Street", "staying in Flat 4, Sunrise Apartments"
    { id: "address", cat: "address", label: "Address",
      re: new RegExp("\\b(?:liv(?:e|es|ed|ing)|stay(?:s|ed|ing)?|resid(?:e|es|ed|ing)|located|shifted|moved)\\s+(?:at|in|to)\\s+(?:the\\s+)?" + TAIL_FREE, "gi"),
      trim: cutAtStopWord, ok: v => STREETISH.test(v) || (/\d/.test(v) && /,/.test(v) && v.split(/\s+/).length >= 4) },
    // 3) Flat / house / plot numbers, with the locality that follows on the same line
    { id: "address", cat: "address", label: "Address",
      re: new RegExp("\\b(?:flat|house|door|plot|apartment|apt|suite|unit|room|h\\.?\\s?no|d\\.?\\s?no)\\b\\.?\\s*(?:no\\.?|number|#)?\\s*[:#-]?\\s*\\d+[A-Za-z]?(?:[/-]\\d+[A-Za-z]?)*" + SEGS, "gi"),
      trim: cutAtStopWord, ok: v => /\b(?:no\.?|number)\s*[:#-]?\s*\d|#\s*\d/i.test(v) || (/,/.test(v) && /\d/.test(v)) },
    // 4) A street line that starts with the house number: "12/4 MG Road, Indiranagar, Bengaluru 560038"
    { id: "address", cat: "address", label: "Address",
      re: new RegExp("(?<![\\w/#.-])(?:(?:no|h\\.?\\s?no|d\\.?\\s?no|#)\\.?\\s*)?\\d{1,5}[A-Za-z]?(?:[/-]\\d{1,5}[A-Za-z]?){0,3}(?:\\s*,\\s*|\\s+)" +
        "(?:[A-Za-z0-9.'\\u2019-]+(?:\\s+|\\s*,\\s*)){0,6}?(?:" + STREET_SUFFIX + ")\\b\\.?(?:\\s+(?:NE|NW|SE|SW|N|S|E|W)\\b\\.?)?" + SEGS, "gi"),
      trim: cutAtStopWord, ok: streetLineOk },
    // 5) PIN / ZIP / postcode: labelled, after a known Indian city or state, US "City, ST 12345", UK format
    { id: "postal", cat: "address", label: "PIN / postal code",
      re: new RegExp("\\b(?:pin(?:[\\s-]?code)?|zip(?:[\\s-]?code)?|post(?:al)?[\\s-]?code)\\b\\s*(?:\\b(?:is|no\\.?|number)\\b|[:=#\\u2013\\u2014-])?\\s*(?:[1-9]\\d{2}\\s?\\d{3}|\\d{5}(?:-\\d{4})?|[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2})(?![\\w])", "gi") },
    { id: "postal", cat: "address", label: "PIN / postal code",
      re: new RegExp("\\b(?:" + IN_PLACES + ")\\b[\\s,.:-]{0,4}(?<![\\d])[1-9]\\d{2}\\s?\\d{3}(?!\\d)", "gi") },
    { id: "postal", cat: "address", label: "PIN / postal code",
      re: new RegExp(",\\s*(?:" + US_STATES + ")\\s+\\d{5}(?:-\\d{4})?(?!\\d)", "g") },
    { id: "postal", cat: "address", label: "PIN / postal code",
      re: /(?<![\w-])[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}(?![\w])/g },
    { id: "phone", cat: "phone", label: "Phone number",
      re: /(?<![\d])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)|(?<![\w])\+(?!91)\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g }
  ];

  const CATEGORIES = [
    ["aadhaar", "Aadhaar numbers", "12-digit Indian ID numbers, checked with the Verhoeff checksum"],
    ["pan", "PAN numbers", "Indian tax ID numbers"],
    ["phone", "Phone numbers", "Indian mobile numbers and international numbers starting with +"],
    ["email", "Email addresses", "Any email address"],
    ["upi", "UPI IDs", "Payment IDs such as name@okhdfcbank"],
    ["card", "Payment cards", "Card numbers, checked with the Luhn checksum"],
    ["iban", "Bank account (IBAN)", "International bank account numbers, checksum verified"],
    ["ssn", "US Social Security numbers", "Numbers in the 123-45-6789 format"],
    ["otp", "One-time codes", "OTPs and verification codes"],
    ["password", "Passwords", "Values that follow a password or passcode label"],
    ["secrets", "API keys, tokens and private keys", "OpenAI, AWS, GitHub, Google, Slack and Stripe keys, JWTs, PEM private keys"],
    ["address", "Addresses", "\"My address is…\", \"I live at…\", street lines, flat or house numbers, PIN, ZIP and postcodes"]
  ];

  const MAX_SCAN = 2_000_000;
  const compiled = new Map();   // each rule's RegExp is built once, not on every keystroke
  // Older Void versions left "[... REDACTED BY VOID]" markers. Still recognised so old text is not re-flagged.
  const MARKER = /\[[A-Z0-9 ()\/-]{2,40} REDACTED BY VOID\]/g;

  /** categories: {aadhaar:false,...}; missing keys count as enabled. */
  function scan(text, categories) {
    if (!text) return [];
    if (text.length > MAX_SCAN) text = text.slice(0, MAX_SCAN);
    const cats = categories || {};
    const accepted = [];
    let mk;
    const markerRe = new RegExp(MARKER.source, MARKER.flags);
    while ((mk = markerRe.exec(text)) !== null) accepted.push({ marker: true, start: mk.index, end: mk.index + mk[0].length });
    for (const rule of RULES) {
      if (cats[rule.cat] === false) continue;
      const re = compiled.get(rule) || (compiled.set(rule, new RegExp(rule.re.source, rule.re.flags)), compiled.get(rule));
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const val = rule.trim ? rule.trim(m[0]) : m[0];
        if (rule.ok && !rule.ok(val)) continue;
        const start = m.index, end = m.index + val.length;
        const over = accepted.filter(h => start < h.end && end > h.start);
        if (over.length) {
          // An address line may contain an email or phone number. Keep the whole address so none of it leaks.
          const swallow = rule.cat === "address" && over.every(h => !h.marker && h.cat !== "address" && start <= h.start && end >= h.end);
          if (!swallow) continue;
          for (const h of over) accepted.splice(accepted.indexOf(h), 1);
        }
        accepted.push({ id: rule.id, cat: rule.cat, label: rule.label, value: val, start, end });
      }
    }
    return accepted.filter(h => !h.marker).sort((a, b) => a.start - b.start);
  }

  /** Removes the sensitive text completely. No placeholder is left behind, and the gap is tidied
      so the rest of the message reads normally ("call me on X please" -> "call me on please"). */
  function redact(text, hits) {
    if (!hits || !hits.length) return text;
    let out = "", cursor = 0, removed = false;
    for (const h of hits) {
      if (h.start < cursor) continue;
      out += text.slice(cursor, h.start);
      cursor = h.end;
      removed = true;
      const atLineStart = out === "" || /\n[ \t]*$/.test(out);
      if (atLineStart) {
        // the hit was the first thing on its line: drop the spaces that followed it
        while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor++;
        // and if it was alone on its line, drop the empty line it leaves behind
        if (/\n[ \t]*$/.test(out) || out === "") {
          if (text[cursor] === "\r" && text[cursor + 1] === "\n") cursor += 2;
          else if (text[cursor] === "\n" && out !== "") cursor += 1;
        }
      } else if (cursor >= text.length || /[\s.,;:!?)\]}]/.test(text[cursor])) {
        out = out.replace(/[ \t]+$/, "");   // no double space, no space before punctuation
        if (cursor < text.length && /[ \t]/.test(text[cursor]) && /[ \t]$/.test(out)) cursor++;
      }
    }
    out += text.slice(cursor);
    return removed && !out.trim() ? "" : out;
  }

  /** "3 × Email address, 1 × PAN number" style summary lines. */
  function summarize(hits) {
    const counts = new Map();
    for (const h of hits) counts.set(h.label, (counts.get(h.label) || 0) + 1);
    return [...counts].map(([label, n]) => (n > 1 ? `${n} × ${label}` : label));
  }

  // Contextual sensitive indicators that identify personal, financial or confidential documents
  const CONTEXT_SENSITIVE = /\b(?:strictly\s+confidential|confidential\s+and\s+proprietary|non-disclosure\s+agreement|patient\s+(?:name|diagnosis|record|history)|medical\s+record|clinical\s+summary|doctor['’]?s\s+note|hospital\s+discharge|prescription\s+for|salary\s+slip|payslip|form\s+16|income\s+tax\s+return|tax\s+declaration|bank\s+account\s+statement|account\s+statement|credit\s+card\s+statement|driving\s+licen[cs]e\s+no|passport\s+no|social\s+security\s+no)\b/i;

  function analyzeDocument(text, filename, categories) {
    if (!text) return { clean: true, flagged: false, suspicious: false, hits: [], reason: "" };
    const hits = scan(text, categories);
    if (hits.length) {
      return { clean: false, flagged: true, suspicious: false, hits, reason: summarize(hits).join(" · ") };
    }
    const match = CONTEXT_SENSITIVE.exec(text);
    if (match) {
      return { clean: false, flagged: false, suspicious: true, hits: [], reason: `Mentions sensitive topic (${match[0]})` };
    }
    return { clean: true, flagged: false, suspicious: false, hits: [], reason: "" };
  }

  K.detect = { scan, redact, summarize, analyzeDocument, verhoeff, luhn, ibanOk, CATEGORIES, RULES, MAX_SCAN };
  if (typeof module !== "undefined" && module.exports) module.exports = K.detect;
})();
