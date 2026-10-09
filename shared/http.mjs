import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const CACHE_DIR =
  process.env.MCP_CACHE_DIR ?? join(homedir() || tmpdir(), ".mcp-mining-cache");

const UA =
  process.env.MCP_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

export async function httpGet(url, { timeoutMs = 15000, headers = {}, as = "text" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "*/*", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const body =
      as === "buffer" ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { body, contentType: res.headers.get("content-type") ?? "", finalUrl: res.url };
  } finally {
    clearTimeout(t);
  }
}

// Fetch with on-disk TTL cache; on failure return stale cache if any.
export async function cachedGet(url, ttlMs, opts = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const key = join(CACHE_DIR, sha1(url) + (opts.as === "buffer" ? ".bin" : ".txt"));
  try {
    const st = await stat(key);
    if (Date.now() - st.mtimeMs < ttlMs) {
      return { body: await readFile(key, opts.as === "buffer" ? undefined : "utf8"), fromCache: true };
    }
  } catch {}
  try {
    const { body } = await httpGet(url, opts);
    await writeFile(key, body).catch(() => {});
    return { body, fromCache: false };
  } catch (err) {
    try {
      return { body: await readFile(key, opts.as === "buffer" ? undefined : "utf8"), fromCache: true, stale: true };
    } catch {
      throw err;
    }
  }
}

import { stat } from "node:fs/promises";

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const JUNK_PATTERNS = [
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<noscript[\s\S]*?<\/noscript>/gi,
  /\{\{[\s\S]{0,80}?\}\}/g,          // client-side template placeholders
  /['"]?\w+['"]?\s*:\s*['"][^'"]*['"]\s*[:=]/g, // leaked JSON fragments: "show" : '' :
  /\bfunction\s*\([^)]*\)\s*\{[\s\S]{0,200}?\}/g,
];

export function cleanText(s) {
  let out = s;
  for (const re of JUNK_PATTERNS) out = out.replace(re, " ");
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const NAV_JUNK =
  /^(view more results|subscribe|sign ?up|cookie|privacy policy|follow us|share |related( articles| posts)?|read more|advertisement|menu|home|about the author|comments?|table of contents)\b/i;

function trimNav(text) {
  return text
    .split(/\n/)
    .filter((line) => line.trim() && !NAV_JUNK.test(line.trim()))
    .join("\n")
    .trim();
}

function paragraphsToText(html) {
  const blocks = html.match(/<p[\s>][\s\S]*?<\/p>/gi) ?? [];
  return cleanText(
    decodeEntities(
      blocks
        .map((b) => b.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 40)
        .join("\n")
    )
  );
}

// Pulls the article body rather than the whole page: JSON-LD is the cleanest
// source, then <p> blocks inside the main content container.
export function extractReadable(html) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const nodes = JSON.parse(m[1].trim());
      for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
        const body = node?.articleBody || node?.text;
        if (typeof body === "string" && body.trim().length > 200) {
          return { text: trimNav(cleanText(decodeEntities(body))), by: "json-ld:articleBody", date: node?.datePublished ?? null, author: node?.author?.name ?? null };
        }
      }
    } catch {}
  }
  const containers = html.match(/<article[\s>][\s\S]*?<\/article>/i);
  const scope = containers ? containers[0] : html;
  const text = trimNav(paragraphsToText(scope));
  if (text.length > 200) return { text, by: containers ? "paragraphs:article" : "paragraphs:page", date: null, author: null };
  return { text, by: containers ? "paragraphs:article" : "paragraphs:page", date: null, author: null };
}
