#!/usr/bin/env node
// mining-agent — MCP client that orchestrates the three servers into a Markdown briefing.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { log } from "../../shared/log.mjs";
import { loadConfig, McpHub, ROOT } from "./mcp.mjs";
import { llmConfig } from "./llm.mjs";
import { llmGather } from "./react.mjs";
import { planAndGather } from "./planner.mjs";
import { assembleReport } from "./report.mjs";

function parseArgs(argv) {
  const opts = {
    config: join(ROOT, "mcp-config.json"),
    out: null,
    mode: process.env.AGENT_MODE ?? "auto",
    days: Number(process.env.AGENT_NEWS_DAYS ?? 7),
    trendDays: Number(process.env.AGENT_TREND_DAYS ?? 30),
    maxArticles: Number(process.env.AGENT_MAX_ARTICLES ?? 3),
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 8),
    pdfUrls: (process.env.REPORT_PDF_URLS ?? "").split(/\s*,\s*/).filter(Boolean),
    servers: (process.env.AGENT_SERVERS ?? "").split(/\s*,\s*/).filter(Boolean),
    json: false,
  };
  let query = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--query" || a === "-q") query = next();
    else if (a === "--config" || a === "-c") opts.config = resolve(next());
    else if (a === "--out" || a === "-o") opts.out = resolve(next());
    else if (a === "--mode") opts.mode = next();
    else if (a === "--days") opts.days = Number(next());
    else if (a === "--trend-days") opts.trendDays = Number(next());
    else if (a === "--max-articles") opts.maxArticles = Number(next());
    else if (a === "--max-steps") opts.maxSteps = Number(next());
    else if (a === "--pdf") opts.pdfUrls = opts.pdfUrls.concat(next());
    else if (a === "--servers") opts.servers = next().split(",").filter(Boolean);
    else if (a === "--json") opts.json = true;
    else if (a === "--serve") opts.serve = true;
    else if (a === "--list-tools") opts.listTools = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-") && !query) query = a;
    else throw new Error(`unexpected argument '${a}'`);
  }
  return { query, opts };
}

const HELP = `mining-agent — MCP-driven mining daily briefing

Usage:
  node agent/src/index.mjs [options] ["<briefing request>"]

Options:
  -q, --query <text>     Briefing request (default: Pilbara lithium daily briefing)
  -c, --config <path>    MCP config file (default: ./mcp-config.json)
  -o, --out <path>       Write Markdown here (default: agent/output/report-<ts>.md)
      --mode <m>         auto | llm | deterministic   (default auto: LLM if API key present)
      --pdf <url>        Technical-report PDF(s) to parse (repeatable, or REPORT_PDF_URLS=a,b)
      --days <n>         News lookback days (default 7)
      --trend-days <n>   Price window days (default 30)
      --max-articles <n> Articles to fetch in full (default 3)
      --max-steps <n>    ReAct tool-call rounds for LLM mode (default 8)
      --servers <a,b>    Restrict to these MCP servers
      --list-tools       Print the discovered tool catalogue and exit
      --serve            Interactive REPL: type a request, get a report
  -h, --help             Show this help

Environment:
  OPENAI_API_KEY / LLM_API_KEY, LLM_BASE_URL, LLM_MODEL   enable the ReAct (LLM) planner
  NEWS_MODE=auto|live|fixture, PRICE_API_URL, REPORT_PDF_URLS
`;

async function runOnce(hub, query, opts, cfg) {
  const useLlm = !!cfg && opts.mode !== "deterministic";
  let evidence;
  try {
    if (useLlm) {
      log(`mode: llm-react (${cfg.model})`);
      evidence = await llmGather(hub, query, cfg, opts);
      if (!evidence.news_results.length && !evidence.trends.length && !evidence.pdfs.length) {
        log("LLM gathered nothing usable; falling back to the deterministic planner");
        evidence = await planAndGather(hub, query, opts);
      }
    } else {
      log(`mode: deterministic-planner${cfg ? " (LLM only used for prose)" : " (no LLM configured)"}`);
      evidence = await planAndGather(hub, query, opts);
    }
  } catch (err) {
    log(`LLM path failed (${err.message.slice(0, 200)}); falling back to deterministic planner`);
    if (cfg) cfg.disabled = true; // don't retry the model for section prose either
    evidence = await planAndGather(hub, query, opts);
  }
  const { markdown, llmUsed } = await assembleReport(evidence, { cfg });
  return { markdown, evidence, llmUsed };
}

async function emit(outBase, { markdown, evidence, llmUsed }) {
  const base = outBase.replace(/\.md$/i, "");
  await mkdir(dirname(base), { recursive: true });
  await writeFile(`${base}.md`, markdown, "utf8");
  await writeFile(`${base}.evidence.json`, JSON.stringify(evidence, null, 2), "utf8");
  log(`report  -> ${base}.md${llmUsed ? " (LLM-authored prose)" : " (deterministic prose)"}`);
  log(`evidence-> ${base}.evidence.json`);
  process.stdout.write(`${markdown}\n`);
}

const { query, opts } = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const cfg = llmConfig();
if (opts.mode === "llm" && !cfg) {
  console.error("--mode llm requires OPENAI_API_KEY / LLM_API_KEY");
  process.exit(2);
}

const config = await loadConfig(resolve(opts.config));
const hub = new McpHub(config);
await hub.connect(opts.servers);

if (opts.listTools) {
  process.stdout.write(
    JSON.stringify(hub.tools.map((t) => ({ server: t.server, name: t.tool, description: t.description })), null, 2) + "\n"
  );
  await hub.close();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
if (opts.serve) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write("mining-agent REPL — type a briefing request (Ctrl-D to exit)\n");
  for (;;) {
    const line = (await rl.question("query> ")).trim();
    if (!line) break;
    const outBase = opts.out ? resolve(opts.out) : join(ROOT, "agent", "output", `report-${stamp}`);
    await emit(outBase, await runOnce(hub, line, opts, cfg));
  }
  await rl.close();
} else {
  const q = query ?? "给我生成一份关于 Pilbara 锂矿的今日简报";
  const outBase = opts.out ? resolve(opts.out) : join(ROOT, "agent", "output", `report-${stamp}`);
  await emit(outBase, await runOnce(hub, q, opts, cfg));
}

await hub.close();
