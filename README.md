# Agent 监视器（dsh-agent-monitor）

[![tests](https://github.com/lishiwang66/dsh-agent-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/lishiwang66/dsh-agent-monitor/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DSH Web GUI 的客户端插件：**现代仪表盘式的实时监测面板**。一屏看清「我在做什么」和「花了多少」。

- 右侧栏一个常驻 tab（与「文件 / 文档 / 指南」并列），侧边栏图标 → 整页版
- `Ctrl+`` ` 呼出 / 收起（走宿主正规的 `ctx.shortcuts`，没有会话时返回 blocked 并给出原因）
- **纯只读**：不改运行时、不写 DSH 数据、不额外落盘

## 打开方式

| 入口 | 行为 |
|---|---|
| `Ctrl+`` ` | 右栏已开→关；未开→在屏幕上那个会话的右栏打开；没有会话→提示「先打开一个会话」 |
| 侧边栏图标 | 打开整页版（`main` 面板） |
| 右侧栏「+」菜单 | 选「Agent 监视器」（guide 入口，最不依赖快捷键与选中态） |

## 界面

**一套结构，两种布局**（用 CSS 容器查询自适应，不是两套代码）：

- **窄（右侧栏 ~400px）**：单列纵向堆叠 —— 顶栏 → 统计卡 → 建议 → 分段过滤 → 实时行 → 分组活动流 → 详情卡 → 底部操作条
- **宽（整页 ≥980px）**：自动变成三栏 —— **左导航 / 中间内容 / 右侧详情**，就是下面这张图

```
┌ Agent 监视器 ────────────────────────────────────────────────────────────────┐
│ ✦ Agent 监视器              ⌕ 搜索活动…     ⟳ ⏸ ⌫ ⊞ ✕                      │
│ 实时活动 · token 与花费 · 上下文压力 · 只读                                   │
│ [● 实时] [session 7dad54bf] [default-workspace] [deepseek-account/flash]      │
├──────────┬──────────────────────────────────────────┬────────────────────────┤
│ ▦ 仪表盘  │ ┏━━━━━━━━━━━┓┏━━━━━━━━━━━┓┏━━━━━━━━━━━┓ │ ⌗ 会话详情             │
│ ≡ 活动流7│ ┃本次会话花费┃┃今日花费·全机器┃┃本次会话token┃ │  会话      7dad54bf    │
│ ▤ 文件  2│ ┃  ¥0.842   ┃┃  ¥3.19    ┃┃  608.5k    ┃ │  工作区  default-…     │
│ ❐ 会话  2│ ┃608.5k tok ┃┃16% 预算¥20 ┃┃命中98% 已省┃ │  模型    deepseek-…    │
│ ⚙ 设置   │ ┃7 请求     ┃┃剩 ¥16.81  ┃┃¥0.576 出8.1k┃ │  推理档位  high         │
│          │ ┗━━━━━━━━━━━┛┗━━━━━━━━━━━┛┗━━━━━━━━━━━┛ │  轮次/步骤  4 / 7       │
│          │ ┏━━━━━━━━━━━┓                            │  模型请求  7            │
│          │ ┃上下文占用  ┃                            │  工具调用  23           │
│          │ ┃   62%      ┃                            │  报错/重试  1 / 1       │
│          │ ┃620.0k/1.00M┃                            │  运行状态  运行中        │
│          │ ┗━━━━━━━━━━━┛                            │ ─────────────────────  │
│          │ ✦ 助手建议                                 │ ⚡ 速度与耗时            │
│          │  • 上下文占用 62%（620k/1.00M）            │  首字延迟  627ms        │
│          │  • 本会话有 1 次报错，可切到「错误」…       │  模型耗时  18.5s        │
│          │  • 上下文剩余 380.0k，约占窗口 38%         │  工具耗时  6.3s         │
│          │  • 缓存命中让本次会话省下 ¥0.576           │  解码  13.5s / 3.89k    │
│          │  [查看错误行]                              │ ⌗ 标签                  │
│          │ ▌思考中 思考 1240 字 2.2s 12.3 tok/s       │ ¥ 钱包余额 ⟳            │
│          │ [全部 7][工具 3][回复 1][错误 1][其他 2]   │  ¥41.20  赠送 ¥5.00     │
│          │ ▾ ● turn 4   4   3.0s 21.5k tok ¥0.0068 1错│ ▤ 最近文件  2          │
│          │    15:53:28 ✓ read  lib/index.js    400ms │  lib/index.js +42 −7    │
│          │    15:53:29 ✗ pwsh  pnpm build █████ 8.4s │ ◷ 最近 14 天花费         │
│          │ ▾ ● 无轮次   1                   5s 前     │  ▁▂▃▅▁█▃▇  今天        │
│          │    15:53:31 ✓ subagent 子代理结束 · 调研   │  峰值 ¥3.40 今日 ¥3.19  │
├──────────┴──────────────────────────────────────────┴────────────────────────┤
│ Ctrl+` 呼出/收起 │ 只读 │ 2 会话 │ 今日 ¥3.19 │ 608.5k tok │ 缓冲 8/500       │
│              [活动 CSV][每日 CSV][会话 CSV][模型 CSV]  [✓ 完整 JSON]          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**视觉语言**：渐变统计卡（彩色的 `--tone` 渐变光晕 + 底部细进度线）、圆角软边框、分段控件、
可折叠分组列表（彩色圆点 + 计数 + 右侧元信息）、键值详情栏、标签胶囊、建议卡、时间轴柱状图、底部操作条（次要按钮 + 绿色主按钮）。
调色板取自主题层里真实存在的 `--dsw-static-green/amber/blue/deepseek-*` 与 `--dsw-alias-*`，
**每个 token 都带 fallback**，深浅主题都跟随，缺一层也不会变成透明块。

## 面板内容明细

**渐变统计卡（5 张）**：本次会话花费 · 今日花费（全机器，含预算进度与剩余）· 本次会话 tokens（含命中率与「已省多少钱」）· 上下文占用（含已用/窗口/剩余）· 生成速率（实时或会话均值 + 首字延迟）。

**建议卡**：把「该关心的事」按优先级列出来（告警 → 报错 → 上下文剩余 → 缓存省了多少钱 → 预算 → 重试），最多 5 条，并给一个可点的行动（有报错时「查看错误行」直接切到错误分段；否则「调整阈值与单价」）。

**分段过滤**：`全部 / 工具 / 回复 / 错误 / 其他`，每个带实时计数，纯前端过滤。
**搜索框**：对工具名、摘要、参数、输出、错误文本做子串匹配，并显示「匹配「xxx」」。

**活动流**：按 turn 分组的可折叠列表，组头有彩色圆点、条数、时长、token、花费、错误数与「多久前」；
行内是 `时间 │ 状态字形+工具 │ 摘要 │ 时长微条+耗时+token+花费`。点击展开 `▸ 参数 / ▸ 输出 / ▸ 思考 / ▸ 正文`，各带复制按钮。

**文件**：读 / 写 / 改次数、`±行数`、规模微条、最后访问时间。
**会话**：全部会话（运行中优先），今日花费微条 + token + 工具数 + 报错数；子代理带 `└父会话` 标记；点一行把活动流切到那个会话。
**详情栏**：会话键值（工作区/模型/档位/轮次/步骤/请求/工具/报错/状态/最后活动/创建时间）、目标与待办进度、速度与耗时、标签胶囊、钱包余额、最近文件、14 天花费时间轴。
**设置**：阈值（保留条数 / 今日预算 / 上下文告警线 / 卡住分钟 / 连续报错 / 趋势天数 / 思考预览字数）、开关（峰谷计价、自动脱敏）、两档单价表。
> ⚠️ 按「不额外落盘」的决策，这些值**只在内存里**，Host 重启后回到默认。

**顶栏图标按钮**：`⟳` 立即刷新 · `⏸` 暂停/继续 · `⌫` 清屏 · `⊞` 按 turn 分组开关 · `✕` 收起右栏。
**底部操作条**：状态线 + 四个 CSV 导出 + 绿色主按钮「完整 JSON」。

## 计价口径

单价取自 [DeepSeek 官方价目页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（元 / 百万 tokens）：

| 桶 | 空闲时段 | 高峰时段 |
|---|---|---|
| 缓存命中输入 `cacheReadTokens` | 0.02 | 0.04 |
| 缓存未命中输入 `inputTokens` | 1 | 2 |
| 缓存写入 `cacheWriteTokens` | 按未命中价 | 按未命中价 |
| 输出 `outputTokens` | 4 | 8 |

- 高峰 = 北京时间**周一至周五 09:00–12:00、14:00–18:00**，其余为空闲；峰谷**按每个事件的时间戳**判定。
- `deepseek-v4-pro` 档位：0.15 / 0.30、4.5 / 9.0、13.5 / 27。
- 已知近似：**法定节假日无法判定**，会被当成高峰（略微高估）。
- `inputTokens` 在 DSH 的离线字段里已经是「未命中输入」（实测 `inputTokens + cacheReadTokens + outputTokens === totalTokens`）；
  若某个 provider 反而把完整提示词长度报进来，用 `totalTokens` 反推修正。
- **请求次数按 `assistant/message`（完成的模型响应）+ 重试计数**：`request/header` 是请求系列/配置边界，不是每次请求
  （实测三个会话各只有 1 条，而实际模型请求是 16–46 次）。

## 数据来源（全部只读）

- `session/event`（提交后的事件流）→ 实时活动、工具耗时、`assistant/message` 的 usage 记账
- `agent/assistant-stream` → 实时「思考中 / 生成中 / 正在调用」指示（**不参与记账**，避免与提交事件重复计数）
- `sessionPersistence.list()` / `open(id,'read')` → 启动时回填历史（按 revision 判失效）
- `sessionProjectionCache.cachedSnapshot()` → 会话总览、`sessionStats`（速率/首字/耗时）与交叉校验
- `agent/status`、`api-session/status`、`subagent/*`、`workflow/*`、`goal/changed` → 运行状态、子代理、工作流、目标
- `deepseekAccount.getBalance()` → 钱包余额（账号级真实值）

回填期间该会话的实时事件会被丢弃，回填后按 `seq` 去重 —— 因为那些事件已经是持久事件，读日志时必然包含。

## 与宿主的两处关键约定

1. **推送走自建 HTTP 路由 + SSE**：`ctx.remote.$on()` 的合法频道是硬编码白名单，
   收不到 `session/event` / `assistant-stream` / `tools/result` 这类事件。
2. **每条路由自己做鉴权门**：webserver 对插件路由没有全局鉴权，
   这里每条路由都调 `ctx.connection.requestRejection(req)`（未登录的原始请求会得到 401）。

## 仓库结构

```
dsh-agent-monitor/
├─ SKILL.md                  # 给 agent 看的说明：怎么装、怎么验证、数字怎么读、安全边界
├─ lib/
│  ├─ index.js               # host 半：事件订阅、历史回填、HTTP + SSE 路由、钱包、导出
│  ├─ collector.js           # 采集与聚合：四桶记账、文件/待办/目标、告警、快照序列化
│  ├─ pricing.js             # 峰谷判定 + 四桶计价 + 可编辑单价表（flash / pro）
│  ├─ redact.js              # 脱敏与截断（入内存前完成）
│  └─ client.js              # client 半：仪表盘 UI（零构建 bundle，容器查询自适应）
├─ scripts/
│  └─ zstd-frames.mjs        # 拼接 zstd 帧走查器（独立实现，给对账脚本用）
├─ selftest.mjs              # host 半 56 项
├─ client-selftest.mjs       # client 半 42 项（mock React 真渲染 + CSS 静态检查）
├─ verify-against-dsh.mjs    # 与 DSH 投影缓存逐桶对账
├─ cordis.patch.yml          # bundle 层补丁
└─ .github/workflows/ci.yml  # CI：Node 22.15 / 24 双版本跑测试 + 检查无本机绝对路径
```

## 安装

### 方式 A：挂载式（不需要 pnpm，推荐）

```powershell
# 1) 包放进 local-bundles（与 dsh-local-skills 同一约定）
Copy-Item -Recurse dsh-agent-monitor "$env:USERPROFILE\.dsh\local-bundles\dsh-agent-monitor"
# 2) profile 的 node_modules 里挂一个目录联接，让 name 能被解析
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-agent-monitor" `
  -Target "$env:USERPROFILE\.dsh\local-bundles\dsh-agent-monitor"
```

在 profile 的 `cordis.patch.yml` 末尾追加（原文件建议先备份）：

```yaml
- insert:
    - id: dsh-agent-monitor
      name: 'dsh-agent-monitor'
      config: {}
```

### 方式 B：bundle 式

把包放进 profile 的 `node_modules`，在 profile `package.json` 的 `dependencies` 加
`"dsh-agent-monitor": "file:../../local-bundles/dsh-agent-monitor"`，并把 `dsh-agent-monitor`
追加到 `dsh.profile.bundles` 末尾，然后在 profile 目录执行 `pnpm install`。

> 两种方式**不要同时用**：同一个 `id` 会被插入两次，`webServer` 注册重复路由会抛错。

## 迭代方式

如果按上面的**方式 A** 安装、并且 `local-bundles\dsh-agent-monitor` 是指向本仓库工作副本的**目录联接**，
那么**没有同步步骤**：直接改这个目录里的文件即可。

```powershell
# 一次性建立「单一真相」：让 DSH 读的就是这个仓库工作副本
Remove-Item "$env:USERPROFILE\.dsh\local-bundles\dsh-agent-monitor" -Recurse -Force
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\local-bundles\dsh-agent-monitor" `
  -Target "<本仓库的绝对路径>"
```

如果你是**拷贝**过去的（不是联接），改完源码要同步一次：

```powershell
$src = '<本仓库>'; $dst = "$env:USERPROFILE\.dsh\local-bundles\dsh-agent-monitor"
Get-ChildItem $src -Recurse -File | ForEach-Object {
  $to = Join-Path $dst $_.FullName.Substring($src.Length + 1)
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  Copy-Item $_.FullName $to -Force
}
```

- 改 `lib/client.js`：产物监视器轮询 mtime/size，**页面自动换新，不用刷新**（可以用 `/plugins/events` 里的 rev 变化确认）。
- 改 host 半（`lib/index.js` / `collector.js` / `pricing.js` / `redact.js`）：需要重启 DSH 才生效。

## 自测与验证

```powershell
node selftest.mjs            # host 半 47 项：峰谷、四桶、计价、脱敏、截断、告警、回填去重
node client-selftest.mjs     # client 半 36 项：bundle 外壳、四处注册、快捷键、五个区块真实渲染、离线诊断
node verify-against-dsh.mjs  # 硬对账：真实会话日志 → 采集器 → 与 DSH 投影缓存逐桶比对
```

`client-selftest.mjs` 用 mock React 真的把面板渲染成元素树，所以首次渲染崩溃、字段改名、区块消失这类问题会在测试里直接暴露。

## 卸载

1. 删掉 `~\.dsh\profiles\desktop\cordis.patch.yml` 末尾的 `- insert: [dsh-agent-monitor …]` 段（或恢复 `.bak-before-agent-monitor`）
2. 删掉 `~\.dsh\profiles\desktop\node_modules\dsh-agent-monitor`（联接）
3. 可选：删掉 `~\.dsh\local-bundles\dsh-agent-monitor`
