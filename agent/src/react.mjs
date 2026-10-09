import { log } from "../../shared/log.mjs";
import { chat, toToolSpecs } from "./llm.mjs";
import { makeTrace } from "./planner.mjs";

const MAX_OBS_CHARS = 5000;

function systemPrompt(hub, query) {
  const toolList = hub.tools
    .map((t) => `- ${t.llmName}: ${t.description.split("\n")[0]}`)
    .join("\n");
  return [
    "You are the orchestration brain of a mining-industry daily briefing agent. You do not know mining facts from memory;",
    "everything in the report must come from a tool result you actually received.",
    "",
    "# Server instructions",
    hub.instructions() || "(none)",
    "",
    "# Tools",
    toolList,
    "",
    "# Task",
    `Produce the evidence for this briefing request: ${query}`,
    "Call tools (parallel where independent) until you have: (1) recent news on the topic, (2) at least one full article,",
    "(3) NI 43-101 mineral resource figures from a PDF, (4) a spot price and a 30-90 day trend for the relevant commodity.",
    "Prefer short JSON arguments exactly as the schemas require. When evidence is sufficient, stop calling tools and reply",
    "with a 2-4 sentence 'RESEARCH NOTES' paragraph: what the news says, what the resource data shows, what the price did,",
    "and the single biggest risk. Do not invent numbers.",
  ].join("\n");
}

function classify(obs, ev) {
  if (!obs || typeof obs !== "object" || Array.isArray(obs)) return;
  if (Array.isArray(obs.results)) {
    for (const r of obs.results) {
      if (r?.url && !ev.news_results.some((x) => x.url === r.url)) ev.news_results.push(r);
    }
    return;
  }
  if (typeof obs.url === "string" && typeof obs.text === "string") {
    if (!ev.articles.some((a) => a.url === obs.url)) {
      ev.articles.push({ ...obs, excerpt: obs.text.slice(0, 900) });
    }
    return;
  }
  if (obs.resources || obs.risk_flags) {
    if (!ev.pdfs.some((p) => p.source?.resolved === obs.source?.resolved)) ev.pdfs.push(obs);
    return;
  }
  if (obs.window && obs.series) {
    if (!ev.trends.some((t) => t.commodity_id === obs.commodity_id)) ev.trends.push(obs);
    return;
  }
  if (obs.price !== undefined && obs.unit) {
    if (!ev.prices.some((p) => p.commodity_id === obs.commodity_id)) ev.prices.push(obs);
    return;
  }
  for (const v of Object.values(obs)) {
    if (v && typeof v === "object") classify(v, ev);
  }
}

export async function llmGather(hub, query, cfg, opts) {
  const messages = [
    { role: "system", content: systemPrompt(hub, query) },
    { role: "user", content: `Build the evidence pack for: ${query}` },
  ];
  const tools = toToolSpecs(hub.tools);
  const trace = makeTrace();
  const observations = [];
  let notes = null;
  const maxSteps = opts.maxSteps ?? 8;

  for (let step = 0; step < maxSteps; step++) {
    const json = await chat(cfg, { messages, tools });
    const msg = json.choices?.[0]?.message ?? {};
    const calls = (msg.tool_calls ?? []).filter((c) => c.function?.name);
    if (!calls.length) {
      notes = (msg.content ?? "").trim() || null;
      break;
    }
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch (err) {
        log(`bad tool args from LLM: ${err.message}`);
      }
      const out = await trace.run(call.function.name, args, () => hub.call(call.function.name, args));
      const payload = out.data ?? { error: out.error ?? "no result" };
      const text = JSON.stringify(payload).slice(0, MAX_OBS_CHARS);
      observations.push(payload);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: text,
      });
    }
  }

  if (!notes && observations.length) {
    // No closing remark: ask once, without tools, so the notes are still evidence-grounded.
    try {
      const json = await chat(cfg, {
        messages: [
          ...messages,
          { role: "user", content: "Stop calling tools. Write the 2-4 sentence RESEARCH NOTES from the tool results above." },
        ],
        tools: undefined,
        tool_choice: undefined,
        max_tokens: 700,
      });
      notes = json.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
      log(`notes pass failed: ${err.message}`);
    }
  }

  const evidence = { news_results: [], articles: [], pdfs: [], prices: [], trends: [] };
  for (const obs of observations) classify(obs, evidence);

  return {
    mode: "llm-react",
    query,
    search_query: null,
    intent: null,
    ...evidence,
    llm_notes: notes,
    trace: trace.entries,
    steps: maxSteps,
  };
}
