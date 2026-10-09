// Streams the official Docker Desktop installer to the user's Downloads folder
// using Node's bundled OpenSSL (Windows schannel-based curl fails the TLS
// handshake against Docker's CDN on this machine).
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const URL = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
const OUT = process.argv[2] || "C:\\Users\\zhu\\Downloads\\Docker Desktop Installer.exe";

const t0 = Date.now();
const res = await fetch(URL);
if (!res.ok) throw new Error(`HTTP ${res.status} from ${URL}`);
const total = Number(res.headers.get("content-length")) || 0;
console.log(`downloading ${total} bytes -> ${OUT}`);

let done = 0;
let lastPct = -1;
const out = createWriteStream(OUT);
const src = Readable.fromWeb(res.body);
src.on("data", (chunk) => {
  done += chunk.length;
  const pct = total ? Math.floor((done / total) * 100) : -1;
  if (pct >= 0 && pct !== lastPct && pct % 5 === 0) {
    lastPct = pct;
    const mb = (done / 1048576).toFixed(0);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const rate = (done / 1048576 / (Date.now() - t0) * 1000).toFixed(1);
    console.log(`  ${pct}%  ${mb} MB  ${secs}s  ${rate} MB/s`);
  }
});
await pipeline(src, out);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`DONE ${OUT}  ${(done / 1048576).toFixed(0)} MB in ${secs}s`);
