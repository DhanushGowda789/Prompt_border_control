/* Void — local file helpers. No libraries: uses the browser's own
   DecompressionStream, so there is nothing to download or bundle. */
(() => {
  "use strict";
  const root = typeof self !== "undefined" ? self : globalThis;
  const K = (root.VoidKit = root.VoidKit || {});

  const MAX_ENTRY = 40 * 1024 * 1024;   // per zip entry, after inflating
  const MAX_TOTAL = 80 * 1024 * 1024;   // per archive, after inflating

  async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---- ZIP (docx / xlsx / pptx / odt ...) ---------------------------------
  function zipIndex(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a valid zip container");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
      entries.set(name, { method, csize, usize, off });
      p += 46 + nlen + elen + clen;
    }
    return { entries, dv };
  }

  async function zipRead(u8, dv, e) {
    if (e.usize > MAX_ENTRY) throw new Error("Zip entry too large");
    if (dv.getUint32(e.off, true) !== 0x04034b50) throw new Error("Corrupt zip entry");
    const nlen = dv.getUint16(e.off + 26, true);
    const elen = dv.getUint16(e.off + 28, true);
    const start = e.off + 30 + nlen + elen;
    const data = u8.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflate(data, "deflate-raw");
    throw new Error("Unsupported zip compression");
  }

  function xmlToText(xml) {
    return xml
      .replace(/<\/(?:w:p|a:p|text:p|text:h|row|si|table:table-row)>/g, "\n")
      .replace(/<(?:w:tab|w:br|text:tab|text:line-break)\b[^>]*\/>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ");
  }

  const OFFICE_PARTS = {
    docx: /^word\/(?:document|footnotes|endnotes|header\d*|footer\d*|comments)\.xml$/i,
    pptx: /^ppt\/(?:slides|notesSlides)\/[^/]+\.xml$/i,
    xlsx: /^xl\/(?:sharedStrings|worksheets\/[^/]+)\.xml$/i,
    odt: /^content\.xml$/i, ods: /^content\.xml$/i, odp: /^content\.xml$/i
  };

  async function officeText(file, ext) {
    const re = OFFICE_PARTS[ext];
    if (!re) throw new Error("Unsupported Office format");
    const u8 = new Uint8Array(await file.arrayBuffer());
    const { entries, dv } = zipIndex(u8);
    let total = 0;
    const parts = [];
    for (const [name, e] of entries) {
      if (!re.test(name)) continue;
      total += e.usize;
      if (total > MAX_TOTAL) throw new Error("Archive expands too much");
      parts.push(xmlToText(new TextDecoder().decode(await zipRead(u8, dv, e))));
    }
    return parts.join("\n");
  }

  // ---- PDF (best effort: text PDFs with simple fonts) ----------------------
  function pdfString(s) {
    return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, c) => {
      if (c === "n") return "\n"; if (c === "r") return "\r"; if (c === "t") return "\t";
      if (c === "b" || c === "f") return "";
      if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
      if (c[0] === "\r" || c[0] === "\n") return "";
      return c;
    });
  }

  function hexDecode(h) {
    const clean = h.replace(/\s+/g, "");
    if (!clean) return "";
    const padded = clean.length % 2 === 1 ? clean + "0" : clean;
    let s = "";
    for (let i = 0; i < padded.length; i += 2) {
      s += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
    }
    return s;
  }

  function decodePdfString(s) {
    if (s.length >= 2 && s.charCodeAt(0) === 254 && s.charCodeAt(1) === 255) {
      let out = "";
      for (let i = 2; i < s.length; i += 2) {
        if (i + 1 < s.length) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
      }
      return out;
    }
    return s.replace(/\0/g, "");
  }

  function pdfTextFromContent(src) {
    const out = [];
    const itemRe = /\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>|(-?\d+(?:\.\d+)?)/g;
    const opRe = /\[((?:\\.|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]+)>\s*(?:Tj|'|")|(?:T\*|(?:ET|Td|TD)\b)/g;
    let m;
    while ((m = opRe.exec(src)) !== null) {
      if (m[0] === "T*" || m[0] === "ET" || m[0] === "Td" || m[0] === "TD") {
        out.push("\n");
        continue;
      }
      if (m[1] !== undefined) {
        let s; itemRe.lastIndex = 0; const bits = [];
        while ((s = itemRe.exec(m[1])) !== null) {
          if (s[1] !== undefined) bits.push(decodePdfString(pdfString(s[1])));
          else if (s[2] !== undefined) bits.push(decodePdfString(hexDecode(s[2])));
          else if (s[3] !== undefined && parseFloat(s[3]) < -150) bits.push(" ");
        }
        out.push(bits.join(""), " ");
      } else if (m[2] !== undefined) {
        out.push(decodePdfString(pdfString(m[2])), " ");
      } else if (m[3] !== undefined) {
        out.push(decodePdfString(hexDecode(m[3])), " ");
      }
    }
    return out.join("");
  }

  async function pdfText(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const src = new TextDecoder("latin1").decode(u8);
    const parts = [];
    const meta = /\/(?:Author|Title|Subject|Keywords)\s*(?:\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>)/g;
    let mm; while ((mm = meta.exec(src)) !== null) parts.push(mm[1] !== undefined ? pdfString(mm[1]) : hexDecode(mm[2]));
    const streamRe = /<<((?:(?!>>)[\s\S]){0,2000})>>\s*stream\r?\n/g;
    let m, n = 0, total = 0;
    while ((m = streamRe.exec(src)) !== null && n < 600) {
      const dict = m[1];
      const bodyStart = streamRe.lastIndex;
      const end = src.indexOf("endstream", bodyStart);
      if (end < 0) break;
      if (/\/(?:Image|XObject|FontFile|ObjStm)/.test(dict)) { streamRe.lastIndex = end; continue; }
      let bytes = u8.subarray(bodyStart, end);
      if (/\/FlateDecode/.test(dict)) {
        // PDFs put an end-of-line marker before "endstream". The deflate decoder
        // rejects trailing bytes, but the last data byte can legitimately look
        // like a newline, so try the likely trims in order.
        let out = null;
        for (const cut of [2, 1, 0]) {
          try { out = await inflate(bytes.subarray(0, bytes.length - cut), "deflate"); break; } catch (_) {}
        }
        if (!out) { streamRe.lastIndex = end; continue; }
        bytes = out;
      } else if (/\/Filter/.test(dict)) { streamRe.lastIndex = end; continue; }
      total += bytes.length; n++;
      if (total > MAX_TOTAL) break;
      parts.push(pdfTextFromContent(new TextDecoder("latin1").decode(bytes)));
      streamRe.lastIndex = end;
    }
    return parts.join("\n");
  }

  /** PDFs with embedded CID fonts give glyph numbers, not letters. Real text is mostly letters, digits and spaces. */
  function looksLikeText(text) {
    const s = String(text || "").slice(0, 20000);
    const n = s.replace(/\s+/g, "").length;
    if (n < 30) return false;
    let good = 0;
    for (const ch of s) if (/[\p{L}\p{N}\s.,:;\/@()\-_'"&%+#]/u.test(ch)) good++;
    return good / s.length > 0.85;
  }

  // ---- images --------------------------------------------------------------
  function bytesToBase64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** JPEG EXIF check: { exif, gps }. Other formats return {exif:false,gps:false}. */
  function exifInfo(u8) {
    const res = { exif: false, gps: false };
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return res;
    let p = 2;
    while (p + 4 < u8.length) {
      if (u8[p] !== 0xff) break;
      const marker = u8[p + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const len = (u8[p + 2] << 8) | u8[p + 3];
      if (marker === 0xe1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78) { // "Ex"
        res.exif = true;
        const t = p + 10;
        const dv = new DataView(u8.buffer, u8.byteOffset + t, Math.max(0, u8.length - t));
        try {
          const le = dv.getUint16(0) === 0x4949;
          let ifd = dv.getUint32(4, le);
          const cnt = dv.getUint16(ifd, le);
          for (let i = 0; i < cnt; i++) {
            if (dv.getUint16(ifd + 2 + i * 12, le) === 0x8825) { res.gps = true; break; }
          }
        } catch (_) { /* truncated EXIF: leave gps=false */ }
        break;
      }
      p += 2 + len;
    }
    return res;
  }

  async function drawToBlob(file, maxSide, type, quality) {
    const bmp = await createImageBitmap(file);
    try {
      let w = bmp.width, h = bmp.height;
      if (maxSide && Math.max(w, h) > maxSide) {
        const r = maxSide / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r);
      }
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      return await canvas.convertToBlob({ type, quality });
    } finally { bmp.close?.(); }
  }

  /** Re-encode to drop EXIF/GPS/text chunks. JPEG, PNG and WebP only. */
  async function sanitizeImage(file) {
    const type = /^image\/(png|webp)$/.test(file.type) ? file.type : "image/jpeg";
    const blob = await drawToBlob(file, 0, type, 0.92);
    if (!blob || !blob.size) throw new Error("Re-encode failed");
    return new File([blob], file.name, { type: blob.type || type, lastModified: Date.now() });
  }

  /** Small JPEG for the vision model: faster and lighter than full size. */
  async function imageForModel(file, maxSide = 1024) {
    const blob = await drawToBlob(file, maxSide, "image/jpeg", 0.85);
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }

  K.files = { officeText, pdfText, looksLikeText, exifInfo, sanitizeImage, imageForModel, bytesToBase64, xmlToText, pdfTextFromContent };
  if (typeof module !== "undefined" && module.exports) module.exports = K.files;
})();
