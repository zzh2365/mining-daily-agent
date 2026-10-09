// MCP servers communicate over stdio: stdout is reserved for JSON-RPC.
// All diagnostics must go to stderr.
export function log(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}
