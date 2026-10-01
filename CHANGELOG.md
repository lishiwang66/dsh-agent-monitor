# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-01

首个版本：DSH Web GUI 的只读实时监测面板。

### 新增

- **host 半**：订阅 `session/event`、`agent/assistant-stream`、`agent/status`、`api-session/status`、
  `subagent/*`、`workflow/*`、`goal/changed`；启动时按 revision 回填历史；投影缓存交叉校验。
- **记账**：`usage` 归一成四个互不相交的 token 桶（未命中输入 / 缓存命中 / 缓存写入 / 输出），
  按**事件时间戳**判定北京时间峰谷、按官方价目计算花费；本轮 / 本次会话 / 今日（全机器）三层累计。
- **金额**：内置 `deepseek-flash` 与 `deepseek-v4-pro` 两档可编辑单价表（空闲 / 高峰 各三项），
  并叠加账号钱包余额（真实值，每 60s 自动刷新）。
- **面板**：现代仪表盘式 UI —— 渐变统计卡、分段过滤（带实时计数）、本地搜索、
  可折叠 turn 分组活动流、键值详情栏、助手建议卡、14 天花费时间轴、底部操作条。
  用 CSS 容器查询自适应：右栏单列堆叠 / 整页三栏（左导航 + 内容 + 详情）。
- **入口**：右侧栏常驻 tab、侧边栏图标（整页版）、右侧栏「+」菜单（guide）、`Ctrl+`` ` 快捷键。
- **只读与安全**：不向 DSH 写任何东西；所有文本在进入内存缓冲前完成脱敏；
  自建 HTTP 路由逐条调用 `ctx.connection.requestRejection` 鉴权门。

### 验证

- `selftest.mjs`：56 项（峰谷、四桶、计价、脱敏、截断、告警、回填去重、拼接 zstd 帧走查器）。
- `client-selftest.mjs`：42 项（bundle 外壳、四处注册、快捷键、仪表盘真实渲染、CSS 静态检查）。
- `verify-against-dsh.mjs`：把真实会话日志喂进采集器，与 DSH 自己的投影缓存**逐桶对账，逐位一致**。

### 已知近似

- 法定节假日无法判定，会被当成高峰时段（略微高估）。
- 配置（阈值 / 单价表）只存在内存里，Host 重启后回到默认。
- 钱包余额是账号级的，与估算对不上时以余额为准。
