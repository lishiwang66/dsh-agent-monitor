/**
 * Agent 监视器 —— client 半自测（mock 运行时，不需要浏览器）。
 * 运行： node client-selftest.mjs
 *
 * 做三件事：
 *   1. 真的把 lib/client.js 当 bundle 加载（验证语法与 bundle 外壳）
 *   2. 用 mock ctx 调 apply，核对四处注册与快捷键定义
 *   3. 用极简 React 把仪表盘与各区块真的渲染成元素树，核对真实数据形状能画出来
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODE = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');

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

// ─────────────────────────────── 极简 React
let lastSnapshotGetter = null;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect(fn) {
    fn();
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(value) {
    return { current: value };
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    lastSnapshotGetter = getSnapshot;
    return getSnapshot();
  },
  memo: (component) => component,
  Fragment: 'Fragment',
};

const renderText = (element, out = []) => {
  if (element === null || element === undefined || element === false || element === true) return out;
  if (Array.isArray(element)) {
    for (const item of element) renderText(item, out);
    return out;
  }
  if (typeof element === 'string' || typeof element === 'number') {
    out.push(String(element));
    return out;
  }
  if (typeof element.type === 'function') return renderText(element.type({ ...element.props, children: element.children }), out);
  // 宿主元素：把 placeholder 也当作可见文案收进来（input 没有子节点）
  if (typeof element.type === 'string' && typeof element.props?.placeholder === 'string') out.push(element.props.placeholder);
  for (const child of element.children) renderText(child, out);
  return out;
};
const treeText = (element) => renderText(element).join(' ');

// ─────────────────────────────── 加载 bundle
const loadBundle = () => {
  let captured = null;
  const styleCapture = { css: '' };
  const windowStub = { __ModuleLoader__: { load(registration) { captured = registration; } } };
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({
      dataset: {},
      style: {},
      remove() {},
      set textContent(value) {
        styleCapture.css = String(value);
      },
      get textContent() {
        return styleCapture.css;
      },
    }),
    head: { appendChild() {} },
    activeElement: null,
  };
  const requireStub = (name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require(${name})`);
  };
  const run = new Function('window', 'document', 'require', 'EventSource', 'fetch', 'navigator', CODE);
  return { run, windowStub, documentStub, requireStub, styleCapture, captured: () => captured };
};

// ─────────────────────────────── mock ctx
const makeCtx = (sink) => {
  const dict = { zh: {}, en: {} };
  const ctx = {
    locale: {
      register: (ns, dictionaries) => {
        dict.zh = dictionaries.zh ?? {};
        dict.en = dictionaries.en ?? {};
        return () => {};
      },
      bind: () => (key) => dict.zh[key] ?? key,
    },
    slots: {
      inject: (key, callback) => {
        sink.slotInjects.push(key);
        callback();
      },
      register: (options, component) => {
        sink.registrations.push({ options, component });
        return () => {};
      },
    },
    sidebarRightTabs: { register: (definition) => { sink.tabTypes.push(definition); return () => {}; } },
    sidebarRight: {
      openTabs: { getSnapshot: () => sink.openTabs },
      commandTarget: () => sink.target,
      openTabFromTarget: (kind, target) => sink.opened.push({ kind, target }),
      openTab: (kind) => sink.opened.push({ kind }),
      close: (id) => sink.closed.push(id),
      focus: (id) => sink.focused.push(id),
      isExpanded: () => true,
      toggleExpanded: () => {},
    },
    layout: { selectPanel: (id) => sink.panels.push(id) },
    effect: (fn) => {
      const dispose = fn();
      sink.effects.push(dispose);
      return () => {};
    },
    inject: (deps, callback) => {
      sink.injectedDeps.push(deps);
      callback({
        effect: (fn) => {
          fn();
          return () => {};
        },
        shortcuts: { register: (definition) => { sink.shortcuts.push(definition); return () => {}; } },
      });
    },
  };
  return { ctx, dict };
};

const newSink = () => ({
  slotInjects: [],
  registrations: [],
  tabTypes: [],
  shortcuts: [],
  injectedDeps: [],
  effects: [],
  opened: [],
  closed: [],
  focused: [],
  panels: [],
  openTabs: [],
  target: { sessionId: 'session-7dad54bf-3e92-46ea-93b6-0a54491aca34' },
});

// ─────────────────────────────── 真实形状的快照
const NOW = Date.now();
const SESSION_ID = 'session-7dad54bf-3e92-46ea-93b6-0a54491aca34';
const CHILD_ID = 'fca5eff0-a547-4c17-956a-6e8fc881cb6c';
const SNAPSHOT = {
  seq: 12,
  now: NOW,
  todayKey: '2026-09-21',
  today: { key: '2026-09-21', cost: 3.19, tokens: { uncachedInput: 12400, cacheRead: 588000, cacheWrite: 0, output: 8100, reasoning: 0, total: 608500 }, requests: 7, sessions: 2 },
  all: { cost: 12.4, sessions: 3 },
  sessions: [
    {
      id: SESSION_ID,
      shortId: '7dad54bf',
      title: '做一个终端风格的监控面板',
      cwd: 'C:\\work\\default-workspace',
      workspace: 'default-workspace',
      createdAt: NOW - 600000,
      isSubagent: false,
      parentSession: '',
      running: true,
      lastEventAt: NOW - 1200,
      model: 'deepseek-flash',
      provider: 'deepseek-account',
      reasoningEffort: 'high',
      agentPreset: 'standard',
      turns: 4,
      steps: 7,
      requests: 7,
      toolCalls: 23,
      errors: 1,
      retries: 1,
      errStreak: 0,
      tokens: {
        session: { uncachedInput: 12400, cacheRead: 588000, cacheWrite: 0, output: 8100, reasoning: 0, total: 608500 },
        today: { uncachedInput: 12400, cacheRead: 588000, cacheWrite: 0, output: 8100, reasoning: 0, total: 608500 },
      },
      cost: { session: 0.842, today: 0.842 },
      contextWindow: 1000000,
      surfaceTokens: 620000,
      pressure: 0.62,
      live: { phase: 'thinking', startedAt: NOW - 2100, endedAt: 0, reasoningChars: 1240, textChars: 0, tool: '', usage: null, usageCost: 0, turn: 4, step: 7 },
      files: [
        { path: 'C:\\proj\\lib\\index.js', rel: 'lib/index.js', tool: 'write', reads: 3, writes: 1, edits: 2, plus: 42, minus: 7, lastT: NOW - 5000 },
        { path: 'C:\\proj\\lib\\client.js', rel: 'lib/client.js', tool: 'edit', reads: 1, writes: 0, edits: 3, plus: 18, minus: 2, lastT: NOW - 9000 },
      ],
      todos: { total: 7, completed: 3, items: [{ content: '写 host 半', status: 'completed' }] },
      goal: { objective: '写完监视器插件', action: 'resume', t: NOW - 60000 },
      cached: { stats: { turns: 4, steps: 7, llmMs: 18467, toolMs: 6300, ttftMs: 5012, ttftSteps: 8, decodeMs: 13455, decodeTokens: 3889 } },
      cachedTokens: { uncachedInput: 12400, cacheRead: 588000, cacheWrite: 0, output: 8100 },
      stats: { turns: 4, steps: 7, llmMs: 18467, toolMs: 6300, ttftMs: 5012, ttftSteps: 8, decodeMs: 13455, decodeTokens: 3889 },
      byModel: [{ model: 'deepseek-flash', cost: 0.842, tokens: { total: 608500 } }],
    },
    {
      id: CHILD_ID,
      shortId: 'fca5eff0',
      title: '',
      cwd: 'C:\\work\\default-workspace',
      workspace: 'default-workspace',
      isSubagent: true,
      parentSession: SESSION_ID,
      running: false,
      lastEventAt: NOW - 300000,
      model: 'deepseek-flash',
      provider: 'deepseek-account',
      turns: 1,
      steps: 8,
      requests: 8,
      toolCalls: 15,
      errors: 0,
      tokens: { session: { uncachedInput: 42077, cacheRead: 175616, cacheWrite: 0, output: 3889, total: 221582 }, today: { total: 221582 } },
      cost: { session: 0.14, today: 0.14 },
      contextWindow: 1000000,
      surfaceTokens: 42287,
      files: [],
    },
  ],
  trend: [
    { day: '2026-09-14', cost: 0.4, tokens: 100000, requests: 3 },
    { day: '2026-09-15', cost: 0.9, tokens: 200000, requests: 5 },
    { day: '2026-09-16', cost: 2.1, tokens: 400000, requests: 9 },
    { day: '2026-09-17', cost: 0.2, tokens: 50000, requests: 2 },
    { day: '2026-09-18', cost: 3.4, tokens: 700000, requests: 12 },
    { day: '2026-09-19', cost: 1.1, tokens: 250000, requests: 6 },
    { day: '2026-09-20', cost: 2.8, tokens: 600000, requests: 10 },
    { day: '2026-09-21', cost: 3.19, tokens: 608500, requests: 7 },
  ],
  byWorkspace: [{ workspace: 'default-workspace', cost: 3.19, tokens: 608500, sessions: 2 }],
  byModel: [{ model: 'deepseek-flash', cost: 3.19, tokens: { uncachedInput: 54477, cacheRead: 763616, output: 11989 } }],
  wallet: { at: NOW, status: 'ready', wallets: [{ currency: 'CNY', balance: '41.20' }], bonusWallets: [{ currency: 'CNY', balance: '5.00' }], error: null },
  alerts: [{ level: 'warn', kind: 'context', sid: SESSION_ID, text: '上下文占用 62%（620k/1.00M）', t: NOW }],
  config: { bufferSize: 500, bufferMax: 5000, todayBudget: 20, contextWarn: 0.8, stuckMs: 300000, errorStreak: 3, historyDays: 14, peakAware: true, redact: true, reasoningPreview: 200, resultPreview: 400 },
  prices: {
    'deepseek-flash': { label: 'deepseek-flash', currency: 'CNY', offPeak: { cacheRead: 0.02, cacheMiss: 1, output: 4 }, peak: { cacheRead: 0.04, cacheMiss: 2, output: 8 } },
    'deepseek-v4-pro': { label: 'deepseek-v4-pro', currency: 'CNY', offPeak: { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheRead: 0.3, cacheMiss: 9, output: 27 } },
  },
  backfill: { state: 'done', scanned: 7, total: 7, startedAt: NOW - 9000, finishedAt: NOW - 8000, error: null, events: 841 },
  counters: { toolCalls: 23, requests: 7, errors: 1 },
  activity: [
    { id: 1, t: NOW - 9000, sid: SESSION_ID, ws: 'default-workspace', kind: 'request', level: 'info', title: '请求配置 · series', detail: 'deepseek-account/deepseek-flash · high', status: '', ok: true, turn: 4, step: 7 },
    { id: 2, t: NOW - 8000, sid: SESSION_ID, ws: 'default-workspace', kind: 'tool', title: 'read', detail: 'lib/index.js', tool: 'read', turn: 4, step: 7, status: 'ok', ok: true, durationMs: 400, args: '{"file_path":"C:\\\\proj\\\\lib\\\\index.js"}', result: 'export function apply() {}' },
    { id: 3, t: NOW - 7000, sid: SESSION_ID, ws: 'default-workspace', kind: 'tool', title: 'pwsh', detail: 'pnpm build', tool: 'pwsh', turn: 4, step: 7, status: 'error', ok: false, durationMs: 8400, args: '{"command":"set TOKEN=*** && pnpm build"}', result: 'command failed', error: 'ToolError: exit-1' },
    { id: 4, t: NOW - 6000, sid: SESSION_ID, ws: 'default-workspace', kind: 'reply', title: '回复（turn 4 / step 7）', detail: '已修复构建脚本。', model: 'deepseek-flash', turn: 4, step: 7, tokens: { uncachedInput: 1000, cacheRead: 20000, cacheWrite: 0, output: 500, total: 21500 }, cost: 0.0068, peak: false, reasoning: '先看构建失败原因…', reasoningChars: 900, text: '已修复构建脚本。' },
    { id: 5, t: NOW - 5000, sid: CHILD_ID, parentSid: SESSION_ID, ws: 'default-workspace', kind: 'subagent', title: '子代理结束 · 调研', detail: '会话 fca5eff0 ← 7dad54bf', status: 'ok', ok: true },
    { id: 6, t: NOW - 4000, sid: SESSION_ID, ws: 'default-workspace', kind: 'tool', title: 'edit', detail: 'lib/client.js  +18 −2', tool: 'edit', turn: 4, step: 7, status: 'running', ok: true, args: '{"file_path":"C:\\\\proj\\\\lib\\\\client.js"}', hidden: false },
    { id: 8, t: NOW - 3500, sid: CHILD_ID, ws: 'default-workspace', kind: 'tool', title: 'glob', detail: '别的会话的帧', tool: 'glob', status: 'ok', ok: true, durationMs: 90 },
  ],
};

// ─────────────────────────────── 场景 1：注册
console.log('\n[1] bundle 外壳与四处注册');
const sink = newSink();
const loaded = loadBundle();
loaded.run(loaded.windowStub, loaded.documentStub, loaded.requireStub, class { close() {} }, async () => ({ ok: true, text: async () => '{}' }), { clipboard: { writeText() {} } });
const registration = loaded.captured();
check('bundle 用 window.__ModuleLoader__.load 注册且 id 正确', () => {
  assert.ok(registration, '没有捕获到 load 调用');
  assert.equal(registration.id, 'dsh-agent-monitor');
  assert.equal(typeof registration.factory, 'function');
});
const plugin = registration.factory(loaded.requireStub);
check('导出 apply / inject，且只 require react', () => {
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['slots', 'layout', 'locale', 'sidebarRightTabs', 'sidebarRight']);
});

const { ctx, dict } = makeCtx(sink);
plugin.apply(ctx);

check('右侧栏 tab 类型两阶段注册：id/kind/title/guide', () => {
  assert.equal(sink.tabTypes.length, 1);
  const def = sink.tabTypes[0];
  assert.equal(def.id, 'agent-monitor');
  assert.equal(def.kind, 'agent-monitor');
  assert.equal(def.title(), '监视器');
  assert.equal(def.guide.length, 1);
  assert.equal(def.guide[0].id, 'agent-monitor');
  assert.match(def.guide[0].description(), /只读/);
});
check('注入的槽位齐全（main / panellist / 右栏正文 / 右栏标题）', () => {
  assert.deepEqual(sink.slotInjects, ['main', 'sidebar.panellist', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
});
check('侧边栏图标 id 与 main 面板 key 同名（宿主靠这个选面板）', () => {
  const main = sink.registrations.find((item) => item.options.name === 'main');
  const icon = sink.registrations.find((item) => item.options.name === 'sidebar.panellist');
  assert.equal(main.options.key, 'agent-monitor');
  assert.equal(icon.options.id, 'agent-monitor');
  assert.equal(icon.options.label(), 'Agent 监视器');
});
check('右栏正文与标题用 tab 类型的 id 作为 keyed 键', () => {
  const body = sink.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab');
  const title = sink.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab.title');
  assert.equal(body.options.key, 'agent-monitor');
  assert.equal(title.options.key, 'agent-monitor');
});
check('快捷键走宿主的 shortcuts 服务，Ctrl+` 且覆盖五个平台键', () => {
  assert.deepEqual(sink.injectedDeps, [['shortcuts']]);
  assert.equal(sink.shortcuts.length, 1);
  const shortcut = sink.shortcuts[0];
  assert.equal(shortcut.id, 'agent-monitor.toggle');
  assert.deepEqual(shortcut.regions, ['page', 'editable', 'terminal']);
  for (const key of ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows']) {
    assert.deepEqual(shortcut.defaults[key], { code: 'Backquote', modifiers: ['primary'] });
  }
});
check('没有会话时快捷键返回 blocked 并给出原因', () => {
  const blocked = sink.shortcuts[0].resolve({ target: undefined });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /先打开一个会话/);
});
check('有会话时快捷键 toggle 会打开右栏 tab', () => {
  const handled = sink.shortcuts[0].resolve({ target: { sessionId: SESSION_ID } });
  assert.equal(handled.status, 'handled');
  handled.run();
  assert.deepEqual(sink.opened.at(-1), { kind: 'agent-monitor', target: { sessionId: SESSION_ID } });
});
check('已打开时 toggle 改为关闭该 tab', () => {
  sink.openTabs = [{ id: 'tab-1', kind: 'agent-monitor', contentId: 'x', title: '监视器' }];
  sink.shortcuts[0].resolve({ target: { sessionId: SESSION_ID } }).run();
  assert.deepEqual(sink.closed, ['tab-1']);
  sink.openTabs = [];
});
check('图标走 layout.selectPanel 打开整页版', () => {
  sink.registrations.find((item) => item.options.name === 'sidebar.panellist').options.inject().runtime.selectFullPage();
  assert.deepEqual(sink.panels, ['agent-monitor']);
});

// ─────────────────────────────── 场景 2：渲染
console.log('\n[2] 仪表盘与各区块真实渲染（mock React + mock fetch/SSE）');

const sink2 = newSink();
const loaded2 = loadBundle();
const eventSources = [];
class EventSourceStub {
  constructor(url) {
    this.url = url;
    eventSources.push(this);
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: 'frames', frames: [{ id: 7, t: Date.now(), sid: SESSION_ID, kind: 'tool', title: 'grep', detail: 'sidebar.right', tool: 'grep', status: 'ok', ok: true, durationMs: 210 }] }) });
    }, 1);
  }
  close() {}
}
const fetchStub = async (url) => {
  const target = String(url);
  if (target.endsWith('/health')) return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ ok: true }) };
  if (target.endsWith('/snapshot')) return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ ok: true, value: SNAPSHOT }) };
  return { ok: false, status: 404, statusText: 'Not Found', text: async () => JSON.stringify({ ok: false, error: 'nope' }) };
};
loaded2.run(loaded2.windowStub, loaded2.documentStub, loaded2.requireStub, EventSourceStub, fetchStub, { clipboard: { writeText() {} } });
const plugin2 = loaded2.captured().factory(loaded2.requireStub);
const made2 = makeCtx(sink2);
plugin2.apply(made2.ctx);
const Panel = sink2.registrations.find((item) => item.options.name === 'main').component;
const panelProps = { t: (key) => made2.dict.zh[key] ?? key, runtime: { closeTab() {} } };
const renderOnce = () => treeText(Panel(panelProps));
const state = () => lastSnapshotGetter();

/** 每个会改状态的用例开头都先归零，避免一个用例失败把后面全部带崩。 */
const resetView = () => {
  const snapshot = state();
  snapshot.query = '';
  snapshot.kindFilter = 'all';
  snapshot.sessionFilter = null;
  snapshot.section = 'board';
  snapshot.expanded = {};
  snapshot.paused = false;
  snapshot.pending = 0;
};

let text = renderOnce();
await new Promise((resolve) => setTimeout(resolve, 30));
text = renderOnce();

check('首帧（还没有 stats）不崩，显示读取中', () => {
  // 上面的第一次 renderOnce() 就是首帧；能走到这里说明没抛异常
  assert.ok(true);
});
check('SSE 通道建立起来了', () => {
  assert.equal(eventSources.length, 1);
  assert.equal(eventSources[0].url, '/agent-monitor/api/stream');
  assert.equal(state().transport, 'sse');
});
check('数据落地：快照与增量帧都进了 store', () => {
  assert.ok(state().stats, '没有 stats');
  assert.equal(state().stats.sessions.length, 2);
  assert.ok(state().frames.length >= 7, `帧数 ${state().frames.length}`);
});
check('顶栏：标题 / 副标题 / 搜索框 / 圆形图标按钮 / 会话与状态标签', () => {
  assert.match(text, /Agent 监视器/);
  assert.match(text, /实时活动 · token 与花费 · 上下文压力 · 只读/);
  assert.match(text, /搜索活动…/);
  assert.match(text, /⟳/);
  assert.match(text, /⏸/);
  assert.match(text, /⌫/);
  assert.match(text, /⊞/);
  assert.match(text, /✕/);
  assert.match(text, /实时/);
  assert.match(text, /session 7dad54bf/);
  assert.match(text, /deepseek-account\/deepseek-flash/);
  assert.match(text, /turn 4 \/ step 7/);
  assert.match(text, /运行中/);
});
check('左导航五项带计数', () => {
  assert.match(text, /仪表盘/);
  assert.match(text, /活动流/);
  assert.match(text, /文件/);
  assert.match(text, /会话/);
  assert.match(text, /设置/);
});
check('渐变统计卡：本次会话花费 / 今日花费 / tokens / 上下文 / 速率', () => {
  assert.match(text, /本次会话花费/);
  assert.match(text, /¥0\.842/);
  assert.match(text, /608\.5k tok/);
  assert.match(text, /7 请求/);
  assert.match(text, /今日花费 · 全机器/);
  assert.match(text, /¥3\.19/);
  assert.match(text, /16%/);
  assert.match(text, /预算 ¥20\.00/);
  assert.match(text, /剩 ¥16\.81/);
  assert.match(text, /本次会话 tokens/);
  assert.match(text, /命中 98%/);
  assert.match(text, /已省 ¥0\.576/);
  assert.match(text, /出 8\.10k/);
  assert.match(text, /上下文占用/);
  assert.match(text, /62%/);
  assert.match(text, /620\.0k\/1\.00M/);
  assert.match(text, /剩 380\.0k/);
  assert.match(text, /生成速率/);
  assert.match(text, /289 tok\/s/);
  assert.match(text, /会话均值/);
  assert.match(text, /首字 627ms/);
});
check('建议卡：标题 + 要点列表 + 行动按钮', () => {
  assert.match(text, /助手建议/);
  assert.match(text, /上下文占用 62%/);
  assert.match(text, /上下文剩余 380\.0k/);
  assert.match(text, /缓存命中让本次会话省下/);
  assert.match(text, /今日已用预算 16%/);
  assert.match(text, /本会话有 1 次报错/);
  assert.match(text, /查看错误行/);
});
check('实时行：阶段 + 思考字数 + 时长', () => {
  assert.match(text, /思考中/);
  assert.match(text, /思考 1240 字/);
  assert.match(text, /2\.\ds/);
});
check('分段控件带各自计数（全部 7 / 工具 3 / 回复 1 / 错误 1 / 其他 2）', () => {
  assert.match(text, /全部\s*7/);
  assert.match(text, /工具\s*3/);
  assert.match(text, /回复\s*1/);
  assert.match(text, /错误\s*1/);
  assert.match(text, /其他\s*2/);
});
check('活动流：工具行带状态字形、耗时、时长微条、花费', () => {
  assert.match(text, /✓ read/);
  assert.match(text, /lib\/index\.js/);
  assert.match(text, /400ms/);
  assert.match(text, /✗ pwsh/);
  assert.match(text, /8\.4s/);
  assert.match(text, /¥0\.0068/);
});
check('分组头：turn 标题 + 条数 + 元信息（时长/token/花费/错误/多久前）', () => {
  assert.match(text, /turn 4/);
  assert.match(text, /无轮次/);
  assert.match(text, /21\.5k tok/);
  assert.match(text, /1 错/);
});
check('追加的 SSE 帧出现在流里', () => {
  assert.match(text, /grep/);
  assert.match(text, /sidebar\.right/);
});
check('跟随当前会话：排除别的会话的帧，但保留自己子代理的生命周期帧', () => {
  assert.ok(!text.includes('别的会话的帧'), '别的会话的帧不该出现在跟随模式里');
  assert.match(text, /子代理结束 · 调研/);
});
check('切到那个子代理会话后能看到它自己的帧', () => {
  resetView();
  state().sessionFilter = CHILD_ID;
  const scoped = renderOnce();
  assert.match(scoped, /别的会话的帧/);
  assert.ok(!scoped.includes('已修复构建脚本。'), '父会话的帧不该出现在子会话视图里');
  resetView();
});
/** 上面已定义 resetView（在所有用例之前）。 */

check('分段过滤：只看错误时其余行消失', () => {
  resetView();
  state().kindFilter = 'errors';
  const errorsOnly = renderOnce();
  assert.match(errorsOnly, /ToolError: exit-1|✗ pwsh/);
  assert.ok(!errorsOnly.includes('✓ read'), '非错误行不该出现');
});
check('搜索过滤：文本命中才显示，并提示匹配', () => {
  resetView();
  state().query = 'pnpm';
  const searched = renderOnce();
  assert.match(searched, /匹配「pnpm」/);
  assert.match(searched, /pnpm build/);
  assert.ok(!searched.includes('✓ read'), '未命中的活动行不该出现');
});
check('展开某一行会画出带标签的参数与输出块', () => {
  resetView();
  state().expanded = { 2: true };
  const expandedText = renderOnce();
  assert.match(expandedText, /▸ 参数/);
  assert.match(expandedText, /file_path/);
  assert.match(expandedText, /▸ 输出/);
  assert.match(expandedText, /export function apply/);
});
check('右侧详情栏：会话键值 + 目标 + 待办 + 速度 + 标签 + 钱包 + 最近文件 + 时间轴', () => {
  assert.match(text, /会话详情/);
  assert.match(text, /工作区/);
  assert.match(text, /推理档位/);
  assert.match(text, /轮次 \/ 步骤/);
  assert.match(text, /模型请求/);
  assert.match(text, /工具调用/);
  assert.match(text, /报错 \/ 重试/);
  assert.match(text, /运行状态/);
  assert.match(text, /最后活动/);
  assert.match(text, /创建时间/);
  assert.match(text, /写完监视器插件/);
  assert.match(text, /待办/);
  assert.match(text, /3\/7/);
  assert.match(text, /速度与耗时/);
  assert.match(text, /首字延迟/);
  assert.match(text, /模型耗时/);
  assert.match(text, /18\.5s/);
  assert.match(text, /工具耗时/);
  assert.match(text, /标签/);
  assert.match(text, /standard/);
  assert.match(text, /钱包余额/);
  assert.match(text, /¥41\.20/);
  assert.match(text, /赠送余额/);
  assert.match(text, /¥5\.00/);
  assert.match(text, /每 60s 自动/);
  assert.match(text, /最近文件/);
  assert.match(text, /最近 14 天花费/);
  assert.match(text, /今天/);
  assert.match(text, /09-14/);
  assert.match(text, /峰值/);
});
check('文件区块：表格 + 读写改计数 + ±行 + 规模条', () => {
  resetView();
  state().section = 'files';
  const filesText = renderOnce();
  assert.match(filesText, /文件访问/);
  assert.match(filesText, /读/);
  assert.match(filesText, /写/);
  assert.match(filesText, /改/);
  assert.match(filesText, /lib\/index\.js/);
  assert.match(filesText, /\+42/);
  assert.match(filesText, /−7/);
  assert.match(filesText, /\+18/);
  assert.match(filesText, /规模/);
  resetView();
});
check('会话区块：跟随项 + 运行状态点 + 子代理缩进 + 计数', () => {
  resetView();
  state().section = 'sessions';
  const sessionsText = renderOnce();
  assert.match(sessionsText, /跟随当前会话 \/ 运行中优先/);
  assert.match(sessionsText, /7dad54bf/);
  assert.match(sessionsText, /fca5eff0/);
  assert.match(sessionsText, /└/);
  assert.match(sessionsText, /←7dad54bf/);
  assert.match(sessionsText, /23↯/);
  assert.match(sessionsText, /1✗/);
  assert.match(sessionsText, /运行中/);
  resetView();
});
check('设置区块：阈值、开关、两档单价表、保存与内存提示', () => {
  resetView();
  state().section = 'settings';
  const settingsText = renderOnce();
  assert.match(settingsText, /阈值与开关/);
  assert.match(settingsText, /活动流保留条数/);
  assert.match(settingsText, /今日预算（元）/);
  assert.match(settingsText, /上下文告警线/);
  assert.match(settingsText, /卡住判定/);
  assert.match(settingsText, /按峰谷计价/);
  assert.match(settingsText, /自动脱敏/);
  assert.match(settingsText, /deepseek-flash/);
  assert.match(settingsText, /deepseek-v4-pro/);
  assert.match(settingsText, /空闲/);
  assert.match(settingsText, /高峰/);
  assert.match(settingsText, /缓存命中/);
  assert.match(settingsText, /未命中/);
  assert.match(settingsText, /输出/);
  assert.match(settingsText, /保存/);
  assert.match(settingsText, /Host 重启后回到默认/);
  resetView();
});
check('底部操作条：状态线 + 4 个 CSV + 绿色主按钮', () => {
  resetView();
  const foot = renderOnce();
  assert.match(foot, /Ctrl\+` 呼出\/收起/);
  assert.match(foot, /只读/);
  assert.match(foot, /2 会话/);
  assert.match(foot, /今日 ¥3\.19/);
  assert.match(foot, /缓冲 \d+\/500/);
  for (const label of ['活动 CSV', '每日 CSV', '会话 CSV', '模型 CSV']) assert.match(foot, new RegExp(label));
  assert.match(foot, /✓ 完整 JSON/);
});
check('暂停状态在顶栏可见', () => {
  resetView();
  state().paused = true;
  state().pending = 12;
  assert.match(renderOnce(), /已暂停 \+12/);
  resetView();
});
check('活动流标签页不显示统计卡（只有仪表盘显示）', () => {
  resetView();
  state().section = 'flow';
  const flowOnly = renderOnce();
  assert.match(flowOnly, /✓ read/);
  assert.ok(!flowOnly.includes('本次会话花费'), '活动流页不该有统计卡');
  resetView();
});

// ─────────────────────────────── 场景 2b：样式表静态检查
console.log('\n[2b] 注入的样式表静态检查');
const css = loaded2.styleCapture.css;
check('样式表确实注入了（非空）', () => {
  assert.ok(css.length > 2000, `css 长度 ${css.length}`);
});
check('花括号与圆括号平衡', () => {
  const count = (text, ch) => text.split(ch).length - 1;
  assert.equal(count(css, '{'), count(css, '}'), '花括号不平衡');
  assert.equal(count(css, '('), count(css, ')'), '圆括号不平衡');
});
check('两个容器查询断点都在（窄栏单列 / 整页三栏）', () => {
  assert.ok(css.includes('@container am (min-width:620px)'), '缺少 620px 断点');
  assert.ok(css.includes('@container am (min-width:980px)'), '缺少 980px 断点');
  assert.ok(css.includes('container-type:inline-size'), '缺少容器声明');
  assert.ok(css.includes('container-name:am'), '缺少容器名');
});
check('三栏网格列数与侧栏列都在宽断点里', () => {
  assert.match(css, /@container am \(min-width:980px\)\{[^}]*grid-template-columns:124px minmax\(0,1fr\) 264px/);
  assert.match(css, /\.am_side\{grid-column:3;grid-row:1\}/);
});
check('每个 var(--am-*) 引用都有定义', () => {
  const defined = new Set([...css.matchAll(/(--am-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--am-[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `未定义的变量：${missing.join(', ')}`);
});
check('外部主题 token 全部带 fallback（不会出现无兜底的引用）', () => {
  const naked = [...css.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(naked, [], `没有 fallback 的主题变量：${naked.join(', ')}`);
});

// ─────────────────────────────── 场景 3：host 不可达
console.log('\n[3] host 半不可达时的诊断');
const sink3 = newSink();
const loaded3 = loadBundle();
loaded3.run(loaded3.windowStub, loaded3.documentStub, loaded3.requireStub, class { close() {} }, async () => {
  throw new Error('Failed to fetch');
}, { clipboard: { writeText() {} } });
const plugin3 = loaded3.captured().factory(loaded3.requireStub);
const made3 = makeCtx(sink3);
plugin3.apply(made3.ctx);
const Panel3 = sink3.registrations.find((item) => item.options.name === 'main').component;
renderText(Panel3({ t: panelProps.t, runtime: { closeTab() {} } }));
await new Promise((resolve) => setTimeout(resolve, 20));
const offlineText = treeText(Panel3({ t: panelProps.t, runtime: { closeTab() {} } }));

check('显示离线徽标与可操作的诊断', () => {
  assert.match(offlineText, /离线/);
  assert.match(offlineText, /host 半不可达/);
  assert.match(offlineText, /127\.0\.0\.1:19387/);
});

console.log(`\n通过 ${passed} 项检查${process.exitCode ? '（存在失败）' : '，全部通过'}\n`);
