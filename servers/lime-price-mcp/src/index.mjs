#!/usr/bin/env node
// lime-price-mcp — commodity price & trend MCP server
// Tools: get_price(commodity, date), get_trend(commodity, days)
//
// Data plane: a deterministic series (seeded by commodity+date) so demo runs are
// reproducible. Set PRICE_API_URL to an endpoint returning
//   { "prices": [ { date, price } ] }   to serve a real feed instead.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log } from "../../../shared/log.mjs";
import { httpGet } from "../../../shared/http.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const REGISTRY = JSON.parse(await readFile(join(ROOT, "fixtures", "commodities.json"), "utf8"));
const LIVE_URL = process.env.PRICE_API_URL ?? null;

const DAY = 86400_000;
const DATA_NOTE = LIVE_URL
  ? `Live feed: ${LIVE_URL}`
  : "Deterministic synthetic series seeded by commodity+date (reproducible demo data). Set PRICE_API_URL to plug in a licensed feed.";

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toIso(d) {
  return d.toISOString().slice(0, 10);
}
function fromIso(s) {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date '${s}', expected YYYY-MM-DD`);
  return d;
}
function daysBetween(a, b) {
  return Math.round((b - a) / DAY);
}

function seededUnit(str) {
  const h = createHash("sha256").update(str).digest();
  return ((h[0] << 16) | (h[1] << 8) | h[2]) / 0xffffff;
}

function lookup(def, date) {
  const days = daysBetween(fromIso(def.anchor_date), fromIso(date));
  const slow = 0.16 * Math.sin((days + def.anchor_price % 90) / 233) + 0.09 * Math.sin(days / 61);
  const noise = (seededUnit(`${def.id}@${date}`) - 0.5) * 2 * def.vol * 2.2;
  return Math.max(def.anchor_price * (1 + slow + noise) * 0.92, def.anchor_price * 0.15);
}

function resolveCommodity(input) {
  const q = input.trim().toLowerCase();
  return (
    REGISTRY.find((d) => d.id === q) ??
    REGISTRY.find((d) => d.name.toLowerCase() === q) ??
    REGISTRY.find((d) => d.aliases.some((a) => a.toLowerCase() === q)) ??
    REGISTRY.find((d) => d.name.toLowerCase().includes(q) || d.aliases.some((a) => a.toLowerCase().includes(q))) ??
    null
  );
}

function fmt(v, digits = 2) {
  return Number(v.toFixed(digits));
}

function stats(series) {
  const vals = series.map((p) => p.price);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const up = vals.filter((v, i) => i && v > vals[i - 1]).length;
  const down = vals.filter((v, i) => i && v < vals[i - 1]).length;
  const changePct = ((last - first) / first) * 100;
  const dir = changePct > 1.5 ? "up" : changePct < -1.5 ? "down" : "sideways";
  return {
    start: fmt(first),
    latest: fmt(last),
    change_pct: fmt(changePct),
    direction: dir,
    mean: fmt(mean),
    min: fmt(min),
    max: fmt(max),
    stdev: fmt(sd),
    cv_pct: fmt((sd / mean) * 100),
    up_days: up,
    down_days: down,
  };
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
function sparkline(vals, width = 48) {
  if (!vals.length) return "";
  const step = Math.max(1, Math.floor(vals.length / width));
  const sampled = vals.filter((_, i) => i % step === 0);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  return sampled
    .map((v) => SPARK[max === min ? 4 : Math.round(((v - min) / (max - min)) * 7)])
    .join("");
}

async function liveSeries(def, dates) {
  const { body } = await httpGet(`${LIVE_URL}${LIVE_URL.includes("?") ? "&" : "?"}commodity=${encodeURIComponent(def.id)}&days=${dates.length}`, {
    timeoutMs: 12000,
  });
  const json = JSON.parse(body);
  const map = new Map((json.prices ?? []).map((p) => [p.date, Number(p.price)]));
  const out = dates.map((d) => ({ date: d, price: map.get(d) })).filter((p) => p.price != null);
  if (out.length < Math.min(3, dates.length)) throw new Error("live feed returned too few points");
  return out;
}

const server = new McpServer(
  { name: "lime-price-mcp", version: "1.0.0" },
  {
    instructions:
      "Commodity price quotes for battery/energy-transition metals. get_price(commodity, date) for a point quote, " +
      "get_trend(commodity, days) for a series with change %, volatility and a sparkline. Commodity accepts names or " +
      "aliases such as 'spodumene', 'SC6.0', 'lithium hydroxide', '碳酸锂'.",
  }
);

server.registerTool(
  "get_price",
  {
    title: "Get a commodity price quote",
    description:
      "Return the quote for one commodity on a given date (defaults to today), with the previous-day close and " +
      "day-on-day change. Commodity matching accepts aliases like 'spodumene', 'SC6.0', '氢氧化锂'.",
    inputSchema: {
      commodity: z.string().describe("Commodity name or alias, e.g. 'spodumene', 'lithium hydroxide', '碳酸锂'"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Quote date YYYY-MM-DD (default: today UTC)"),
    },
  },
  async ({ commodity, date }) => {
    const def = resolveCommodity(commodity);
    if (!def) {
      return textResult({
        error: `unknown commodity '${commodity}'`,
        available: REGISTRY.map((d) => ({ id: d.id, name: d.name, aliases: d.aliases })),
      });
    }
    const iso = date ?? toIso(new Date());
    const prev = toIso(new Date(fromIso(iso).getTime() - DAY));
    try {
      let price, prevPrice, source = LIVE_URL ? "live_api" : "deterministic_series";
      if (LIVE_URL) {
        const pts = await liveSeries(def, [prev, iso]);
        const m = new Map(pts.map((p) => [p.date, p.price]));
        price = m.get(iso) ?? lookup(def, iso);
        prevPrice = m.get(prev) ?? price;
      } else {
        price = lookup(def, iso);
        prevPrice = lookup(def, prev);
      }
      return textResult({
        commodity: def.name,
        commodity_id: def.id,
        date: iso,
        price: fmt(price),
        unit: def.unit,
        incoterm: def.incoterm,
        currency: def.currency,
        previous_close: fmt(prevPrice),
        change_pct: fmt(((price - prevPrice) / prevPrice) * 100),
        source,
        data_note: DATA_NOTE,
        notes: def.notes,
      });
    } catch (err) {
      return textResult({ commodity: def.name, date: iso, error: err.message });
    }
  }
);

server.registerTool(
  "get_trend",
  {
    title: "Get a commodity price trend",
    description:
      "Return a daily price series for the last N days plus derived analytics: % change, direction, mean, range, " +
      "coefficient of variation, up/down day counts and an ASCII sparkline for quick reading.",
    inputSchema: {
      commodity: z.string().describe("Commodity name or alias"),
      days: z.number().int().min(5).max(365).default(30).describe("Lookback window in days (default 30)"),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Window end date YYYY-MM-DD (default: today UTC)"),
      include_series: z.boolean().default(true).describe("Include the full daily series"),
    },
  },
  async ({ commodity, days, end_date, include_series }) => {
    const def = resolveCommodity(commodity);
    if (!def) return textResult({ error: `unknown commodity '${commodity}'` });
    const end = fromIso(end_date ?? toIso(new Date()));
    const dates = Array.from({ length: days }, (_, i) => toIso(new Date(end.getTime() - (days - 1 - i) * DAY)));
    try {
      const series = (LIVE_URL ? await liveSeries(def, dates) : dates.map((d) => ({ date: d, price: fmt(lookup(def, d)) })))
        .sort((a, b) => a.date.localeCompare(b.date));
      const s = stats(series);
      return textResult({
        commodity: def.name,
        commodity_id: def.id,
        unit: def.unit,
        incoterm: def.incoterm,
        window: { from: dates[0], to: dates[dates.length - 1], days: series.length },
        ...s,
        sparkline: sparkline(series.map((p) => p.price)),
        ...(include_series ? { series } : {}),
        source: LIVE_URL ? "live_api" : "deterministic_series",
        data_note: DATA_NOTE,
      });
    } catch (err) {
      return textResult({ commodity: def.name, error: err.message, data_note: DATA_NOTE });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`lime-price-mcp ready (${LIVE_URL ? "live feed" : "deterministic series"})`);
