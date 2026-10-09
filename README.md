# mining-daily-agent

按 **MCP (Model Context Protocol)** 实现的「矿权日报」Agent：**3 个 MCP server + 1 个 Agent client**。
输入一句「给我生成一份关于 Pilbara 锂矿的今日简报」，输出一份带引用源的 Markdown 简报。

> 快速上手请看 **[RUN.md](RUN.md)**（5 分钟跑通）。本文说明设计与取舍。

```
                      ┌──────────────────────────────┐
   "Pilbara 锂矿       │  agent/src  (MCP client)     │
    今日简报"  ──────▶ │  ┌────────────┐ ┌────────── │      ┌─────────────────────┐
                      │  │ ReAct 循环  │ │ 确定性    │ │      │ mining-news-mcp     │
                      │  │ (LLM 驱动,  │ │ planner  │ │      │  search/fetch_article│
                      │  │  可选)      │ │ (默认)   │ │      ├─────────────────────┤
                      │  └─────┬──────┘ └────┬─────┘ │      │ mineral-pdf-mcp     │
                      │        └─────┬───────┘       │ stdio├─────────────────────┤
                      │         McpHub (工具目录/     │────▶│ lime-price-mcp      │
                      │         调用/超时/降级)       │      │  get_price/get_trend│
                      │  证据 → 简报组装 → Markdown   │      └─────────────────────┘
                      └──────────────────────────────┘
```

## 交付清单对照

| 要求 | 实现 |
|---|---|
| Agent 主流程（输入 → Markdown 简报 + 引用源链接） | `agent/src/index.mjs` → `planner.mjs` / `react.mjs` → `report.mjs` |
| ≥3 个 MCP server | `servers/mining-news-mcp`、`servers/mineral-pdf-mcp`、`servers/lime-price-mcp` |
| 必须工具 | `search(query, days)`、`fetch_article(url)`、`extract_resources(pdf_url)`、`get_price(commodity, date)`、`get_trend(commodity, days)` —— 名称与签名逐一对齐题面 |
| 1 个 client 端 Agent 编排 | 自写 ReAct 循环（`react.mjs`）+ 确定性 planner 兜底（`planner.mjs`），未引入 LangChain |
| `mcp-config.json`（可接 Claude Desktop / Cursor） | 根目录 `mcp-config.json`；`npm run config:client` 生成绝对路径版 |
| `RUN.md`（5 分钟跑起来，含 docker-compose） | `RUN.md` + `Dockerfile` + `docker-compose.yml` |
| 可视化展示页（额外） | `npm run showcase` → `web/index.html`，自包含单文件，四标签页演示架构/简报/校验/契约 |

## 设计要点

**1. 无 LLM 也能交付完整简报。**
`lime-price-mcp` 之类工具的输出是结构化 JSON，简报的 5 个章节本质上可由确定性 planner 组装：
`search → fetch_article ×N → extract_resources → get_price + get_trend → 渲染`。
LLM 是**增强项**而非依赖项：配好 key 后走 ReAct（模型自选工具与轮次），并用于把证据改写成中文摘要；
没配 key 或 ReAct 失败时，回退到确定性 planner + 抽取式摘要。报告头部会写明本次实际走了哪条路径。

**2. 每个数据面都有「真实源 + 可复现兜底」两条路。**
新闻走真实 RSS（mining.com / australianmining.com.au，带 30 分钟磁盘缓存与陈旧缓存兜底），
断网降级到 `fixtures/news.json`；PDF 走真实下载 + `pdfjs-dist` 文本层解析，演示用合成 NI 43-101 报告；
价格是**明确标注为合成**的确定性序列（按 品种+日期 播种），设 `PRICE_API_URL` 即切换到授权行情源，工具契约不变。

**3. 可核查性优先于文采。**
简报固定带「工具调用轨迹」附录（工具名、参数、成败、耗时）与 `*.evidence.json`（原始返回值）。
风险提示不是套话：每条都标注来源（QP 原话引用 / Inferred 占比计算 / 价格波动统计阈值 / 新闻关键词命中）。

**4. stdio 纪律。**
MCP server 的 stdout 只承载 JSON-RPC，所有日志走 stderr（`shared/log.mjs`）；
client 端把 server stderr 转发出来，便于排错。

## 目录结构

```
mining-daily-agent/
├─ package.json              # npm workspaces + 脚本（validate/demo/fixture-pdf/config:client/showcase）
├─ mcp-config.json           # server 注册表（支持 ${VAR:-default}）
├─ mcp-config.client.json    # 生成的绝对路径版，供 Claude Desktop / Cursor
├─ web/index.html            # 生成的自包含展示页（npm run showcase）
├─ Dockerfile / docker-compose.yml
├─ RUN.md / README.md / .env.example
├─ shared/                   # 三个 server 共用：HTTP+缓存、RSS 解析、stderr 日志
│  ├─ http.mjs               #   cachedGet / extractReadable（JSON-LD → <p> 正文抽取）
│  ├─ rss.mjs                #   RSS 2.0 + Atom 统一解析
│  └─ log.mjs
├─ servers/
│  ├─ mining-news-mcp/src/index.mjs        # search / fetch_article
│  ├─ mineral-pdf-mcp/src/
│  │   ├─ index.mjs                        # extract_resources
│  │   ├─ pdf.mjs                          # pdfjs-dist 文本层 → 按基线重排行
│  │   └─ ni43101.mjs                      # NI 43-101 资源量表/叙述句解析
│  └─ lime-price-mcp/src/index.mjs         # get_price / get_trend
├─ agent/
│  ├─ src/index.mjs          # CLI + 编排入口（--mode auto|llm|deterministic）
│  ├─ src/mcp.mjs            # McpHub：加载配置、拉起 server、工具目录、调用
│  ├─ src/react.mjs          # ReAct 循环 + 观测归一化
│  ├─ src/planner.mjs        # 确定性 planner（意图识别 → 固定证据集）
│  ├─ src/llm.mjs            # OpenAI 兼容 chat/completions + tool calling
│  ├─ src/report.mjs         # Markdown 简报组装（含风险规则引擎）
│  └─ output/                # 简报与证据 JSON
├─ fixtures/
│  ├─ news.json              # 离线新闻（Pilbara 锂矿场景）
│  ├─ commodities.json       # 品种注册表（基准价/波动率/中英别名）
│  └─ pdfs/…ni43101_sample.pdf
└─ scripts/
   ├─ validate-mcp.mjs       # 协议级冒烟测试（initialize/list/call + 断言）
   ├─ make-fixture-pdf.mjs   # 生成合成 NI 43-101 PDF
   ├─ gen-mcp-config.mjs     # 生成 Claude Desktop/Cursor 用的绝对路径配置
   ├─ build-showcase.mjs     # 生成 web/index.html 展示页
   └─ showcase.template.html # 展示页模板（build 脚本注入 JSON）
```

## 工具契约

| Server | 工具 | 入参 | 返回要点 |
|---|---|---|---|
| mining-news-mcp | `search` | `query`, `days=7`, `limit=8` | 排序后的标题/URL/日期/摘要 + `data_note` 标注实时或降级 |
| | `fetch_article` | `url`, `max_chars=6000` | 正文纯文本、作者、抽取方式（`json-ld:articleBody` / `paragraphs:*`） |
| mineral-pdf-mcp | `extract_resources` | `pdf_url`, `max_pages=20`, `include_text` | 分类资源量（吨/品位/金属量）、M+I 与 Inferred 合计、生效日期、QP、解析置信度、风险标记 |
| lime-price-mcp | `get_price` | `commodity`, `date?` | 报价 + 前收 + 日变动 + 贸易条款 + `data_note` |
| | `get_trend` | `commodity`, `days=30`, `end_date?` | 完整序列 + 涨跌/均值/区间/CV/上涨下跌天数 + ASCII sparkline |

`commodity` 支持中英别名（`spodumene`、`SC6.0`、`碳酸锂`、`氢氧化锂`…），`pdf_url` 支持 `http(s)://`、`file://`、本地路径与 `fixture:<name>`。

## NI 43-101 解析器怎么工作

1. `pdfjs-dist` 抽取文本层，按基线 y 坐标聚行、按 x 排序还原表格行；
2. 软换行合并（PDF 会硬换行），使跨行的资源量叙述句可被正则匹配；
3. 两条互补路径：① 表格式「类别 + 吨位 + 品位 + 金属量」行；② 叙述式
   `Total Measured and Indicated ... are 151.0 Mt at 1.22% Li2O, containing 1,667 kt LCE`；
4. 输出 `confidence.level`（依据解析到的类别与是否含金属量）与 `risk_flags`
   （Inferred 占比、QP 警示原话、审批/成本超支表述）。

## 已知限制

- 价格是合成序列（题面无授权数据源可用），已在每次工具返回的 `data_note` 与简报脚注中声明。
- NI 43-101 解析针对**英文文本层报告**；扫描件需先 OCR，非英文/非常规表结构可能漏解析——返回体里的
  `confidence.level: none` + `risk_flags` 会明确指出「没解析出来」，而不是编一个数。
- 新闻正文抽取依赖站点 HTML/JSON-LD 结构，个别站点可能只拿到摘要。
- ReAct 模式需要外部模型端点，本仓库默认路径不依赖它。
