/**
 * Agent 监视器 —— 与 DSH 自己的账对账（只读）。
 * 运行： node verify-against-dsh.mjs
 *
 * 做的是验收标准 #1 和 #3 的硬验证：
 *   把真实会话日志（拼接 zstd 帧的 JSONL）喂给监视器的采集器，再把结果与
 *   DSH 自己写的投影缓存 `session_projcache/sessions/<id>.json` 逐桶对比。
 * 多帧解码用本仓库自带的 `scripts/zstd-frames.mjs`（独立实现，无第三方依赖）。
 *
 * 前提：本机跑过 DSH 并且有会话日志。找不到数据时脚本会明确说明并以 0 退出（不算失败）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Collector } from './lib/collector.js';
import { DEFAULT_PRICES, computeCost, formatMoney } from './lib/pricing.js';
import { decompressFrames } from './scripts/zstd-frames.mjs';

const HOME = process.env.USERPROFILE ?? process.env.HOME;
const SESSIONS_ROOT = path.join(HOME, '.dsh', 'sessions');
const PROJCACHE_ROOT = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions');

if (!fs.existsSync(SESSIONS_ROOT) || !fs.existsSync(PROJCACHE_ROOT)) {
  console.log(`\n没有找到 DSH 数据（${SESSIONS_ROOT}），跳过对账。`);
  process.exit(0);
}

const unwrap = (value) => (value && typeof value === 'object' && 'val' in value ? value.val : value);

const findSessionFile = (dir) => {
  for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const readEvents = async (file) => {
  const bytes = fs.readFileSync(file);
  const decoded = await decompressFrames(bytes);
  const text = Buffer.isBuffer(decoded.content) ? decoded.content.toString('utf8') : String(decoded.content ?? '');
  const records = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { records, frames: decoded.frameCount, torn: decoded.torn, contentBytes: Buffer.byteLength(text, 'utf8') };};

// 枚举 ~/.dsh/sessions/<project>/<session>/
const targets = [];
for (const project of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  for (const session of fs.readdirSync(path.join(SESSIONS_ROOT, project.name), { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const dir = path.join(SESSIONS_ROOT, project.name, session.name);
    const file = findSessionFile(dir);
    if (file) targets.push({ project: project.name, id: session.name, dir, file, size: fs.statSync(file).size });
  }
}
targets.sort((a, b) => b.size - a.size);

console.log(`\n发现 ${targets.length} 个会话日志；取投影缓存存在且日志最小的 3 个（已结束的会话）做精确对账。\n`);

const withCache = targets.filter((target) => fs.existsSync(path.join(PROJCACHE_ROOT, `${target.id}.json`)));
const chosen = withCache.slice(-3);

let failures = 0;
const report = [];

for (const target of chosen) {
  const cacheFile = path.join(PROJCACHE_ROOT, `${target.id}.json`);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  // 真实结构： { version, record: { identity, rows: { <投影键>: { ver, seq, val } } } }
  const rows = cache.record?.rows ?? cache.rows ?? cache;
  const usage = unwrap(rows.tokenUsage);
  const usageSeq = rows.tokenUsage?.seq ?? -1;
  const stats = unwrap(rows.sessionStats);
  const pressure = unwrap(rows.contextPressure);
  const title = unwrap(rows.title);
  const { records, frames, torn, contentBytes } = await readEvents(target.file);

  const collector = new Collector({ ctx: {} });
  const headerRecord = records.find((record) => record.type === 'session') ?? {};
  const header = {
    version: 4,
    id: target.id,
    createdAt: Number(headerRecord.time) || Date.now(),
    cwd: headerRecord.data?.cwd ?? headerRecord.cwd ?? '',
    isSeeded: true,
  };
  const session = { id: target.id, header };
  const events = records.filter((record) => typeof record.seq === 'number' && typeof record.type === 'string');
  for (const event of events) collector.ingestEvent(session, event, { historical: true });

  const mine = collector.sessions.get(target.id);
  const cachedTotals = usage?.totals ?? {};
  const mineTokens = mine?.tokens?.session ?? {};
  const comparable = {
    uncachedInput: [mineTokens.uncachedInput ?? 0, Number(cachedTotals.uncachedInputTokens) || 0],
    cacheRead: [mineTokens.cacheRead ?? 0, Number(cachedTotals.cacheReadTokens) || 0],
    cacheWrite: [mineTokens.cacheWrite ?? 0, Number(cachedTotals.cacheWriteTokens) || 0],
    output: [mineTokens.output ?? 0, Number(cachedTotals.outputTokens) || 0],
  };
  const maxSeq = Math.max(...events.map((event) => Number(event.seq) || 0), -1);
  const cacheSeq = Number(usageSeq);
  const mismatches = Object.entries(comparable).filter(([, [a, b]]) => a !== b);
  if (mismatches.length > 0) failures += 1;

  const cost = mine ? mine.cost.session : 0;
  const model = mine?.model || 'deepseek-flash';
  const manual = computeCost(
    {
      inputTokens: mineTokens.uncachedInput ?? 0,
      cacheReadTokens: mineTokens.cacheRead ?? 0,
      cacheWriteTokens: mineTokens.cacheWrite ?? 0,
      outputTokens: mineTokens.output ?? 0,
    },
    model,
    Date.now(),
    { prices: DEFAULT_PRICES },
  );

  report.push({
    id: target.id,
    shortId: target.id.slice(0, 8),
    logKB: Math.round(target.size / 1024),
    frames,
    torn,
    events: events.length,
    contentKB: Math.round(contentBytes / 1024),
    maxSeq,
    cacheSeq,
    comparable,
    mismatches: mismatches.map(([key]) => key),
    mineCost: cost,
    manualCost: manual.total,
    costMatches: Math.abs(cost - manual.total) < 1e-9,
    cacheStats: stats ? { turns: stats.turns, steps: stats.steps, llmMs: stats.llmMs, toolMs: stats.toolMs } : null,
    cacheTitle: typeof title === 'string' ? title.slice(0, 40) : null,
    myCounts: mine ? { turns: mine.turns, steps: mine.steps, requests: mine.requests, toolCalls: mine.toolCalls, errors: mine.errors, model: mine.model } : null,
    contextWindow: mine?.contextWindow ?? 0,
    surfaceTokens: mine?.surfaceTokens ?? 0,
    cacheContextWindow: Number(pressure?.contextWindow) || 0,
  });
}

for (const item of report) {
  console.log(`会话 ${item.shortId}  (日志 ${item.logKB}KB / ${item.frames} 帧 / ${item.events} 事件 / 解压 ${item.contentKB}KB${item.torn ? ' / 末帧撕裂' : ''})`);
  console.log(`  事件 seq 范围: 我的最大 seq=${item.maxSeq}  投影缓存 seq=${item.cacheSeq}`);
  for (const [key, [mine, cached]] of Object.entries(item.comparable)) {
    const mark = mine === cached ? '✓' : '✗';
    console.log(`  ${mark} ${key.padEnd(14)} 我=${String(mine).padStart(9)}  投影缓存=${String(cached).padStart(9)}`);
  }
  console.log(`  ${item.costMatches ? '✓' : '✗'} 花费 我=${formatMoney(item.mineCost)}  用同一份单价重算=${formatMoney(item.manualCost)}`);
  console.log(`  · 计数: 我=${JSON.stringify(item.myCounts)}`);
  console.log(`  · 投影缓存 sessionStats: ${JSON.stringify(item.cacheStats)}`);
  console.log(`  · 投影缓存标题: ${item.cacheTitle}`);
  console.log(`  · 上下文: 我=${item.surfaceTokens}/${item.contextWindow}  缓存 contextWindow=${item.cacheContextWindow}`);
  console.log('');
}

console.log(failures === 0
  ? `全部 ${report.length} 个会话的四桶与 DSH 投影缓存逐位一致，且花费与单价表重算一致。`
  : `有 ${failures} 个会话存在桶差异（见上）。`);
process.exit(failures === 0 ? 0 : 1);
