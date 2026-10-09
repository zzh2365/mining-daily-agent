import { decodeEntities } from "./http.mjs";

function tag(block, name) {
  const m =
    block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")) ?? null;
  if (!m) return "";
  const inner = m[1].trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decodeEntities(cdata ? cdata[1].trim() : inner);
}

// Parses RSS 2.0 and Atom feeds into a common shape.
export function parseFeed(xml) {
  const items = [];
  const rssBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const atomBlocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of [...rssBlocks, ...atomBlocks]) {
    const isAtom = /<entry/i.test(block);
    let url = isAtom
      ? tag(block, "id") ||
        (block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "")
      : tag(block, "link");
    const title = tag(block, "title");
    const description = isAtom
      ? tag(block, "summary") || tag(block, "content")
      : tag(block, "description") || tag(block, "content:encoded");
    const dateRaw = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated");
    const date = new Date(dateRaw.replace(/\s+\d{4}-\d{2}-\d{2}$/, ""));
    if (!title || !url) continue;
    items.push({
      title: title.replace(/\s+/g, " ").trim(),
      url: url.trim(),
      summary: description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      published_at: Number.isNaN(date.getTime()) ? null : date.toISOString(),
    });
  }
  return items;
}
