---
name: agent-monitor
description: Install, verify, and read the Agent Monitor — a read-only real-time dashboard plugin for the DeepSeek Harness Web GUI showing what an agent is doing (tool calls, files, subagents, errors) and what it costs (token buckets, context pressure, spend, wallet balance). Use when the user asks to monitor an agent in real time, track token usage or spend, watch context pressure, or asks "what did you do / how much did this cost" while a session runs.
---

# Agent Monitor

`dsh-agent-monitor` 是 DSH Web GUI 的一个客户端插件：右侧栏一个常驻 tab，实时显示**在干什么**与**花了多少**。
纯只读 —— 不改运行时、不写 DSH 数据、不额外落盘。

## 何时用它回答用户

- 「你现在在干什么？」→ 读**活动流**（工具行 + 耗时 + 状态字形）。
- 「这次/今天花了多少钱？」→ 读**统计卡**（本次会话花费 / 今日花费 · 全机器）与**钱包余额**。
- 「上下文还够吗？」→ 读**上下文占用**卡（已用 / 窗口 / 剩余）。
- 「是不是卡住了 / 怎么老报错？」→ 读**助手建议**卡与**错误**分段。
- 「总共跑了多少 token？」→ 读 **tokens** 卡；四个桶是互不相交的，别相加两次。

## 安装

插件包要能被 Loader 按名字解析。两种方式，选一种（**不要都做**，否则同一 id 插入两次）：

**A. 挂载式（不需要 pnpm，推荐）**

```powershell
# 1) 包放到 local-bundles（与 dsh-local-skills 同一约定）
Copy-Item -Recurse dsh-agent-monitor "$env:USERPROFILE\.dsh\local-bundles\dsh-agent-monitor"
# 2) profile 的 node_modules 里挂一个目录联接，让 name 可解析
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-agent-monitor" `
  -Target "$env:USERPROFILE\.dsh\local-bundles\dsh-agent-monitor"
```

然后在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-agent-monitor
      name: 'dsh-agent-monitor'
      config: {}
```

**B. bundle 式**：把包放进 profile 的 `node_modules`，在 profile `package.json` 的
`dependencies` 加 `"dsh-agent-monitor": "file:../../local-bundles/dsh-agent-monitor"`，
并把 `dsh-agent-monitor` 追加到 `dsh.profile.bundles` 末尾，然后在该目录 `pnpm install`。

> 客户端 bundle 改动会被产物监视器自动热重载（**不用刷新、不用重启**）；
> **host 半**（`lib/index.js` / `collector.js` / `pricing.js` / `redact.js`）的改动需要重启 DSH。

## 验证它活着

```powershell
# 1) Loader 入口在册（host Config 目录里应出现 include:dsh-agent-monitor）
#    用 cordis 的 Config inspect，或直接看日志里的 "[agent-monitor] host 半已加载"
# 2) 路由已注册且鉴权门生效：未带 cookie 的原始请求应得到 401（不是 404，也不是 200）
Invoke-WebRequest http://127.0.0.1:19387/agent-monitor/api/health -UseBasicParsing
# 3) 客户端 bundle 进了 boot graph 且可取（rev 变化说明热重载认到了新文件）
#    读 http://127.0.0.1:19387/plugins/events 的 SSE 首帧，找 id=dsh-agent-monitor 的 url/rev
```

## 打开与使用

| 入口 | 行为 |
|---|---|
| `Ctrl+`` ` | 右栏已开→关；未开→在屏幕上那个会话的右栏打开；没有会话→提示先开会话 |
| 侧边栏图标 | 整页版（≥980px 时是三栏：左导航 / 内容 / 右侧详情） |
| 右侧栏「+」菜单 | 选「Agent 监视器」 |

界面元素：渐变统计卡 · 助手建议 · 分段过滤（全部/工具/回复/错误/其他，带计数）· 本地搜索 ·
实时行 · 按 turn 分组的活动流（点行展开参数/输出/思考/正文）· 文件表 · 会话列表 · 详情栏 · 底部导出条。

## 数字从哪来、别读错

| 指标 | 来源 |
|---|---|
| 四个 token 桶 | `assistant/message` 的 `usage`；`inputTokens` 已经是**未命中输入** |
| 上下文占用 | 取**上一次请求的提示词大小**（比投影缓存更新）；窗口来自 `request/context` |
| 花费 | 按**事件时间戳**判定北京时间峰谷 × 可编辑单价表 |
| 请求次数 | 完成的模型响应数（`assistant/message`）+ 重试次数；**不是** `request/header` 的条数 |
| 速率 / 首字 / 耗时 | 投影缓存的 `sessionStats`（`decodeTokens/decodeMs`、`ttftMs/ttftSteps`、`llmMs`、`toolMs`） |
| 今日 / 历史 | 全机器所有会话按本地自然日汇总；历史来自启动时的回填（按 revision 判失效） |
| 钱包余额 | `ctx.deepseekAccount.getBalance()` —— **账号级真实值**，与估算对不上时以它为准 |

已知近似：**法定节假日无法判定**（会被当高峰，略微高估）；配置只在内存（Host 重启即回默认）。

## 安全边界

- 只读：host 半只订阅事件、读会话与投影缓存、读账号余额，**不写任何东西**。
- 脱敏：任何文本（工具参数、命令、输出、错误）在**进入内存缓冲之前**先过 `redact.js`，
  界面、SSE 推送、导出文件共用同一份已脱敏数据。导出不会成为泄露旁路。
- 鉴权：自建路由逐条调用 `ctx.connection.requestRejection(req)`。
  这不是可选项 —— webserver 对插件路由**没有**全局鉴权门。
- 推送走自建 HTTP + SSE：`ctx.remote.$on()` 的合法频道是硬编码白名单，收不到 `session/event` 这类事件。

## 配置

面板「设置」页可改：活动流保留条数、今日预算、上下文告警线、卡住判定、连续报错次数、
趋势天数、思考预览字数、峰谷计价开关、自动脱敏开关，以及两档单价表（缓存命中 / 未命中 / 输出 × 空闲 / 高峰）。

## 自测

```bash
node selftest.mjs            # host 半 56 项：峰谷、四桶、计价、脱敏、截断、告警、回填去重、拼接 zstd 帧走查
node client-selftest.mjs     # client 半 42 项：bundle 外壳、四处注册、快捷键、仪表盘真实渲染、CSS 静态检查
node verify-against-dsh.mjs  # 硬对账：真实会话日志 → 采集器 → 与 DSH 投影缓存逐桶比对（需要本机有 DSH 数据）
```

`client-selftest.mjs` 用 mock React 真的把面板渲染成元素树，所以首帧崩溃、字段改名、区块消失
这类问题会在测试里直接暴露，而不是等用户看见白屏。

## 卸载

1. 删掉 profile `cordis.patch.yml` 里那段 `- insert: [dsh-agent-monitor …]`
2. 删掉 `~\.dsh\profiles\desktop\node_modules\dsh-agent-monitor`（联接）
3. 可选：删掉 `~\.dsh\local-bundles\dsh-agent-monitor`
