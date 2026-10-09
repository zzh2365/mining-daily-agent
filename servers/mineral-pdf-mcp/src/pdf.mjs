// Text-layer extraction via pdfjs-dist (legacy build = plain CommonJS, no canvas needed).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Silence optional-polyfill warnings (canvas/DOMMatrix are only needed for rendering).
const realWarn = console.warn;
console.warn = () => {};

const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

console.warn = realWarn;

export async function extractPdfLines(buffer, { maxPages = 20 } = {}) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const pages = [];
  const total = Math.min(doc.numPages, maxPages);
  try {
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      // Group glyphs by text baseline, then order left-to-right -> reconstruct lines.
      const rows = new Map();
      for (const item of tc.items) {
        if (typeof item.str !== "string" || item.str.trim() === "") continue;
        const y = Math.round(item.transform[5] / 3) * 3;
        const row = rows.get(y) ?? [];
        row.push({ x: item.transform[4], str: item.str, w: item.width ?? 0 });
        rows.set(y, row);
      }
      const lines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0]) // top of page first
        .map(([, row]) => {
          row.sort((a, b) => a.x - b.x);
          let out = "";
          let prevEnd = null;
          for (const seg of row) {
            if (prevEnd !== null && seg.x - prevEnd > 1.2) out += "  ";
            out += seg.str;
            prevEnd = seg.x + seg.w;
          }
          return out.replace(/[ \t]+/g, " ").trim();
        })
        .filter(Boolean);
      pages.push({ page: i, lines });
    }
  } finally {
    await doc.destroy?.().catch(() => {});
  }

  const lines = pages.flatMap((p) => p.lines);
  return { lines, text: lines.join("\n"), pageCount: pages.length, numPages: doc.numPages };
}
