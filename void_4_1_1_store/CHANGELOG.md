# Void 4.1.1 — changes

## Sensitive text is now removed, not replaced
- Detected text (Aadhaar, PAN, phone, email, address, etc.) is deleted from the message completely. The
  "[AADHAAR NUMBER REDACTED BY VOID]" placeholder is gone. Only the sensitive part is removed; everything else is unchanged.
- The gap is tidied (no double spaces, no space before punctuation, no empty line left behind).
- If the whole message was sensitive the box is cleared.
- Text files redacted before upload use the same removal.

## Optimisation
- Detector regexes are compiled once instead of on every scan (the prompt is scanned on each pause in typing).
- PNG icons recompressed. Tests are kept out of the Chrome Web Store package.

# Void 4.1.0 — changes

## Address detection (src/detectors.js)
Root cause: the only address rule needed the literal word "address" followed by `:`, `=` or a dash. "My address is …",
"I live at …", "Ship to …", street lines and bare PIN/ZIP codes were never matched. A second bug: when an address line
contained an email or phone number, the smaller hit won the overlap check and the rest of the address was sent unredacted.
- Labels: address/addr + `is`/`:`/`-`, ship/deliver/bill to, r/o, c/o, s/o, Hindi "pata".
- Verbs: "live/stay/reside/located/moved at|in|to" followed by a street-like place.
- Street lines that start with a house number ("12/4 MG Road, Indiranagar, Bengaluru 560038", "1600 Pennsylvania Ave NW, Washington, DC 20500").
- Flat / house / plot / door numbers with the locality that follows.
- PIN / ZIP / UK postcodes: labelled, after a known Indian city or state, or "City, ST 12345".
- Whole address is kept when it contains an email/phone; text after "and please…" is not swallowed; phone is still caught separately.
- Guards against false positives: "email address", "IP address", "I live in Bengaluru", "3 cars on road", "w/o sugar", "room 5".

## Local model compatibility (background.js, src/engine.js, options, popup)
- Reads each installed model's real capabilities from Ollama (/api/show); name heuristics only as fallback.
- Live probe once per model build (cached): valid JSON? spots personal data? Embedding-only, prose-only, too slow and
  out-of-memory models are detected and reported with the reason.
- If the chosen model is missing or cannot cope, the best other installed model is used automatically (setting: "Use another
  installed model if needed"). If none can, the upload dialog says which models were tried and why each failed.
- Vision stays opt-in; only vision-capable models are used for images, and a text-only model chosen by mistake is swapped.
- Thinking models (deepseek-r1, qwen3, gpt-oss): thinking is switched off so the 250-token answer budget is not eaten;
  <think> blocks are stripped from streamed answers.
- Handles Ollama error bodies (400 "does not support generate", 500 "requires more memory"), format fallback schema -> json -> none.
- Settings: "Scan all installed models" button, per-model verdict, "Use as text model".

## Other fixes
- manifest version was 3.2.0 in a 4.1 build.
- PDFs with CID fonts returned glyph IDs that counted as "readable text" and passed as safe. Now detected and the user is asked.
- AI is no longer sent unreadable PDF text.
- Settings compatibility report built model names into innerHTML; now uses DOM text nodes.
- Upload-time status verifies a model before naming it, so the label is never a guess.

## Tests (node tests/<file>)
detectors.test.js (address + regressions), models.test.js (fake Ollama, 8 scenarios), engine.e2e.test.js, content.boot.test.js
