import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "../../shared/log.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Supports ${VAR} and bash-style ${VAR:-default} substitution.
export function substitute(value = "") {
  return String(value).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k, dflt) => process.env[k] || dflt || "");
}

export async function loadConfig(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const servers = raw.mcpServers ?? raw.servers ?? {};
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    out[name] = {
      command: substitute(s.command),
      args: (s.args ?? []).map((a) => {
        const v = substitute(a);
        return isAbsolute(v) || a.startsWith("${") ? v : resolve(dirname(path), v);
      }),
      env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, substitute(v)])),
    };
  }
  return { path, servers: out };
}

// MCP tool results are content blocks; our servers return JSON in a text block.
function unwrap(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text || null;
  }
  return { data, isError: !!result?.isError, text };
}

export class McpHub {
  constructor(config) {
    this.config = config;
    this.clients = new Map();
    this.tools = [];
  }

  async connect(filter = []) {
    const wanted = filter.length
      ? Object.keys(this.config.servers).filter((n) => filter.includes(n))
      : Object.keys(this.config.servers);
    for (const name of wanted) {
      const spec = this.config.servers[name];
      if (!spec.command) throw new Error(`server '${name}' has no command in ${this.config.path}`);
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...spec.env }).filter(([, v]) => v != null)
        ),
        cwd: ROOT,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk) => log(`[${name}]`, String(chunk).trimEnd()));
      const client = new Client({ name: "mining-agent", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.clients.set(name, client);
      for (const t of tools) {
        this.tools.push({
          server: name,
          tool: t.name,
          llmName: `${name}__${t.name}`,
          display: `${name}.${t.name}`,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
      log(`connected ${name}: ${tools.map((t) => t.name).join(", ")}`);
    }
    return this;
  }

  instructions() {
    return [...this.clients.entries()]
      .map(([name, c]) => c.getInstructions?.() ? `## ${name}\n${c.getInstructions()}` : null)
      .filter(Boolean)
      .join("\n\n");
  }

  async call(llmName, args, { timeoutMs = 60000 } = {}) {
    const spec = this.tools.find((t) => t.llmName === llmName || t.display === llmName);
    if (!spec) throw new Error(`unknown tool '${llmName}'`);
    const client = this.clients.get(spec.server);
    const result = await client.callTool(
      { name: spec.tool, arguments: args },
      undefined,
      { timeout: timeoutMs }
    );
    return unwrap(result);
  }

  async close() {
    for (const c of this.clients.values()) await c.close().catch(() => {});
    this.clients.clear();
  }
}
