// Generates a small, valid PDF containing a synthetic NI 43-101-style
// mineral resource statement, used as an offline fixture for mineral-pdf-mcp.
// Text is stored uncompressed so pdf-parse (and most extractors) can read it.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const LINES = [
  "TECHNICAL REPORT SUMMARY",
  "NI 43-101 STANDARDS OF DISCLOSURE FOR MINERAL PROJECTS",
  "",
  "Project: Pilgangoora Lithium Tantalite Project, Pilbara, Western Australia",
  "Effective date: 30 June 2026",
  "Prepared by: J. Whitmore, P.Geo., Australian Institute of Geoscientists",
  "",
  "MINERAL RESOURCE ESTIMATE (NI 43-101)",
  "",
  "Category          Tonnage      Grade        Contained Metal",
  "Measured        18.4 Mt       1.28% Li2O      235 kt LCE",
  "Indicated      132.6 Mt       1.21% Li2O    1,432 kt LCE",
  "Inferred        74.9 Mt       1.16% Li2O      702 kt LCE",
  "",
  "Total Measured and Indicated Mineral Resources are 151.0 Mt at 1.22% Li2O,",
  "containing 1,667 kt LCE. Inferred Mineral Resources are 74.9 Mt at 1.16% Li2O,",
  "containing 702 kt LCE. The estimate was constrained by a pit optimisation at",
  "USD 1,000/t spodumene concentrate price.",
  "",
  "Metallurgical test work recovered 6.0% Li2O spodumene concentrate at a mass",
  "recovery of 78%. The Qualified Person cautions that Inferred Mineral Resources",
  "are too uncertain to apply economic and technical factors reliably.",
  "",
  "Mining lease, Native Title approvals and a 5-year environmental permitting",
  "window remain outstanding. There is a risk of cost overrun on tailings storage.",
  "",
  "This summary supports a prefeasibility study for a 45 ktpa scoping scenario;",
  "final investment decision is not recommended on Inferred Mineral Resources.",
];

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const content = [
  "BT",
  "/F1 11 Tf",
  ...LINES.map((l, i) => `1 0 0 -1 56 ${792 - 30 - i * 16} Tm (${esc(l)}) Tj`),
  "ET",
].join("\n");

function obj(n, body) {
  return `${n} 0 obj\n${body}\nendobj\n`;
}

const objects = [
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>"),
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
  obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"),
];

const header = "%PDF-1.4\n";
const offsets = [];
let cursor = header.length;
let body = "";
for (const o of objects) {
  offsets.push(cursor);
  body += o;
  cursor += o.length;
}
const xrefStart = cursor;
// Each xref entry must be exactly 20 bytes: 10 + SP + 5 + SP + 1 + 2-byte EOL.
const EOL = " \n";
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f${EOL}`;
for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n${EOL}`;
const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const out = process.argv[2] ?? join(HERE, "..", "fixtures", "pdfs", "pilbara_ni43101_sample.pdf");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, header + body + xref + trailer, "latin1");
console.log(`wrote ${out} (${(header + body + xref + trailer).length} bytes)`);
