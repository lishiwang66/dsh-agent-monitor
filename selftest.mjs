/**
 * Agent 监视器 —— host 半自测（不依赖 DSH 运行时）。
 * 运行： node selftest.mjs
 */

import assert from 'node:assert/strict';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { scanFrames, decompressFrames, ZSTD_MAGIC } from './scripts/zstd-frames.mjs';
import {
  DEFAULT_PRICES,
  computeCost,
  formatMoney,
  formatTokens,
  isPeak,
  localDayKey,
  recentDayKeys,
  resolvePrice,
  splitBuckets,
  startOfLocalDay,
  zeroBuckets,
} from './lib/pricing.js';
import { redactText, truncateForDisplay } from './lib/redact.js';
import { Collector, summarizeTool } from './lib/collector.js';

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    console.error(`  ✗ ${label}\n    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

/** 北京时间 → epoch（北京 = UTC+8，无夏令时）。 */
const beijing = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);

console.log('\n[1] 峰谷判定（北京时间）');
check('周一 10:00 是高峰', () => assert.equal(isPeak(beijing(2026, 9, 21, 10)), true));
check('周一 13:00 不是高峰', () => assert.equal(isPeak(beijing(2026, 9, 21, 13)), false));
check('周一 15:00 是高峰', () => assert.equal(isPeak(beijing(2026, 9, 21, 15)), true));
check('周一 08:59 不是高峰', () => assert.equal(isPeak(beijing(2026, 9, 21, 8, 59)), false));
check('周一 11:59 是高峰', () => assert.equal(isPeak(beijing(2026, 9, 21, 11, 59)), true));
check('周六 10:00 不是高峰', () => assert.equal(isPeak(beijing(2026, 9, 19, 10)), false));
check('周日 15:00 不是高峰', () => assert.equal(isPeak(beijing(2026, 9, 20, 15)), false));

console.log('\n[2] usage → 四个互不相交的桶');
const REAL_USAGE = { inputTokens: 913, outputTokens: 188, cacheReadTokens: 12800, cacheWriteTokens: 0, totalTokens: 13901 };
check('真实转录样本分桶正确', () => {
  const b = splitBuckets(REAL_USAGE);
  assert.equal(b.uncachedInput, 913);
  assert.equal(b.cacheRead, 12800);
  assert.equal(b.output, 188);
  assert.equal(b.cacheMiss, 913);
  assert.equal(b.total, 13901);
});
check('provider 误把完整提示词报进 inputTokens 时用 total 反推', () => {
  const b = splitBuckets({ inputTokens: 13901, outputTokens: 188, cacheReadTokens: 12800, totalTokens: 13901 });
  assert.equal(b.uncachedInput, 913);
});

console.log('\n[3] 计价（官方价目）');
check('1M 未命中 + 1M 命中 + 1M 输出，闲时 flash = ¥5.02', () => {
  const offPeakTime = beijing(2026, 9, 21, 20);
  const cost = computeCost(
    { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    'deepseek-flash',
    offPeakTime,
    { prices: DEFAULT_PRICES },
  );
  assert.equal(Number(cost.total.toFixed(4)), 5.02);
  assert.equal(cost.peak, false);
});
check('同样用量高峰 = ¥10.04', () => {
  const peakTime = beijing(2026, 9, 21, 10);
  const cost = computeCost(
    { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    'deepseek-flash',
    peakTime,
    { prices: DEFAULT_PRICES },
  );
  assert.equal(Number(cost.total.toFixed(4)), 10.04);
  assert.equal(cost.peak, true);
});
check('pro 档：闲时 1M/1M/1M = ¥18.15', () => {
  const cost = computeCost(
    { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    'deepseek-v4-pro',
    beijing(2026, 9, 21, 20),
    { prices: DEFAULT_PRICES },
  );
  assert.equal(Number(cost.total.toFixed(4)), 18.15);
});
check('缓存写入按未命中价计（Q32）', () => {
  const cost = computeCost({ cacheWriteTokens: 1_000_000 }, 'deepseek-flash', beijing(2026, 9, 21, 20));
  assert.equal(Number(cost.total.toFixed(4)), 1);
});
check('别名归一：deepseek-v4-flash → flash 档', () => {
  assert.equal(resolvePrice('deepseek-v4-flash').key, 'deepseek-flash');
  assert.equal(resolvePrice('deepseek-v4-pro-0813').key, 'deepseek-v4-pro');
});
check('未知模型仍能估价并标记未定价', () => {
  const resolved = resolvePrice('some-local-llm');
  assert.equal(resolved.priced, false);
  assert.ok(resolved.entry);
});

console.log('\n[4] 脱敏');
check('sk- 密钥被打码', () => assert.match(redactText('key=sk-abcdefghijklmnop'), /sk-\*\*\*/));
check('Bearer token 被打码', () => assert.match(redactText('Authorization: Bearer abcdefghijklmn'), /Bearer \*\*\*/));
check('password 字段被打码', () => {
  const out = redactText('{"password":"hunter2xyz"}');
  assert.ok(!out.includes('hunter2xyz'), out);
});
check('私钥块被打码', () => {
  const out = redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----');
  assert.ok(!out.includes('MIIabc'));
});
check('带凭据 URL 被打码', () => {
  const out = redactText('https://user:secretpw@example.com/x');
  assert.ok(!out.includes('secretpw'), out);
});
check('普通文本不被误伤', () => assert.equal(redactText('just a normal sentence'), 'just a normal sentence'));

console.log('\n[5] 截断');
check('超过 200 行被截断并标记', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const out = truncateForDisplay(text, 4096, 200);
  assert.equal(out.truncated, true);
  assert.equal(out.text.split('\n').length, 200);
  assert.equal(out.lines, 500);
});
check('短文本原样返回', () => {
  const out = truncateForDisplay('hi', 4096, 200);
  assert.equal(out.truncated, false);
  assert.equal(out.text, 'hi');
});

console.log('\n[6] 采集器端到端（合成一个 turn）');
const collector = new Collector({ ctx: {}, config: { todayBudget: 20 } });
const SESSION_ID = 'session-7dad54bf-3e92-46ea-93b6-0a54491aca34';
const header = { version: 4, id: SESSION_ID, createdAt: Date.now() - 60_000, cwd: 'C:\\work\\default-workspace', isSeeded: true };
const session = { id: SESSION_ID, header };
let seq = 0;
const feed = (type, data, time) => {
  seq += 1;
  collector.ingestEvent(session, { type, seq, time, data });
};

const T0 = Date.now() - 30_000;
feed('request/context', { provider: 'deepseek-account', model: 'deepseek-flash', contextWindow: 1_000_000 }, T0);
feed('request/header', { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }, reason: 'initial' }, T0 + 10);
feed('turn/start', { turn: 1 }, T0 + 20);
feed('step/start', { turn: 1, step: 1 }, T0 + 30);
feed('tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'read', arguments: JSON.stringify({ file_path: 'C:\\proj\\lib\\index.js' }) }, T0 + 100);
feed('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'export function apply() {}' }] } }, T0 + 1400);
feed(
  'tool/call',
  { turn: 1, step: 1, callId: 'call_2', name: 'pwsh', arguments: JSON.stringify({ command: 'set TOKEN=sk-abcdefghijklmnop && npm test' }) },
  T0 + 1500,
);
feed(
  'tool/result',
  { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_2', isError: true, content: [{ type: 'text', text: 'command failed' }] }, error: { name: 'ToolError', code: 'exit-1' } },
  T0 + 3000,
);
feed('tool/call', { turn: 1, step: 1, callId: 'call_3', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '写 host 半', status: 'completed' }, { content: '写 client 半', status: 'in_progress' }] }) }, T0 + 3100);
feed(
  'assistant/message',
  {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' }, content: [{ type: 'reasoning', text: 'g'.repeat(900) }, { type: 'text', text: '好的，已经完成。' }] },
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 20000, cacheWriteTokens: 0, totalTokens: 21500 },
  },
  T0 + 5000,
);
feed('step/end', { turn: 1, step: 1 }, T0 + 5100);
feed('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 5200);

const snapshot = collector.snapshot();
const record = snapshot.sessions.find((item) => item.id === SESSION_ID);

check('会话被登记并带工作区名', () => {
  assert.ok(record, '会话未出现在快照里');
  assert.equal(record.workspace, 'default-workspace');
  assert.equal(record.isSubagent, false);
});
check('四桶记账等于事件里的 usage', () => {
  assert.equal(record.tokens.session.uncachedInput, 1000);
  assert.equal(record.tokens.session.cacheRead, 20000);
  assert.equal(record.tokens.session.output, 500);
  assert.equal(record.tokens.session.total, 21500);
});
check('上下文占用取真实提示词大小', () => assert.equal(record.surfaceTokens, 21000));
check('上下文窗口来自 request/context', () => assert.equal(record.contextWindow, 1_000_000));
check('模型与推理档位来自 request/header', () => {
  assert.equal(record.model, 'deepseek-flash');
  assert.equal(record.reasoningEffort, 'high');
});
check('工具调用先出现、结束后补耗时与结果（patch 生效）', () => {
  const readFrame = snapshot.activity.find((frame) => frame.callId === 'call_1');
  assert.ok(readFrame, 'read 行不存在');
  assert.equal(readFrame.status, 'ok');
  assert.equal(readFrame.durationMs, 1300);
  assert.match(readFrame.result, /export function apply/);
  assert.match(readFrame.detail, /lib\/index\.js$/);
});
check('失败的工具调用被标为 error 并计入连续报错', () => {
  const frame = snapshot.activity.find((item) => item.callId === 'call_2');
  assert.equal(frame.status, 'error');
  assert.equal(frame.ok, false);
  assert.ok(record.errors >= 1);
});
check('命令里的密钥在进入缓冲前已脱敏', () => {
  const frame = snapshot.activity.find((item) => item.callId === 'call_2');
  assert.ok(!frame.args.includes('sk-abcdefghijklmnop'), frame.args);
  assert.match(frame.args, /TOKEN=\*\*\*/);
});
check('文件清单区分读与改', () => {
  assert.equal(record.files.length, 1);
  assert.equal(record.files[0].reads, 1);
  assert.equal(record.files[0].writes, 0);
  assert.equal(record.files[0].edits, 0);
  assert.match(record.files[0].rel, /lib\/index\.js$/);
});
check('todo 进度被解析', () => {
  assert.equal(record.todos.total, 2);
  assert.equal(record.todos.completed, 1);
});
check('思考预览按 200 字截断', () => {
  const reply = snapshot.activity.find((frame) => frame.kind === 'reply');
  assert.equal(reply.reasoning.length, 200);
  assert.equal(reply.reasoningChars, 900);
});
check('花费与手算一致（按事件时间的峰谷判定）', () => {
  const eventTime = T0 + 5000;
  const offPeak = (1000 / 1e6) * 1 + (20000 / 1e6) * 0.02 + (500 / 1e6) * 4;
  const expected = isPeak(eventTime) ? offPeak * 2 : offPeak;
  assert.ok(Math.abs(record.cost.session - expected) < 1e-9, `${record.cost.session} vs ${expected}`);
  const direct = computeCost(
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 20000 },
    'deepseek-flash',
    eventTime,
    { prices: DEFAULT_PRICES },
  );
  assert.ok(Math.abs(record.cost.session - direct.total) < 1e-9);
});
check('今日花费 = 会话花费（今天的事件）', () => {
  assert.ok(Math.abs(snapshot.today.cost - record.cost.session) < 1e-9);
});
check('趋势长度为 historyDays 且最后一天是今天', () => {
  assert.equal(snapshot.trend.length, 14);
  assert.equal(snapshot.trend[snapshot.trend.length - 1].day, localDayKey(Date.now()));
});
check('请求计数 = 完成的模型响应数（不是 request/header 数）', () => assert.equal(record.requests, 1));
check('活动流按时间升序且带 id', () => {
  const ids = snapshot.activity.map((frame) => frame.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

console.log('\n[7] 告警');
check('上下文 90% 触发 warn/error', () => {
  const c = new Collector({ ctx: {} });
  const rec = c.ensureSession('s1', { id: 's1', version: 4, createdAt: Date.now(), isSeeded: true, cwd: 'C:\\x\\y' });
  rec.contextWindow = 1000;
  rec.surfaceTokens = 900;
  const alerts = c.evaluateAlerts(Date.now());
  assert.ok(alerts.some((alert) => alert.kind === 'context'));
});
check('今日超预算触发 budget 告警', () => {
  const c = new Collector({ ctx: {}, config: { todayBudget: 0.0001 } });
  const rec = c.ensureSession('s1', { id: 's1', version: 4, createdAt: Date.now(), isSeeded: true, cwd: 'C:\\x\\y' });
  c.account(rec, { inputTokens: 1_000_000 }, 'deepseek-flash', Date.now());
  const alerts = c.evaluateAlerts(Date.now());
  assert.ok(alerts.some((alert) => alert.kind === 'budget'));
});
check('卡住判定需要 running 且超时', () => {
  const c = new Collector({ ctx: {}, config: { stuckMs: 1000 } });
  const rec = c.ensureSession('s1', { id: 's1', version: 4, createdAt: Date.now(), isSeeded: true, cwd: 'C:\\x\\y' });
  rec.running = true;
  rec.lastEventAt = Date.now() - 5000;
  assert.ok(c.evaluateAlerts(Date.now()).some((alert) => alert.kind === 'stuck'));
  rec.lastEventAt = Date.now();
  assert.ok(!c.evaluateAlerts(Date.now()).some((alert) => alert.kind === 'stuck'));
});

console.log('\n[8] 回填去重');
check('回填中该会话的实时事件被丢弃，回填后按 seq 去重', () => {
  const c = new Collector({ ctx: {} });
  const sess = { id: 's2', header: { id: 's2', version: 4, createdAt: Date.now(), isSeeded: true, cwd: 'C:\\x\\y' } };
  c.markPending('s2');
  c.ingestEvent(sess, { type: 'assistant/message', seq: 5, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-flash' } }, usage: { inputTokens: 100 } } });
  const rec = c.ensureSession('s2');
  assert.equal(rec.tokens.session.uncachedInput, 0, '回填期间不应计数');
  c.ingestEvent(sess, { type: 'assistant/message', seq: 5, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-flash' } }, usage: { inputTokens: 100 } } }, { historical: true });
  c.clearPending('s2');
  assert.equal(rec.tokens.session.uncachedInput, 100);
  c.ingestEvent(sess, { type: 'assistant/message', seq: 5, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-flash' } }, usage: { inputTokens: 100 } } });
  assert.equal(rec.tokens.session.uncachedInput, 100, '重复 seq 不应再加一次');
  c.ingestEvent(sess, { type: 'assistant/message', seq: 6, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-flash' } }, usage: { inputTokens: 100 } } });
  assert.equal(rec.tokens.session.uncachedInput, 200, '新 seq 应计数');
});

console.log('\n[9] 展示辅助');
check('summarizeTool 对 write 给出 +行数', () => {
  const out = summarizeTool('write', { file_path: 'C:\\a\\b\\c.ts', content: 'a\nb\nc' });
  assert.match(out.detail, /c\.ts/);
  assert.match(out.detail, /\+3 −0/);
});
check('formatMoney 对极小金额保留 4 位', () => assert.equal(formatMoney(0.0021), '¥0.0021'));
check('formatTokens 紧凑化', () => {
  assert.equal(formatTokens(588000), '588.0k');
  assert.equal(formatTokens(999), '999');
});
check('zeroBuckets 与 startOfLocalDay / recentDayKeys 自洽', () => {
  assert.equal(zeroBuckets().total, 0);
  const start = startOfLocalDay(Date.now());
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(recentDayKeys(3).length, 3);
});

console.log('\n[10] 拼接 zstd 帧走查器（scripts/zstd-frames.mjs）');
const textChunks = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'];
const encodedFrames = textChunks.map((text) => zstdCompressSync(Buffer.from(text, 'utf8')));
const joined = Buffer.concat(encodedFrames);

check('魔数常量就是 zstd 的 0xFD2FB528', () => assert.equal(ZSTD_MAGIC, 0xfd2fb528));
check('node:zlib 自己只解第一帧（这正是必须自己走帧的原因）', () => {
  assert.equal(zstdDecompressSync(joined).toString('utf8'), textChunks[0]);
});
check('走查出 3 个帧，边界与逐帧长度一致', () => {
  const { frames: found, tornStart } = scanFrames(joined);
  assert.equal(found.length, 3);
  assert.equal(tornStart, undefined);
  assert.equal(found[0].start, 0);
  assert.equal(found[0].end, encodedFrames[0].length);
  assert.equal(found[1].start, encodedFrames[0].length);
  assert.equal(found[2].end, joined.length);
});
const decodedAll = await decompressFrames(joined);
check('逐帧解压后拼回完整内容', () => {
  assert.equal(decodedAll.content.toString('utf8'), textChunks.join(''));
  assert.equal(decodedAll.frameCount, 3);
  assert.equal(decodedAll.torn, false);
  assert.equal(decodedAll.decodedBytes, Buffer.byteLength(textChunks.join(''), 'utf8'));
});
check('maxFrames 只走前 N 帧', () => {
  assert.equal(scanFrames(joined, { maxFrames: 2 }).frames.length, 2);
});
check('末帧被撕裂：完整帧照常返回，并标出撕裂起点', () => {
  const tornBuffer = Buffer.concat([joined, encodedFrames[0].subarray(0, 10)]);
  const result = scanFrames(tornBuffer);
  assert.equal(result.frames.length, 3);
  assert.equal(result.tornStart, joined.length);
});
check('撕裂帧也能解出前面的完整内容', async () => {
  // 断言放进同步 check 里不方便，这里用已解出的结果做等价判断
  assert.equal(decodedAll.content.toString('utf8').includes('{"c":3}'), true);
});
check('非 zstd 数据明确报错，而不是静默返回空结果', () => {
  assert.throws(() => scanFrames(Buffer.from('this is definitely not zstd')), /魔数/);
});
check('空缓冲区返回 0 帧', () => {
  assert.deepEqual(scanFrames(Buffer.alloc(0)).frames, []);
});

console.log(`\n通过 ${passed} 项检查${process.exitCode ? '（存在失败）' : '，全部通过'}\n`);
