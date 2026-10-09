#!/usr/bin/env node
// Builds a fully self-contained showcase page (web/index.html) from the latest
// demo run + a live protocol-validation pass. No external assets, no CDN —
// the file opens directly and works offline.
//   node scripts/build-showcase.mjs            # re-runs validate-mcp.mjs for the PASS table
//   node scripts/build-showcase.mjs --no-validate
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web", "index.html");

const reportMd = await readFile(join(ROOT, "agent", "output", "pilbara-report.md"), "utf8").catch(() => null);
if (!reportMd) {
  console.error("agent/output/pilbara-report.md not found — run `npm run demo` first.");
  process.exit(1);
}
const evidence = JSON.parse(
  await readFile(join(ROOT, "agent", "output", "pilbara-report.evidence.json"), "utf8").catch(() => "{}")
);

function parseChecks(blob) {
  return blob
    .split("\n")
    .map((l) => l.match(/^(.+?)\s{2,}(.+?)\s{2,}(PASS|FAIL)\s{2,}(.*)$/))
    .filter(Boolean)
    .map((m) => ({ server: m[1].trim(), check: m[2].trim(), status: m[3], detail: m[4].trim() }));
}

let validation = { rows: [], allPassed: null, error: "skipped" };
if (!process.argv.includes("--no-validate")) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "validate-mcp.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rows = parseChecks(out);
    validation = { rows, allPassed: /ALL CHECKS PASSED/.test(out), error: null };
  } catch (err) {
    const rows = parseChecks(String(err.stdout ?? "") + String(err.stderr ?? ""));
    validation = rows.length
      ? { rows, allPassed: rows.every((r) => r.status === "PASS"), error: null }
      : { rows: [], allPassed: null, error: err.message };
  }
}

const template = await readFile(join(ROOT, "scripts", "showcase.template.html"), "utf8");
const payload = { builtAt: new Date().toISOString(), reportMd, evidence, validation };
// `<` is escaped so a `</script>` inside report text can never break the JSON block.
const json = JSON.stringify(payload).replace(/</g, "\\u003c");
const html = template.replace("__PAYLOAD__", () => json);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html, "utf8");
console.log(`wrote ${OUT} (${(html.length / 1024).toFixed(0)} KB)`);
console.log(
  `  report ${(reportMd.length / 1024).toFixed(1)} KB · ${validation.rows.length} checks` +
    ` (${validation.allPassed === null ? "skipped" : validation.allPassed ? "all passed" : "some failed"})` +
    ` · ${(evidence.trace || []).length} tool calls`
);
