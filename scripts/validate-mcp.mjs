#!/usr/bin/env node
// Protocol-level smoke test: spawn every server over stdio, run initialize,
// tools/list and tools/call, and assert the payloads carry what the task asks for.
//   node scripts/validate-mcp.mjs                 # all servers
//   node scripts/validate-mcp.mjs lime-price-mcp  # one server
import { resolve } from "node:path";
import { log } from "../shared/log.mjs";
import { loadConfig, McpHub, ROOT } from "../agent/src/mcp.mjs";

const SAMPLE_CALLS = {
  "mining-news-mcp": [
    {
      tool: "search",
      args: { query: "Pilbara lithium", days: 14, limit: 3 },
      assert: (d) => (Array.isArray(d?.results) ? { ok: true, detail: `${d.results.length} hits (${d.data_note ?? "live"})` } : { ok: false, detail: "no results array" }),
    },
    {
      tool: "fetch_article",
      args: { url: "https://www.mining.com/feed/", max_chars: 1200 },
      assert: (d) => (d?.text ? { ok: true, detail: `${d.text.length} chars` } : { ok: false, detail: d?.error ?? "no text" }),
    },
  ],
  "mineral-pdf-mcp": [
    {
      tool: "extract_resources",
      args: { pdf_url: "fixture:pilbara_ni43101_sample", max_pages: 5 },
      assert: (d) => {
        const r = d?.resources;
        if (!r) return { ok: false, detail: d?.error ?? "no resources" };
        const need = ["Indicated", "Inferred"].filter((c) => r[c]?.tonnage_m_t == null);
        return need.length
          ? { ok: false, detail: `missing ${need.join(",")}` }
          : { ok: true, detail: `Indicated ${r.Indicated.tonnage_m_t} Mt @ ${r.Indicated.grade_pct}% / Inferred ${r.Inferred.tonnage_m_t} Mt @ ${r.Inferred.grade_pct}%` };
      },
    },
  ],
  "lime-price-mcp": [
    {
      tool: "get_price",
      args: { commodity: "spodumene" },
      assert: (d) => (d?.price != null ? { ok: true, detail: `${d.price} ${d.unit} on ${d.date}` } : { ok: false, detail: d?.error ?? "no price" }),
    },
    {
      tool: "get_trend",
      args: { commodity: "lithium hydroxide", days: 30, include_series: false },
      assert: (d) => (d?.series === undefined && d?.change_pct != null ? { ok: true, detail: `${d.commodity} ${d.change_pct}% (${d.direction})` } : { ok: false, detail: d?.error ?? "no stats" }),
    },
  ],
};

const REQUIRED_TOOLS = {
  "mining-news-mcp": ["search", "fetch_article"],
  "mineral-pdf-mcp": ["extract_resources"],
  "lime-price-mcp": ["get_price", "get_trend"],
};

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const config = await loadConfig(resolve(process.env.MCP_CONFIG ?? resolve(ROOT, "mcp-config.json")));
const names = Object.keys(config.servers).filter((n) => !only.length || only.includes(n));
let failures = 0;
const rows = [];

for (const name of names) {
  log(`--- ${name} ---`);
  const hub = new McpHub(config);
  try {
    await hub.connect([name]);
    const tools = hub.tools.filter((t) => t.server === name).map((t) => t.tool);
    const missing = (REQUIRED_TOOLS[name] ?? []).filter((t) => !tools.includes(t));
    if (missing.length) {
      failures++;
      rows.push([name, "tools/list", "FAIL", `missing ${missing.join(",")}`]);
    } else {
      rows.push([name, "tools/list", "PASS", tools.join(", ")]);
    }
    for (const call of SAMPLE_CALLS[name] ?? []) {
      const res = await hub.call(`${name}__${call.tool}`, call.args);
      const verdict = call.assert(res.data);
      if (!verdict.ok) failures++;
      rows.push([name, `tools/call ${call.tool}`, verdict.ok ? "PASS" : "FAIL", verdict.detail]);
    }
  } catch (err) {
    failures++;
    rows.push([name, "initialize", "FAIL", err.message.slice(0, 160)]);
  } finally {
    await hub.close();
  }
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const r of rows) {
  process.stdout.write(`${r[0].padEnd(w)}  ${r[1].padEnd(28)}  ${r[2].padEnd(4)}  ${r[3]}\n`);
}
process.stdout.write(`\n${failures ? `${failures} FAILURE(S)` : "ALL CHECKS PASSED"} — ${rows.length} checks over ${names.length} server(s)\n`);
process.exit(failures ? 1 : 0);
