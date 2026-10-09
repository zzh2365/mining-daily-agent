// Thin OpenAI-compatible chat-completions client with tool calling.
// Works with any provider exposing /chat/completions (OpenAI, DeepSeek,
// Moonshot, Qwen/DashScope compatible mode, OpenRouter, local Ollama...).
import { log } from "../../shared/log.mjs";

export function llmConfig() {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
  };
}

// OpenAI accepts JSON Schema for function parameters; drop MCP/SDK extras.
export function toToolSpecs(tools) {
  return tools.map((t) => {
    const schema = JSON.parse(JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }));
    for (const k of ["$schema", "$defs", "definitions", "additionalProperties"]) delete schema[k];
    return {
      type: "function",
      function: {
        name: t.llmName,
        description: (t.description || "").slice(0, 1000),
        parameters: { type: "object", properties: {}, ...schema, strict: false },
      },
    };
  });
}

async function post(cfg, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS ?? 120000));
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(cfg, { messages, tools, tool_choice = "auto", max_tokens = 4000, temperature }) {
  const body = {
    model: cfg.model,
    messages,
    max_tokens,
    temperature: temperature ?? cfg.temperature,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = tool_choice;
  }
  try {
    return await post(cfg, body);
  } catch (err) {
    if (tools?.length && /400|422|strict|tool_choice/i.test(err.message)) {
      log(`retrying without strict tool schema (${err.message.slice(0, 120)})`);
      const relaxed = JSON.parse(JSON.stringify(tools));
      for (const t of relaxed) delete t.function.parameters.strict;
      return post(cfg, { ...body, tools: relaxed });
    }
    throw err;
  }
}

// One-shot prose generation used to enrich report sections. Falls back to a
// deterministic writer so the pipeline never hard-depends on a model.
// cfg.disabled is a per-run circuit breaker: after one transport failure we stop
// retrying, so an unreachable endpoint costs one timeout instead of N.
export async function describe(cfg, { system, user, fallback, max_tokens = 700 }) {
  if (!cfg || cfg.disabled) return { text: fallback(), llm: false };
  try {
    const json = await chat(cfg, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens,
    });
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty completion");
    return { text, llm: true };
  } catch (err) {
    cfg.disabled = true;
    log(`describe() fell back: ${err.message.slice(0, 160)}`);
    return { text: fallback(), llm: false, error: err.message.slice(0, 200) };
  }
}
