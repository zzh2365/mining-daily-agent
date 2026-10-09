#!/usr/bin/env node
// mining-news-mcp — news aggregation MCP server
// Tools: search(query, days), fetch_article(url)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cachedGet, extractReadable } from "../../../shared/http.mjs";
import { parseFeed } from "../../../shared/rss.mjs";
import { log } from "../../../shared/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const FEEDS = [
  { source: "MINING.com", url: "https://www.mining.com/feed/" },
  { source: "Australian Mining", url: "https://www.australianmining.com.au/feed/" },
];
const FEED_TTL_MS = 30 * 60 * 1000;
const MODE = process.env.NEWS_MODE || "auto"; // auto | live | fixture

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

async function loadLiveArticles() {
  const all = [];
  for (const feed of FEEDS) {
    try {
      const { body, stale } = await cachedGet(feed.url, FEED_TTL_MS);
      const items = parseFeed(body).map((it) => ({ ...it, source: feed.source, stale: !!stale }));
      all.push(...items);
      log(`feed ${feed.url}: ${items.length} items${stale ? " (stale cache)" : ""}`);
    } catch (err) {
      log(`feed ${feed.url} failed: ${err.message}`);
    }
  }
  return all;
}

async function loadFixtureArticles() {
  const raw = await readFile(join(ROOT, "fixtures", "news.json"), "utf8");
  return JSON.parse(raw).map((it) => ({
    title: it.title,
    url: it.url,
    summary: it.summary,
    published_at: it.published_at ?? null,
    source: it.source ?? "Fixture",
  }));
}

async function getArticles() {
  if (MODE !== "fixture") {
    const live = await dedupeByTitle(await loadLiveArticles());
    if (live.length) return { articles: live, degraded: false };
    if (MODE === "live") return { articles: [], degraded: true };
  }
  return { articles: await loadFixtureArticles(), degraded: MODE !== "fixture" };
}

// Feed syndication repeats the same story as an article + a roundup link.
function dedupeByTitle(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "at", "by",
  "from", "is", "are", "was", "were", "it", "its", "as", "be", "has", "have", "will",
  "mining", "news", "latest", "about", "give", "me", "generate", "report",
]);

function tokenize(query) {
  const ascii = (query.toLowerCase().match(/[a-z][a-z0-9\-]{1,}/g) ?? []).filter((w) => !STOP.has(w));
  const cjk = query.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set([...ascii, ...cjk])];
}

function scoreArticle(article, terms) {
  const title = article.title.toLowerCase();
  const body = (article.summary ?? "").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 3;
    const n = body.split(t).length - 1;
    s += Math.min(n, 3);
  }
  return s;
}

const server = new McpServer(
  { name: "mining-news-mcp", version: "1.0.0" },
  {
    instructions:
      "News aggregation for mining/commodities. Use search(query, days) to find articles, then fetch_article(url) on the most relevant links to read full text before writing a briefing.",
  }
);

server.registerTool(
  "search",
  {
    title: "Search mining news",
    description:
      "Search recent mining industry news across aggregated RSS feeds. Returns ranked headlines with URLs, dates and short summaries. Follow up with fetch_article(url) for full text.",
    inputSchema: {
      query: z.string().describe("Keywords, e.g. 'Pilbara lithium' or '锂矿'"),
      days: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(7)
        .describe("Only return articles published within the last N days (default 7)"),
      limit: z.number().int().min(1).max(25).default(8).describe("Max results"),
    },
  },
  async ({ query, days, limit }) => {
    const { articles, degraded } = await getArticles();
    const cutoff = Date.now() - days * 86400_000;
    const terms = tokenize(query);
    const scored = articles
      .filter((a) => !a.published_at || new Date(a.published_at).getTime() >= cutoff)
      .map((a) => ({ a, s: scoreArticle(a, terms) }))
      .filter((x) => x.s > 0)
      .sort(
        (x, y) =>
          y.s - x.s ||
          new Date(y.a.published_at ?? 0) - new Date(x.a.published_at ?? 0)
      )
      .slice(0, limit)
      .map(({ a, s }) => ({
        title: a.title,
        url: a.url,
        source: a.source,
        published_at: a.published_at,
        relevance: s,
        summary: (a.summary ?? "").slice(0, 480),
      }));
    return textResult({
      query,
      days,
      count: scored.length,
      data_note: degraded
        ? "Live feeds unavailable; serving offline Pilbara case fixtures."
        : "Live RSS results.",
      results: scored,
    });
  }
);

server.registerTool(
  "fetch_article",
  {
    title: "Fetch full article text",
    description:
      "Fetch an article by URL and return readable plain text (title, date, body excerpt). Use URLs returned by search.",
    inputSchema: {
      url: z.string().url().describe("Absolute article URL"),
      max_chars: z.number().int().min(500).max(20000).default(6000).describe("Max characters of body text"),
    },
  },
  async ({ url, max_chars }) => {
    try {
      const { body } = await cachedGet(url, FEED_TTL_MS, { timeoutMs: 15000 });
      const readable = extractReadable(body);
      const text = readable.text.slice(0, max_chars);
      if (text.length < 120) throw new Error("page yielded no article body");
      const { articles } = await getArticles().catch(() => ({ articles: [] }));
      const match = articles.find((a) => a.url === url);
      return textResult({
        url,
        title: match?.title ?? null,
        published_at: match?.published_at ?? readable.date ?? null,
        author: readable.author ?? null,
        extraction: readable.by,
        text,
        truncated: text.length >= max_chars,
      });
    } catch (err) {
      const { articles } = await getArticles().catch(() => ({ articles: [] }));
      const match = articles.find((a) => a.url === url);
      if (match) {
        return textResult({
          url,
          title: match.title,
          published_at: match.published_at,
          text: match.summary,
          note: `Live fetch failed (${err.message}); returned cached/fixture summary instead.`,
        });
      }
      return textResult({ url, error: `fetch failed: ${err.message}`, text: null });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`mining-news-mcp ready (mode=${MODE})`);
