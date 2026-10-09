import { log } from "../../shared/log.mjs";

const COMMODITY_KEYS = [
  { re: /锂|lithium|spodumene|pgb100|hydroxide|碳酸/i, ids: ["spodumene_6pct", "lithium_hydroxide_cif"] },
  { re: /镍|nickel/i, ids: ["nickel_ttf"] },
  { re: /钴|cobalt/i, ids: ["cobalt_standard"] },
  { re: /铜|copper/i, ids: ["copper_lme"] },
  { re: /铁|iron\s*ore/i, ids: ["iron_ore_62"] },
  { re: /稀土|rare\s*earth|ndpr/i, ids: ["ndprO_reo"] },
];

const STOP = /最新|今日|价格|趋势|风险|储量|报告|简报|关于|请|帮我|生成|一份|the|for|and|with|about|latest|today|price|report/i;

export function intent(query) {
  const ids = [];
  for (const k of COMMODITY_KEYS) if (k.re.test(query)) ids.push(...k.ids);
  const regions = [
    ...new Set(
      (
        query.match(
          /Pilbara|Kwinana|Greenbushes|Wodgina|Cattlin|Ngungaju|Egno|Western Australia|Guanfeng|\bPLS\b|赣锋|天齐|宁德|Sichuan|Jiangxi/gi
        ) ?? []
      ).map((s) => s.trim())
    ),
  ];
  const english = [...new Set((query.match(/[A-Za-z][A-Za-z0-9.\-]{2,}/g) ?? [])
    .filter((w) => !STOP.test(w) && !["with", "about", "today", "report", "give", "me"].includes(w.toLowerCase())))].slice(0, 6);
  const cjk = [...new Set((query.match(/[一-龥]{2,8}/g) ?? []).filter((w) => !STOP.test(w)))].slice(0, 4);
  // English feeds rank better on latin keywords; CJK terms are the fallback.
  const keywords = [...new Set([...regions, ...english, ...(english.length ? [] : cjk)])];
  return { ids, regions, english, cjk, keywords };
}

export function buildSearchQuery(query, it) {
  const commodityWord = it.ids[0] === "spodumene_6pct" ? "lithium" : it.ids[0]?.split("_")[0] ?? "mining";
  const head = it.keywords.slice(0, 3).join(" ");
  if (head && /[a-z]/i.test(head)) return `${head} ${commodityWord}`.replace(/\s+/g, " ").trim();
  if (head) return `${head} ${commodityWord} mining`;
  return `${query.slice(0, 60)} mining`;
}

export function makeTrace() {
  const trace = [];
  return {
    entries: trace,
    async run(display, args, fn) {
      const t0 = Date.now();
      try {
        const out = await fn();
        trace.push({ tool: display, args, ok: !out?.isError, ms: Date.now() - t0 });
        return out;
      } catch (err) {
        log(`tool ${display} failed: ${err.message}`);
        trace.push({ tool: display, args, ok: false, error: err.message, ms: Date.now() - t0 });
        return { data: null, isError: true, error: err.message };
      }
    },
  };
}

// Deterministic orchestration: the minimum evidence set a mining briefing needs.
export async function planAndGather(hub, query, opts) {
  const it = intent(query);
  const trace = makeTrace();
  const searchQ = buildSearchQuery(query, it);
  const days = opts.days ?? 7;
  const commodityIds = it.ids.length ? it.ids : ["spodumene_6pct"];
  const pdfRefs = opts.pdfUrls?.length ? opts.pdfUrls : ["fixture:pilbara_ni43101_sample"];

  const news = await trace.run("mining-news-mcp.search", { query: searchQ, days, limit: 8 }, () =>
    hub.call("mining-news-mcp__search", { query: searchQ, days, limit: 8 })
  );
  const results = news.data?.results ?? [];
  const fetched = [];
  for (const r of results.slice(0, opts.maxArticles ?? 3)) {
    const art = await trace.run("mining-news-mcp.fetch_article", { url: r.url }, () =>
      hub.call("mining-news-mcp__fetch_article", { url: r.url, max_chars: 4000 })
    );
    if (art.data) fetched.push({ ...art.data, source: r.source, published_at: r.published_at });
  }

  const pdfs = [];
  for (const ref of pdfRefs) {
    const res = await trace.run("mineral-pdf-mcp.extract_resources", { pdf_url: ref }, () =>
      hub.call("mineral-pdf-mcp__extract_resources", { pdf_url: ref, max_pages: 25 })
    );
    if (res.data) pdfs.push(res.data);
  }

  const prices = [];
  const trends = [];
  for (const id of commodityIds.slice(0, 3)) {
    const p = await trace.run("lime-price-mcp.get_price", { commodity: id }, () =>
      hub.call("lime-price-mcp__get_price", { commodity: id, ...(opts.date ? { date: opts.date } : {}) })
    );
    if (p.data) prices.push(p.data);
    const t = await trace.run("lime-price-mcp.get_trend", { commodity: id, days: opts.trendDays ?? 30 }, () =>
      hub.call("lime-price-mcp__get_trend", { commodity: id, days: opts.trendDays ?? 30, include_series: true })
    );
    if (t.data) trends.push(t.data);
  }

  return {
    mode: "deterministic-planner",
    query,
    search_query: searchQ,
    intent: it,
    news_results: results,
    articles: fetched,
    pdfs,
    prices,
    trends,
    trace: trace.entries,
  };
}
