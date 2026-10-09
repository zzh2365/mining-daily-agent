import { describe } from "./llm.mjs";

const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}%`);
const MONO = (s) => s;

function resourceTable(pdfs) {
  const rows = [];
  for (const p of pdfs) {
    const r = p.resources ?? {};
    for (const cat of ["Measured", "Indicated", "Inferred"]) {
      const v = r[cat];
      if (!v) continue;
      rows.push(
        `| ${cat} | ${v.tonnage_m_t ?? "—"} Mt | ${v.grade_pct ?? "—"}% | ${v.contained_metal_kt_lce ?? "—"} kt | ${v.note ?? "—"} |`
      );
    }
    const mi = p.totals?.measured_plus_indicated;
    if (mi) rows.push(`| **M + I (报告值)** | ${mi.tonnage_m_t} Mt | ${mi.grade_pct}% | ${mi.contained_metal_kt_lce} kt | 报告合并披露 |`);
  }
  if (!rows.length) return "_未能从 PDF 中解析出 NI 43-101 资源量表。_\n";
  return [
    "| 资源量类别 | 矿石量 (Mt) | 品位 | 金属量 (kt LCE) | 备注 |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function trendBlock(t) {
  const series = t.series ?? [];
  const step = Math.max(1, Math.ceil(series.length / 10));
  const sampled = series.filter((_, i) => i % step === 0 || i === series.length - 1);
  const table = [
    "| 日期 | 价格 |",
    "|---|---|",
    ...sampled.map((p) => `| ${p.date} | ${p.price} |`),
  ].join("\n");
  return [
    `**${t.commodity}** — ${t.window?.from} → ${t.window?.to}：${pct(t.change_pct)}（${t.direction}），` +
      `均值 ${t.mean} ${t.unit}，区间 ${t.min}–${t.max}，变异系数 ${t.cv_pct}%，上涨/下跌天数 ${t.up_days}/${t.down_days}。`,
    "",
    "```",
    MONO(t.sparkline ?? ""),
    "```",
    "",
    table,
  ].join("\n");
}

function pdfLabel(p) {
  const ref = p.source?.resolved ?? p.source?.requested ?? "";
  if (/^fixture:/i.test(ref)) return ref;
  if (/^file:/i.test(ref)) return decodeURIComponent(ref).split(/[\\/]/).pop();
  return ref || "PDF";
}

function collectRisks(ev) {
  const risks = [];
  for (const p of ev.pdfs) {
    for (const f of p.risk_flags ?? []) {
      risks.push({ level: f.level ?? "info", text: f.quote ? `${f.flag}：${f.quote}` : f.flag, from: pdfLabel(p) });
    }
    const share = p.totals?.inferred_share_of_tonnage;
    if (share != null && share >= 0.3) {
      risks.push({
        level: share > 0.5 ? "high" : "medium",
        text: `Inferred 占总资源量 ${(share * 100).toFixed(0)}%（NI 43-101 规定 Inferred 的品位与吨位不得用于可行性结论）`,
        from: "mineral-pdf-mcp",
      });
    }
    if (p.report?.effective_date) {
      const d = new Date(p.report.effective_date);
      if (!Number.isNaN(d.getTime()) && Date.now() - d > 550 * 86400_000) {
        risks.push({ level: "medium", text: `资源量生效日期为 ${p.report.effective_date}，已超过 18 个月，需关注更新`, from: "mineral-pdf-mcp" });
      }
    }
  }
  for (const t of ev.trends) {
    if (Math.abs(t.change_pct ?? 0) >= 15) {
      risks.push({ level: "medium", text: `${t.commodity} ${t.window?.days}日累计变动 ${pct(t.change_pct)}，价格波动显著`, from: "lime-price-mcp" });
    }
    if ((t.cv_pct ?? 0) >= 12) {
      risks.push({ level: "medium", text: `${t.commodity} 日收益率变异系数 ${t.cv_pct}%，日内波动偏高`, from: "lime-price-mcp" });
    }
  }
  const newsText = (ev.articles.map((a) => `${a.title} ${a.text ?? a.excerpt ?? ""}`).join(" ") +
    " " + (ev.llm_notes ?? "")).toLowerCase();
  for (const [re, label] of [
    [/risk|uncertain|delay|overrun|suspend|cut|weakness|oversupply| royalty|诉讼|停产/, "新闻中出现风险/不确定性表述"],
    [/permit|approval|native title|environmental/, "存在审批/社区/环保前置条件"],
    [/oversupply|idled|curtail|utilisation/, "供给端存在减产或过剩信号"],
  ]) {
    if (re.test(newsText)) risks.push({ level: "low", text: label, from: "mining-news-mcp" });
  }
  if (ev.news_results.some((r) => /fixture/i.test(r.source ?? "")) || ev.pdfs.some((p) => /example\.com|fixture/i.test(p.source?.resolved ?? ""))) {
    risks.push({
      level: "info",
      text: "本次运行包含离线演示数据（fixture / example.com 链接），不构成真实市场信息",
      from: "data-quality",
    });
  }
  if (ev.data_degraded) {
    risks.push({ level: "info", text: "实时新闻源不可用，已回退到本地 fixture", from: "data-quality" });
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return risks.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
}

function sourceList(ev) {
  const out = [];
  const day = (s) => (s ? String(s).slice(0, 10) : "");
  for (const a of ev.articles) {
    out.push({ url: a.url, title: a.title ?? ev.news_results.find((r) => r.url === a.url)?.title ?? "(untitled)", kind: "新闻", meta: day(a.published_at ?? ev.news_results.find((r) => r.url === a.url)?.published_at) });
  }
  for (const r of ev.news_results) {
    if (!ev.articles.some((a) => a.url === r.url)) out.push({ url: r.url, title: r.title, kind: "新闻(仅摘要)", meta: day(r.published_at) });
  }
  for (const p of ev.pdfs) {
    const url = p.source?.resolved ?? p.source?.requested;
    if (url) out.push({ url, title: p.report?.project ?? "NI 43-101 技术报告", kind: "PDF", meta: p.report?.effective_date ?? "", label: `${p.report?.project ?? "NI 43-101"} — ${pdfLabel(p)}` });
  }
  for (const t of ev.trends) out.push({ url: null, title: `${t.commodity} 价格走势（${t.source ?? "series"}）`, kind: "价格", meta: `${t.window?.from} → ${t.window?.to}` });
  const seen = new Set();
  return out.filter((s) => {
    const k = s.url ?? s.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pickSentence(body, title) {
  const clean = String(body ?? "").replace(/\s+/g, " ").trim();
  const skip = /^(subscribe|sign ?up|cookie|privacy|follow |share |related|read more|ad |menu|home|about )/i;
  const junk = /\{\{|:\s*['"]\s*[>)]|=>|function\s*\(|<\/?[a-z]+>|https?:\/\//i;
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 70 && s.length < 320 && !skip.test(s) && !junk.test(s) && !/©/.test(s));
  const words = (title ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const scored = sentences.map((s, i) => {
    const low = s.toLowerCase();
    const hits = words.filter((w) => low.includes(w)).length;
    return { s, i, score: hits * 2 - Math.min(i, 4) * 0.3 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.s ?? sentences[0] ?? "";
}

function fallbackNewsDigest(ev) {
  if (!ev.articles?.length) {
    const lines = ev.news_results.slice(0, 5).map((r) => {
      const summary = (r.summary ?? "").slice(0, 180);
      return `- **${r.title}**（${r.source}${r.published_at ? `, ${r.published_at.slice(0, 10)}` : ""}）：${summary}${summary.length >= 180 ? "…" : ""}`;
    });
    return lines.length ? lines.join("\n") : "_未检索到相关新闻。_";
  }
  return ev.articles
    .slice(0, 4)
    .map((a) => {
      const meta = [a.source, a.published_at?.slice(0, 10)].filter(Boolean).join(", ");
      const sentence = pickSentence(a.text ?? a.excerpt, a.title);
      return `- **${a.title}**${meta ? `（${meta}）` : ""}：${sentence || "（正文未取到有效句子）"}`;
    })
    .join("\n");
}

export async function assembleReport(ev, { cfg, generatedAt = new Date() } = {}) {
  const risks = collectRisks(ev);
  const sources = sourceList(ev);
  const pdf = ev.pdfs[0];

  const digest = await describe(cfg, {
    system:
      "你是矿业分析师。只依据用户提供的材料作答，不得编造数字或事实。输出中文，简洁、可核查，不要重复标题。",
    user: [
      "以下是某主题的新闻材料。请写 2-4 句中文摘要，指出关键事件、涉及主体、以及对项目的含义；",
      "如材料之间观点冲突，请点明。每句尽量能对应到给定原文。",
      "",
      "标题列表：",
      ...ev.news_results.slice(0, 8).map((r) => `- ${r.title} (${r.source})`),
      "",
      "正文摘录：",
      ...ev.articles.slice(0, 3).map((a) => `### ${a.title ?? a.url}\n${(a.text ?? a.excerpt ?? "").slice(0, 900)}`),
      pdf ? `\nNI 43-101 资源量：${JSON.stringify(pdf.resources)}` : "",
      ev.llm_notes ? `\n上游研究笔记（可参考，但不得引入新事实）：${ev.llm_notes}` : "",
    ].join("\n"),
    fallback: () => fallbackNewsDigest(ev),
    max_tokens: 600,
  });

  const resourceNote = pdf
    ? await describe(cfg, {
        system: "你是矿业分析师。用 1-2 句中文解读给定 NI 43-101 数据，指出可靠性层次（Measured/Indicated/Inferred）。不得编造。",
        user: JSON.stringify({ report: pdf.report, resources: pdf.resources, totals: pdf.totals, confidence: pdf.confidence }),
        fallback: () =>
          `解析置信度 ${pdf.confidence?.level ?? "unknown"}；已解析类别 ${(pdf.confidence?.parsed_categories ?? []).join("/") || "无"}。` +
          (pdf.totals?.inferred_share_of_tonnage != null
            ? `Inferred 占比 ${(pdf.totals.inferred_share_of_tonnage * 100).toFixed(0)}%。`
            : ""),
        max_tokens: 300,
      })
    : null;

  const priceNote = ev.trends.length
    ? await describe(cfg, {
        system: "你是大宗商品分析师。用 1-2 句中文概括给定价格序列的走势与波动，只引用提供的数字。",
        user: JSON.stringify(ev.trends.map((t) => ({ commodity: t.commodity, unit: t.unit, change_pct: t.change_pct, direction: t.direction, mean: t.mean, min: t.min, max: t.max, cv_pct: t.cv_pct, window: t.window }))),
        fallback: () =>
          ev.trends
            .map((t) => `${t.commodity}：${pct(t.change_pct)}（${t.direction}），区间 ${t.min}–${t.max} ${t.unit}`)
            .join("；"),
        max_tokens: 300,
      })
    : null;

  const md = [];
  md.push(`# 矿权日报 · ${ev.query}`);
  md.push("");
  md.push(
    `> 生成时间 ${generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC · ` +
      `编排模式 \`${ev.mode}\` · 工具调用 ${ev.trace?.length ?? 0} 次 · ` +
      `数据源 ${sources.length} 个`
  );
  md.push("");

  md.push("## 一、新闻摘要");
  md.push("");
  md.push(digest.text);
  md.push("");
  if (ev.articles?.length) {
    md.push("**已抓取全文的文章**", "");
    md.push(
      ...ev.articles.map(
        (a, i) =>
          `${i + 1}. [${a.title ?? a.url}](${a.url}) — 抓取 ${(a.text ?? a.excerpt ?? "").length} 字符${a.note ? `（${a.note}）` : ""}`
      )
    );
    md.push("");
  }

  md.push("## 二、NI 43-101 资源量数据");
  md.push("");
  if (pdf) {
    md.push(
      `**项目**：${pdf.report?.project ?? "—"} · **生效日期**：${pdf.report?.effective_date ?? "—"} · ` +
        `**QP**：${pdf.report?.qualified_person ?? "—"} · **阶段**：${pdf.report?.study_stage ?? "—"} · ` +
        `**NI 43-101 引用**：${pdf.report?.ni_43_101_reference ? "是" : "否"}`
    );
    md.push("");
    md.push(resourceTable(ev.pdfs));
    md.push("");
    md.push(`> ${resourceNote?.text ?? ""}`);
    md.push("");
  } else {
    md.push("_本次运行未取得可用 PDF 资源量数据。_");
    md.push("");
  }

  md.push("## 三、价格走势");
  md.push("");
  if (ev.prices.length) {
    md.push(
      "| 品种 | 最新报价 | 单位 | 贸易条款 | 日期 | 前收 | 日变动 |",
      "|---|---|---|---|---|---|---|",
      ...ev.prices.map(
        (p) =>
          `| ${p.commodity} | ${p.price} | ${p.unit} | ${p.incoterm ?? "—"} | ${p.date} | ${p.previous_close ?? "—"} | ${pct(p.change_pct)} |`
      ),
      ""
    );
  }
  if (ev.trends.length) {
    md.push(ev.trends.map(trendBlock).join("\n\n"));
    md.push("");
    md.push(`> ${priceNote?.text ?? ""}`);
    md.push("");
  } else {
    md.push("_未取得价格序列。_");
    md.push("");
  }

  md.push("## 四、风险提示");
  md.push("");
  if (risks.length) {
    const icon = { high: "🔴", medium: "🟠", low: "🟡", info: "⚪" };
    md.push(...risks.map((r) => `- ${icon[r.level] ?? "•"} ${r.text}  \n  <sub>来源：${r.from}</sub>`));
  } else {
    md.push("- 未发现显著风险信号。");
  }
  md.push("");

  md.push("## 五、引用源");
  md.push("");
  md.push(...sources.map((s) => (s.url ? `- [${s.kind}] [${s.label ?? s.title}](${s.url})${s.meta ? ` — ${s.meta}` : ""}` : `- [${s.kind}] ${s.label ?? s.title}${s.meta ? ` — ${s.meta}` : ""}`)));
  md.push("");

  md.push("## 附录 · 工具调用轨迹");
  md.push("");
  md.push("| # | 工具 | 参数 | 结果 | 耗时 |", "|---|---|---|---|---|");
  (ev.trace ?? []).forEach((t, i) => {
    const args = JSON.stringify(t.args ?? {}).slice(0, 90);
    md.push(`| ${i + 1} | \`${t.tool}\` | \`${args}\` | ${t.ok ? "✅" : `❌ ${t.error ?? ""}`} | ${t.ms}ms |`);
  });
  md.push("");
  md.push(
    "---",
    "",
    `_数据说明：${[...new Set([...ev.trends.map((t) => t.data_note), ...ev.prices.map((p) => p.data_note)])].filter(Boolean).join(" / ") || "见各工具返回"}_`,
    ev.llm_notes ? `_研究笔记：${ev.llm_notes}_` : "",
    `_由 mining-daily-agent 生成；LLM 仅用于摘要与解读，所有数字均来自 MCP 工具返回值。_`
  );
  return { markdown: md.filter((l) => l !== undefined).join("\n"), llmUsed: [digest, resourceNote, priceNote].some((x) => x?.llm) };
}
