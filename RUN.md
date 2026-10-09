# RUN.md — 5 分钟跑起来

> 目标：`npm install` → `npm run validate` → `npm run demo`，产出一份 Markdown 矿权简报。
> **不需要 Python、不需要 API key、不需要 Docker**（Docker 是可选路径）。
> §2–§4 全程约 15 秒；只有 §1 的依赖安装是一次性的分钟级步骤。

## 0. 前置条件

| 项 | 要求 | 已验证版本 |
|---|---|---|
| Node.js | ≥ 18.17 | v20.20.2 |
| npm | ≥ 9 | 10.8.2 |
| 网络 | 可选 | 断网会自动降级到本地 fixture（见 §5） |

## 1. 安装依赖

```bash
cd mining-daily-agent
npm install          # 4 个运行时依赖：@modelcontextprotocol/sdk、zod、pdfjs-dist、dotenv
```

> 一次性安装约 1–5 分钟（取决于网络；`node_modules` 约 130 MB，其中 pdfjs-dist 占 32 MB）。
> 后续 §2–§4 每一步都在**秒级**。

## 2. 生成测试用 NI 43-101 PDF（1 秒）

```bash
npm run fixture-pdf   # -> fixtures/pdfs/pilbara_ni43101_sample.pdf
```

仓库里已附带一份生成好的 PDF，这一步只是让你能重新生成/改名。

## 3. 验证 3 个 MCP server（约 10 秒）

```bash
npm run validate
```

该脚本用 **真实的 MCP stdio 客户端**逐个拉起 server，跑 `initialize` → `tools/list` → `tools/call`，并断言返回值：

```
mining-news-mcp  tools/list                    PASS  search, fetch_article
mining-news-mcp  tools/call search             PASS  3 hits (Live RSS results.)
mining-news-mcp  tools/call fetch_article      PASS  1200 chars
mineral-pdf-mcp  tools/list                    PASS  extract_resources
mineral-pdf-mcp  tools/call extract_resources  PASS  Indicated 132.6 Mt @ 1.21% / Inferred 74.9 Mt @ 1.16%
lime-price-mcp   tools/list                    PASS  get_price, get_trend
lime-price-mcp   tools/call get_price          PASS  837.62 USD/t on 2026-10-08
lime-price-mcp   tools/call get_trend          PASS  Lithium hydroxide (battery grade) -9.19% (down)

ALL CHECKS PASSED — 8 checks over 3 server(s)
```

单独验证某一个：`node scripts/validate-mcp.mjs lime-price-mcp`

## 4. 跑通 Agent，产出简报（约 2 秒）

```bash
npm run demo
# 等价于：
node agent/src/index.mjs \
  --query "给我生成一份关于 Pilbara 锂矿的今日简报" \
  --out agent/output/pilbara-report.md
```

产物：

- `agent/output/pilbara-report.md` — 简报正文（打印到 stdout）
- `agent/output/pilbara-report.evidence.json` — 原始工具返回 + 调用轨迹，便于核查

简报固定包含 5 节：**新闻摘要 → NI 43-101 资源量 → 价格走势 → 风险提示 → 引用源**，外加「工具调用轨迹」附录。

## 4b. 生成可视化展示页（可选，10 秒）

```bash
npm run showcase       # -> web/index.html（自包含单文件，双击即可离线打开）
```

把最新一次 demo 的结果渲染成一个可投屏/发给面试官的展示页，含四个标签页：
**架构与编排**（3 server + 5 工具数据流）、**简报正文**（Markdown 原文渲染，表格/sparkline/引用链接）、
**协议校验 + 调用轨迹**（实跑 `validate-mcp.mjs` 的 PASS 结果与逐次工具调用）、**工具契约 + 上手命令**。
页面不依赖任何外部资源或网络，`web/index.html` 单文件拷走即可演示。加 `--no-validate` 可跳过校验步骤快速重建。

## 5. 常用变体

```bash
# 完全离线（用本地 fixture 新闻集）
NEWS_MODE=fixture node agent/src/index.mjs --query "Pilbara 锂矿" -o agent/output/offline.md

# 换成真实的上市公司技术报告 PDF（需可公网访问）
node agent/src/index.mjs --query "Greenbushes 锂矿" \
  --pdf "https://example.com/technical-report.pdf"

# 换个品种 / 换时间窗
node agent/src/index.mjs --query "氢氧化锂价格走势" --days 14 --trend-days 90

# 只连其中两个 server
node agent/src/index.mjs --servers "lime-price-mcp,mineral-pdf-mcp" --query "锂价"

# 交互式 REPL
node agent/src/index.mjs --serve

# 查看 Agent 发现的工具目录
node agent/src/index.mjs --list-tools
```

## 6. 接入 Claude Desktop / Cursor 验证

仓库根的 `mcp-config.json` 使用 `${VAR:-default}` 占位（Agent 自己会展开），但 Claude Desktop / Cursor **不会**展开占位符，也不解析相对路径。生成一份「绝对路径 + 字面值」的客户端配置：

```bash
npm run config:client      # -> mcp-config.client.json
```

然后把 `mcp-config.client.json` 里的 `mcpServers` 块粘进：

- Claude Desktop：`claude_desktop_config.json`（设置 → Developer → Edit Config）
- Cursor：`Settings → MCP → Add server`，或项目内 `.cursor/mcp.json`

保存后重启客户端，应能看到 3 个 server、5 个工具。可直接问：
> "用 mining-news-mcp 搜一下 Pilbara 锂矿最近 7 天的新闻，再用 lime-price-mcp 告诉我锂辉石价格。"

## 7. Docker 路径（可选，本机未安装 Docker 也能跑，§1–§4 是纯 Node）

```bash
docker compose build
docker compose run --rm agent          # 生成默认 Pilbara 简报，写到 ./agent/output/
docker compose run --rm agent node scripts/validate-mcp.mjs   # 只跑协议校验
AGENT_QUERY="氢氧化锂 风险" docker compose run --rm agent      # 中文请求（compose 变量值支持 UTF-8）
```

三个 server 各自带 `healthcheck`（复用 `validate-mcp.mjs`），`agent` 是一次性任务容器。

## 8. 启用 LLM ReAct 编排（可选，默认不开）

默认走**确定性 planner**：无需模型即可产出完整简报，且结果可复现。
配好任意 OpenAI 兼容端点后，Agent 自动切换为 LLM 驱动的 ReAct 循环（模型自己决定调用哪个工具、调几次）：

```bash
cp .env.example .env
# 编辑 .env：填 OPENAI_API_KEY / LLM_BASE_URL / LLM_MODEL
node agent/src/index.mjs --mode llm --query "Pilbara 锂矿今日简报"
```

- `--mode auto`（默认）：有 key 用 ReAct，无 key 用确定性 planner；ReAct 一无所获时自动回退
- 即使走 ReAct，**所有数字仍来自工具返回值**，LLM 只负责挑选证据与撰写文字
- 报告头部的 `编排模式` 字段会标明本次实际用了哪条路径

## 9. 数据来源与诚实说明

| Server | 数据来源 | 生产替换点 |
|---|---|---|
| `mining-news-mcp` | **实时** RSS：mining.com、australianmining.com.au（30 分钟磁盘缓存 + 陈旧缓存兜底）；断网时降级到 `fixtures/news.json` | 在 `FEEDS` 数组增加源，或接 GDELT/Bloomberg 之类 API |
| `mineral-pdf-mcp` | 真实 PDF 下载 + `pdfjs-dist` 文本层抽取 + NI 43-101 启发式解析；演示用 `fixtures/pdfs/` 下的合成报告 | 直接把 `--pdf` 指向上市公司公告 PDF |
| `lime-price-mcp` | **确定性合成序列**（按 品种+日期 播种，可复现），返回值中 `data_note` 明确标注 | 设 `PRICE_API_URL` 指向有授权的价格源，代码零改动切换 |

> 价格数据不是真实行情。之所以这样设计：面试题要求 5 分钟可复现地跑通，而真实锂价 API 需要授权。
> 工具契约（`get_price`/`get_trend`）与真实源完全一致，替换只需一个环境变量。

## 10. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `MCP error -32000: Connection closed` | server 启动即报错。单独跑 `node servers/<name>/src/index.mjs` 看 stderr；常见是 Node < 18.17 |
| `Cannot find module '../../../shared/...'` | 从子目录直接跑了脚本。请在**仓库根目录**执行所有 `npm run` / `node` 命令 |
| 新闻只有 fixture 内容 | 网络被拦截或 RSS 403。设 `NEWS_MODE=auto`（默认），或检查代理；server 的 stderr 会打印每个 feed 的成功/失败 |
| PDF 解析返回 `error` | 该 PDF 是扫描件（无文本层）或不是 NI 43-101 报告。先用 `fixture:pilbara_ni43101_sample` 验证链路，再排查具体文件 |
| Windows 路径含中文导致报错 | 已验证 `D:\Qoder\面试题` 路径可跑通；如仍有问题，把项目移到纯 ASCII 路径 |
| 想看 server 日志 | Agent 会把 server 的 stderr 转发到 `log [server-name] ...`，默认已在打印 |
