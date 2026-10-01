/**
 * Agent 监视器 —— 采集与聚合核心（host 侧）。
 *
 * 设计要点：
 *  - 只读：数据来自 `session/event` 实时事件流 + `sessionPersistence` 读到的历史日志 +
 *    `sessionProjectionCache` 的零 I/O 投影缓存；不向 DSH 写任何东西。
 *  - 内存聚合：所有派生状态都在内存里，进程重启后重新回填（Q20 决策：不额外落盘）。
 *  - 脱敏在最前面：任何文本进入缓冲之前先过 redact，界面 / SSE / 导出共用同一份数据。
 *  - 增量推送：frame 是追加，patch 是对既有行的就地更新（工具调用先出现、结束后补耗时与结果）。
 */

import {
  DEFAULT_PRICES,
  addBuckets,
  computeCost,
  formatMoney,
  formatTokens,
  localDayKey,
  recentDayKeys,
  splitBuckets,
  startOfLocalDay,
  zeroBuckets,
} from './pricing.js';
import { clampField, redactText, redactValue, truncateForDisplay } from './redact.js';

export const DEFAULT_CONFIG = {
  /** 活动流保留条数（Q15：默认 500，可调到 5000）。 */
  bufferSize: 500,
  bufferMax: 5000,
  /** 今日花费告警线（元）。 */
  todayBudget: 20,
  /** 上下文占用告警线（0-1）。 */
  contextWarn: 0.8,
  /** 任务卡住判定（毫秒）。 */
  stuckMs: 5 * 60 * 1000,
  /** 连续报错判定次数。 */
  errorStreak: 3,
  /** 趋势天数。 */
  historyDays: 14,
  /** 是否按峰谷计价（Q31）。 */
  peakAware: true,
  /** 是否脱敏（Q23）。 */
  redact: true,
  /** 完成后展示的思考预览字数（Q25）。 */
  reasoningPreview: 200,
  /** 单次工具输出的展示摘要上限。 */
  resultPreview: 400,
};

const MAX_FIELD = 200 * 1024;

const str = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
const pick = (object, keys) => {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

/** 投影缓存里的值可能是裸值，也可能带 {ver, seq, val} 包装。 */
const unwrap = (value) => (value && typeof value === 'object' && 'val' in value ? value.val : value);

function workspaceName(cwd) {
  const raw = str(cwd).trim();
  if (!raw) return '（无工作区）';
  const normalized = raw.replace(/[\\/]+$/, '');
  const base = normalized.split(/[\\/]/).pop();
  return base || normalized;
}

function shortId(id) {
  const raw = str(id);
  const match = /([0-9a-f]{8})-[0-9a-f]{4}/i.exec(raw);
  if (match) return match[1];
  return raw.length > 12 ? raw.slice(0, 12) : raw;
}

/** 首行 + 折叠空白，用作一行摘要。 */
function oneLine(text, limit) {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function lines(text) {
  const value = str(text);
  if (!value) return 0;
  return value.split('\n').length;
}

function jsonArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = str(raw).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { __raw: text };
  }
}

function relativePath(pathLike) {
  const raw = str(pathLike);
  if (!raw) return '';
  const parts = raw.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return raw;
  return parts.slice(-2).join('/');
}

/** 每个工具一行摘要：让用户一眼看出「我做了什么」。 */
export function summarizeTool(name, args) {
  const tool = str(name);
  const file = pick(args, ['file_path', 'path', 'target', 'notebook_path']);
  const rel = relativePath(file);
  switch (tool) {
    case 'read':
    case 'read_image':
      return { title: tool, detail: rel || '（未给路径）', file: str(file) };
    case 'write': {
      const content = str(pick(args, ['content', 'text']) ?? '');
      return { title: 'write', detail: `${rel || '（未给路径）'}  +${lines(content)} −0`, file: str(file), plus: lines(content), minus: 0 };
    }
    case 'edit': {
      const oldText = str(args?.old_string ?? args?.oldText ?? '');
      const newText = str(args?.new_string ?? args?.newText ?? '');
      return { title: 'edit', detail: `${rel || '（未给路径）'}  +${lines(newText)} −${lines(oldText)}`, file: str(file), plus: lines(newText), minus: lines(oldText) };
    }
    case 'glob':
      return { title: 'glob', detail: str(args?.pattern) + (args?.path ? `  @${relativePath(args.path)}` : ''), file: '' };
    case 'grep':
      return { title: 'grep', detail: `${str(args?.pattern)}${args?.path ? `  @${relativePath(args.path)}` : ''}`, file: '' };
    case 'pwsh':
    case 'bash':
      return { title: tool, detail: oneLine(args?.command ?? args?.script ?? '', 120), file: '' };
    case 'subagent':
    case 'spawn_teammate':
      return { title: tool, detail: oneLine(args?.description ?? args?.prompt ?? '', 100), file: '' };
    case 'subagent_fork':
      return { title: tool, detail: oneLine(args?.description ?? '', 100), file: '' };
    case 'workflow':
      return { title: 'workflow', detail: oneLine(args?.meta?.name ?? args?.meta?.description ?? '', 100), file: '' };
    case 'todo_write':
      return { title: 'todo_write', detail: todoSummary(args), file: '' };
    case 'update_goal':
    case 'create_goal':
      return { title: tool, detail: oneLine(args?.objective ?? args?.action ?? '', 100), file: '' };
    case 'ask_user_question':
      return { title: 'ask_user_question', detail: `${Array.isArray(args?.questions) ? args.questions.length : 0} 个问题`, file: '' };
    case 'web_search':
      return { title: 'web_search', detail: oneLine((args?.queries ?? []).join(' | '), 100), file: '' };
    case 'web_fetch':
      return { title: 'web_fetch', detail: oneLine(args?.url ?? '', 100), file: '' };
    case 'present':
      return { title: 'present', detail: `${Array.isArray(args?.files) ? args.files.length : 0} 个交付文件`, file: '' };
    case 'job_output':
    case 'job_kill':
    case 'job_list':
      return { title: tool, detail: oneLine(args?.job_id ?? '', 60), file: '' };
    case 'ask': // 占位，避免 default 分支重复
      return { title: tool, detail: '', file: '' };
    default: {
      if (rel) return { title: tool, detail: rel, file: str(file) };
      const scalar = Object.entries(args ?? {}).find(([, value]) => typeof value === 'string' && value.length > 0);
      return { title: tool, detail: scalar ? `${scalar[0]}=${oneLine(scalar[1], 80)}` : '', file: '' };
    }
  }
}

function todoSummary(args) {
  const todos = Array.isArray(args?.todos) ? args.todos : [];
  const done = todos.filter((item) => item && item.status === 'completed').length;
  const current = todos.find((item) => item && item.status === 'in_progress');
  return `${done}/${todos.length}${current ? ` · ${oneLine(current.content, 60)}` : ''}`;
}

/** 从消息内容块里抽出文本 / 思考 / 工具调用。 */
function messageBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  let text = '';
  let reasoning = '';
  const tools = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') text += str(block.text);
    else if (block.type === 'reasoning') reasoning += str(block.text);
    else if (block.type === 'tool-call') tools.push({ id: str(block.id), name: str(block.name), arguments: str(block.arguments) });
  }
  return { text, reasoning, tools };
}

export class Collector {
  constructor(options = {}) {
    this.ctx = options.ctx;
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
    this.prices = options.prices ?? DEFAULT_PRICES;
    this.sessions = new Map();
    this.headers = new Map();
    this.frames = [];
    this.frameSeq = 0;
    this.pending = new Map();
    /** 正在回填的会话：其实时事件先丢弃（读日志时必然包含，避免重复记账）。 */
    this.pendingSessions = new Set();
    this.days = new Map();
    this.listeners = new Set();
    this.wallet = { at: 0, status: 'idle', wallets: [], bonusWallets: [], error: null, currency: 'CNY' };
    this.alerts = [];
    this.dirty = true;
    this.backfill = { state: 'idle', scanned: 0, total: 0, startedAt: 0, finishedAt: 0, error: null, events: 0 };
    this.batch = null;
    this.todayKey = localDayKey(Date.now());
    this.counters = { toolCalls: 0, requests: 0, errors: 0 };
  }

  // ─────────────────────────────── 对外：订阅与配置

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(message) {
    if (this.batch) {
      this.batch.push(message);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        /* 单个订阅者出错不影响其它订阅者 */
      }
    }
  }

  beginBatch() {
    if (this.batch) return;
    this.batch = [];
  }

  endBatch() {
    if (!this.batch) return;
    const queued = this.batch;
    this.batch = null;
    for (const message of queued) {
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  updateConfig(patch) {
    if (!patch || typeof patch !== 'object') return this.config;
    const next = { ...this.config };
    const numeric = (key, min, max) => {
      if (patch[key] === undefined) return;
      const value = Number(patch[key]);
      if (!Number.isFinite(value)) return;
      next[key] = Math.min(max, Math.max(min, value));
    };
    numeric('bufferSize', 50, this.config.bufferMax);
    numeric('bufferMax', 100, 50_000);
    numeric('todayBudget', 0.01, 1_000_000);
    numeric('contextWarn', 0.1, 1);
    numeric('stuckMs', 10_000, 86_400_000);
    numeric('errorStreak', 1, 100);
    numeric('historyDays', 1, 90);
    numeric('reasoningPreview', 0, 4000);
    numeric('resultPreview', 40, 20_000);
    if (typeof patch.peakAware === 'boolean') next.peakAware = patch.peakAware;
    if (typeof patch.redact === 'boolean') next.redact = patch.redact;
    this.config = { ...next, bufferSize: Math.min(next.bufferSize, next.bufferMax) };
    this.trim();
    this.dirty = true;
    return this.config;
  }

  updatePrices(next) {
    if (!next || typeof next !== 'object') return this.prices;
    const clean = {};
    for (const [model, entry] of Object.entries(next)) {
      if (!entry || typeof entry !== 'object') continue;
      const rate = (source) => ({
        cacheRead: Number(source?.cacheRead) || 0,
        cacheMiss: Number(source?.cacheMiss) || 0,
        output: Number(source?.output) || 0,
      });
      clean[model] = {
        label: str(entry.label) || model,
        currency: entry.currency === 'USD' ? 'USD' : 'CNY',
        offPeak: rate(entry.offPeak),
        peak: rate(entry.peak ?? entry.offPeak),
      };
    }
    if (Object.keys(clean).length > 0) this.prices = clean;
    this.dirty = true;
    return this.prices;
  }

  // ─────────────────────────────── 会话登记

  registerHeader(header) {
    if (!header || !header.id) return undefined;
    this.headers.set(str(header.id), header);
    return this.ensureSession(str(header.id), header);
  }

  ensureSession(id, header) {
    const sid = str(id);
    if (!sid) return undefined;
    let record = this.sessions.get(sid);
    const effective = header ?? this.headers.get(sid);
    if (effective && !this.headers.has(sid)) this.headers.set(sid, effective);
    if (!record) {
      record = {
        id: sid,
        shortId: shortId(sid),
        cwd: str(effective?.cwd),
        workspace: workspaceName(effective?.cwd),
        title: '',
        createdAt: Number(effective?.createdAt) || 0,
        isSubagent: effective?.origin === 'subagent' || Boolean(effective?.parentSession),
        parentSession: str(effective?.parentSession),
        delegationDepth: Number(effective?.delegationDepth) || 0,
        origin: str(effective?.origin),
        agentPreset: str(effective?.agentPreset),
        running: false,
        lastEventAt: 0,
        lastSeq: -1,
        model: '',
        provider: '',
        reasoningEffort: '',
        contextWindow: 0,
        surfaceTokens: 0,
        pressureTokens: 0,
        turns: 0,
        steps: 0,
        requests: 0,
        toolCalls: 0,
        errors: 0,
        retries: 0,
        errStreak: 0,
        tokens: { session: zeroBuckets(), today: zeroBuckets() },
        cost: { session: 0, today: 0 },
        files: new Map(),
        todos: null,
        goal: null,
        live: null,
        stepOpen: null,
        cached: null,
        /** 已折入内存的最大 seq；-1 表示这个会话还没有被回填过。 */
        foldedUpTo: -1,
        byModel: new Map(),
      };
      this.sessions.set(sid, record);
      this.dirty = true;
    } else if (effective) {
      if (!record.cwd && effective.cwd) {
        record.cwd = str(effective.cwd);
        record.workspace = workspaceName(effective.cwd);
      }
      if (!record.createdAt && effective.createdAt) record.createdAt = Number(effective.createdAt) || 0;
      record.isSubagent = record.isSubagent || effective.origin === 'subagent' || Boolean(effective.parentSession);
      if (!record.parentSession && effective.parentSession) record.parentSession = str(effective.parentSession);
      if (!record.delegationDepth && effective.delegationDepth) record.delegationDepth = Number(effective.delegationDepth) || 0;
      if (!record.agentPreset && effective.agentPreset) record.agentPreset = str(effective.agentPreset);
    }
    return record;
  }

  markPending(id) {
    const sid = str(id);
    if (sid) this.pendingSessions.add(sid);
  }

  clearPending(id) {
    const sid = str(id);
    if (sid) this.pendingSessions.delete(sid);
  }

  setRunning(id, running) {
    const record = this.ensureSession(id);
    if (!record) return;
    if (record.running === running) return;
    record.running = running;
    if (running && !record.lastEventAt) record.lastEventAt = Date.now();
    this.dirty = true;
  }

  /** 把投影缓存里的整体数字挂到会话上（面板用它做交叉校验）。 */
  attachCached(id, values) {
    const record = this.ensureSession(id);
    if (!record || !values) return;
    const usage = unwrap(values.tokenUsage);
    const pressure = unwrap(values.contextPressure);
    const stats = unwrap(values.sessionStats);
    const selection = unwrap(values.modelSelection);
    const title = unwrap(values.title);
    record.cached = {
      tokens: usage?.totals ?? usage ?? null,
      contextWindow: Number(pressure?.contextWindow) || 0,
      surfaceTokens: Number(pressure?.surfaceTokens) || 0,
      pressureTokens: Number(pressure?.pressureTokens) || 0,
      stats: stats ?? null,
      model: pick(selection?.lastUsed ?? {}, ['model']) ?? null,
    };
    if (!record.title && title) {
      record.title = typeof title === 'string' ? title : str(pick(title, ['text', 'title']) ?? '');
    }
    this.dirty = true;
  }

  // ─────────────────────────────── 记账

  day(dayKey) {
    let entry = this.days.get(dayKey);
    if (!entry) {
      entry = { key: dayKey, tokens: zeroBuckets(), cost: 0, requests: 0, sessions: new Set(), byModel: new Map() };
      this.days.set(dayKey, entry);
    }
    return entry;
  }

  rolloverIfNeeded(now) {
    const key = localDayKey(now);
    if (key === this.todayKey) return false;
    this.todayKey = key;
    for (const record of this.sessions.values()) {
      record.tokens.today = zeroBuckets();
      record.cost.today = 0;
    }
    this.dirty = true;
    return true;
  }

  /** 记一次 usage（历史与实时共用），返回本次花费。 */
  account(record, usage, model, timeMs) {
    const now = Number.isFinite(timeMs) ? timeMs : Date.now();
    const key = localDayKey(now);
    const cost = computeCost(usage, model, now, { prices: this.prices, peakAware: this.config.peakAware });
    addBuckets(record.tokens.session, usage);
    const day = this.day(key);
    addBuckets(day.tokens, usage);
    day.cost += cost.total;
    day.sessions.add(record.id);
    const modelKey = cost.model;
    const dayModel = day.byModel.get(modelKey) ?? { cost: 0, tokens: zeroBuckets() };
    dayModel.cost += cost.total;
    addBuckets(dayModel.tokens, usage);
    day.byModel.set(modelKey, dayModel);
    const sessionModel = record.byModel.get(modelKey) ?? { cost: 0, tokens: zeroBuckets() };
    sessionModel.cost += cost.total;
    addBuckets(sessionModel.tokens, usage);
    record.byModel.set(modelKey, sessionModel);
    record.cost.session += cost.total;
    if (key === this.todayKey || startOfLocalDay(now) === startOfLocalDay(Date.now())) {
      record.cost.today += cost.total;
      addBuckets(record.tokens.today, usage);
    }
    return cost;
  }

  // ─────────────────────────────── frame 缓冲

  trim() {
    const cap = Math.min(this.config.bufferSize, this.config.bufferMax);
    if (this.frames.length > cap) this.frames.splice(0, this.frames.length - cap);
  }

  clean(text) {
    const value = clampField(str(text));
    return this.config.redact ? redactText(value) : value;
  }

  pushFrame(partial) {
    const frame = {
      id: (this.frameSeq += 1),
      t: Date.now(),
      sid: '',
      ws: '',
      kind: 'note',
      level: 'info',
      title: '',
      detail: '',
      status: '',
      ok: true,
      turn: 0,
      step: 0,
      ...partial,
    };
    this.frames.push(frame);
    this.trim();
    this.notify({ type: 'frames', frames: [frame] });
    return frame;
  }

  patchFrame(id, patch) {
    const index = this.frames.findIndex((frame) => frame.id === id);
    if (index >= 0) this.frames[index] = { ...this.frames[index], ...patch };
    this.notify({ type: 'patch', patches: [{ id, patch }] });
  }

  // ─────────────────────────────── 摄入：持久事件

  /**
   * 处理一条 SessionEvent（来自 `session/event` 实时流，或历史回填）。
   * @param {object} session - 拥有该事件的 Session（或 {id, header}）
   * @param {object} event - SessionEvent
   * @param {{historical?: boolean}} options
   */
  ingestEvent(session, event, options = {}) {
    if (!event || typeof event !== 'object') return;
    const id = str(session?.id ?? session?.header?.id);
    const header = session?.header ?? this.headers.get(id);
    const record = this.ensureSession(id, header);
    if (!record) return;
    const historical = options.historical === true;
    if (!historical) {
      // 该会话正在回填：实时事件稍后会被日志读到，先丢弃以免重复计数。
      if (this.pendingSessions.has(id)) return;
      if (typeof event.seq === 'number' && record.foldedUpTo >= 0 && event.seq <= record.foldedUpTo) return;
    }
    const time = Number(event.time) || Date.now();
    record.lastEventAt = Math.max(record.lastEventAt, time);
    if (typeof event.seq === 'number') {
      record.lastSeq = Math.max(record.lastSeq, event.seq);
      if (historical) record.foldedUpTo = Math.max(record.foldedUpTo, event.seq);
    }
    const today = localDayKey(time) === this.todayKey;
    const emit = !historical || today;
    const data = event.data ?? {};

    switch (event.type) {
      case 'request/header': {
        const config = data.header?.config ?? {};
        if (config.provider) record.provider = str(config.provider);
        if (config.model) record.model = str(config.model);
        if (config.reasoningEffort) record.reasoningEffort = str(config.reasoningEffort);
        // 注意：request/header 是「请求系列/配置边界」，不是每次模型请求（实测三个会话各只有 1 条，
        // 而实际模型请求有 16-46 次）。因此这里只更新模型信息，请求次数记在 assistant/message 上。
        if (emit) {
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'request',
            title: `请求配置${data.reason ? ` · ${data.reason}` : ''}`,
            detail: `${record.provider}/${record.model}${record.reasoningEffort ? ` · ${record.reasoningEffort}` : ''}${data.startsSeries ? ' · 新系列' : ''}`,
            turn: Number(data.header?.turn) || 0,
          });
        }
        break;
      }
      case 'request/context': {
        if (data.contextWindow) record.contextWindow = Number(data.contextWindow) || 0;
        if (data.model) record.model = str(data.model);
        if (data.provider) record.provider = str(data.provider);
        break;
      }
      case 'turn/start': {
        record.turns += 1;
        if (emit) {
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'turn',
            title: `turn ${data.turn ?? record.turns} 开始`,
            detail: '',
            turn: Number(data.turn) || record.turns,
            status: 'running',
          });
        }
        break;
      }
      case 'turn/end': {
        const reason = data.reason ?? {};
        const kind = str(reason.kind) || 'unknown';
        const failed = kind === 'error';
        if (failed) {
          record.errors += 1;
          record.errStreak += 1;
          this.counters.errors += 1;
        } else {
          record.errStreak = 0;
        }
        if (emit) {
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: failed ? 'error' : 'turn',
            level: failed ? 'error' : 'info',
            title: `turn ${data.turn ?? record.turns} ${failed ? '失败' : kind === 'completed' ? '完成' : kind}`,
            detail: failed ? oneLine(reason.error?.message ?? '', 160) : '',
            ok: !failed,
            turn: Number(data.turn) || record.turns,
          });
        }
        break;
      }
      case 'step/start': {
        record.steps += 1;
        record.stepOpen = { t: time, turn: Number(data.turn) || 0, step: Number(data.step) || 0 };
        break;
      }
      case 'step/end': {
        const open = record.stepOpen;
        record.stepOpen = null;
        if (open && emit) {
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'step',
            title: `step ${data.step ?? open.step} 结束`,
            detail: `耗时 ${Math.max(0, time - open.t)}ms`,
            turn: Number(data.turn) || open.turn,
            step: Number(data.step) || open.step,
            durationMs: Math.max(0, time - open.t),
          });
        }
        break;
      }
      case 'tool/call': {
        const name = str(data.name);
        const args = jsonArgs(data.arguments);
        const summary = summarizeTool(name, args);
        record.toolCalls += 1;
        this.counters.toolCalls += 1;
        if (summary.file) {
          const key = str(summary.file);
          const file = record.files.get(key) ?? { path: key, rel: relativePath(key), tool: name, reads: 0, writes: 0, edits: 0, plus: 0, minus: 0, lastT: 0 };
          if (name === 'read' || name === 'read_image') file.reads += 1;
          if (name === 'write') file.writes += 1;
          if (name === 'edit') file.edits += 1;
          file.plus += Number(summary.plus) || 0;
          file.minus += Number(summary.minus) || 0;
          file.lastT = time;
          record.files.set(key, file);
        }
        if (name === 'todo_write') {
          const todos = Array.isArray(args.todos) ? args.todos : [];
          record.todos = {
            total: todos.length,
            completed: todos.filter((item) => item?.status === 'completed').length,
            items: todos.slice(0, 40).map((item) => ({ content: this.clean(oneLine(item?.content, 200)), status: str(item?.status) })),
          };
        }
        if (name === 'create_goal' || name === 'update_goal') {
          record.goal = { objective: this.clean(oneLine(args.objective ?? record.goal?.objective ?? '', 300)), action: str(args.action), t: time };
        }
        if (emit) {
          const frame = this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'tool',
            title: name,
            detail: this.clean(summary.detail),
            tool: name,
            turn: Number(data.turn) || 0,
            step: Number(data.step) || 0,
            status: 'running',
            args: this.clean(clampField(str(data.arguments))),
            callId: str(data.callId),
          });
          if (frame.callId) this.pending.set(frame.callId, frame.id);
        }
        // 历史里非今天的工具调用只参与文件统计，不进活动缓冲（否则今天的流会被挤掉）。
        break;
      }
      case 'tool/result': {
        const callId = str(data.message?.toolCallId ?? data.callId);
        const failed = Boolean(data.error) || data.message?.isError === true;
        const output = messageBlocks(data.message).text;
        if (failed) {
          record.errors += 1;
          record.errStreak += 1;
          this.counters.errors += 1;
        } else {
          record.errStreak = 0;
        }
        const frameId = callId ? this.pending.get(callId) : undefined;
        if (frameId !== undefined) {
          this.pending.delete(callId);
          const frame = this.frames.find((item) => item.id === frameId);
          const start = frame ? frame.t : time;
          this.patchFrame(frameId, {
            status: failed ? 'error' : 'ok',
            ok: !failed,
            level: failed ? 'error' : 'info',
            durationMs: Math.max(0, time - start),
            result: this.clean(clampField(truncateForDisplay(output, 32 * 1024, 800).text)),
            error: failed ? this.clean(oneLine(data.error?.name ? `${data.error.name}: ${data.error.code ?? ''} ${data.error.reason ?? ''}` : output, 200)) : '',
            resultBytes: Buffer.byteLength(output, 'utf8'),
            hidden: false,
          });
        } else if (emit) {
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'tool',
            title: '工具结果',
            detail: failed ? this.clean(oneLine(output, 160)) : oneLine(output, 160),
            status: failed ? 'error' : 'ok',
            ok: !failed,
            level: failed ? 'error' : 'info',
            result: this.clean(clampField(truncateForDisplay(output, 32 * 1024, 800).text)),
          });
        }
        break;
      }
      case 'assistant/message': {
        const usage = data.usage;
        const model = str(data.message?.source?.model ?? record.model);
        const cost = usage ? this.account(record, usage, model, time) : null;
        // 一次 assistant/message = 一次完成的模型请求（也是唯一带 usage 的记账点）。
        record.requests += 1;
        this.day(localDayKey(time)).requests += 1;
        this.counters.requests += 1;
        if (usage) {
          // 上一次请求的提示词大小就是此刻真实的上下文占用（比投影缓存更新）。
          const buckets = splitBuckets(usage);
          record.surfaceTokens = buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite;
        }
        const blocks = messageBlocks(data.message);
        if (emit) {
          const reasoningPreview = truncateForDisplay(blocks.reasoning, 4000, 40).text.slice(0, this.config.reasoningPreview);
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'reply',
            title: `回复（turn ${data.turn ?? '?'} / step ${data.step ?? '?'}）`,
            detail: oneLine(blocks.text, 160),
            model,
            turn: Number(data.turn) || 0,
            step: Number(data.step) || 0,
            tokens: usage ? splitBuckets(usage) : null,
            cost: cost ? cost.total : 0,
            peak: cost ? cost.peak : false,
            reasoning: this.clean(reasoningPreview),
            reasoningChars: blocks.reasoning.length,
            text: this.clean(clampField(truncateForDisplay(blocks.text, 32 * 1024, 800).text)),
            interrupted: data.interrupted === true,
          });
        }
        record.live = null;
        break;
      }
      case 'assistant/attempt': {
        break;
      }
      case 'user/message': {
        if (emit) {
          const blocks = messageBlocks(data);
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'user',
            title: '用户消息',
            detail: oneLine(blocks.text, 160),
            text: this.clean(clampField(truncateForDisplay(blocks.text, 32 * 1024, 400).text)),
          });
        }
        break;
      }
      case 'llm/retry': {
        record.retries += 1;
        // 重试是一次额外的计费请求（投影缓存的口径：同一 step 的重试算另一次计费尝试）。
        record.requests += 1;
        this.day(localDayKey(time)).requests += 1;
        this.counters.requests += 1;
        if (emit) {
          this.pushFrame({
            t: time,
            sid: record.id,
            ws: record.workspace,
            kind: 'retry',
            level: 'warn',
            title: `重试 ${Number(data.retry) + 1}${data.maxRetries ? `/${Number(data.maxRetries) + 1}` : ''}`,
            detail: `${str(data.provider)} · ${oneLine(data.failure?.message ?? data.failure?.code ?? '', 120)} · ${Math.round((Number(data.delayMs) || 0) / 1000)}s 后重试`,
            ok: false,
          });
        }
        break;
      }
      case 'compaction/summary-error': {
        if (emit) {
          this.pushFrame({ t: time, sid: record.id, ws: record.workspace, kind: 'error', level: 'warn', title: '压缩摘要失败', detail: oneLine(data.error?.message ?? '', 160), ok: false });
        }
        break;
      }
      default:
        break;
    }
  }

  // ─────────────────────────────── 摄入：流式帧

  /** `agent/assistant-stream` —— 只用来做「正在思考/正在生成」的实时指示，不参与记账。 */
  ingestStream(payload) {
    const agent = payload?.agent;
    const frame = payload?.frame;
    if (!frame) return;
    const id = str(agent?.id ?? agent?.sessionId);
    const record = this.ensureSession(id, agent?.session?.header);
    if (!record) return;
    if (frame.type === 'start') {
      record.live = { phase: 'thinking', startedAt: Number(frame.time) || Date.now(), reasoningChars: 0, textChars: 0, tool: '', usage: null, turn: frame.turn, step: frame.step };
      this.dirty = true;
      return;
    }
    if (frame.type === 'end') {
      if (record.live) record.live = { ...record.live, phase: frame.outcome?.kind === 'abandoned' ? 'abandoned' : 'committed', endedAt: Number(frame.time) || Date.now() };
      this.dirty = true;
      return;
    }
    const chunk = frame.chunk;
    if (!chunk) return;
    const live = record.live ?? { phase: 'thinking', startedAt: Date.now(), reasoningChars: 0, textChars: 0, tool: '', usage: null, turn: frame.turn, step: frame.step };
    record.live = live;
    if (chunk.type === 'reasoning-delta') {
      live.reasoningChars += str(chunk.text).length;
      live.phase = 'thinking';
    } else if (chunk.type === 'text-delta') {
      live.textChars += str(chunk.text).length;
      live.phase = 'writing';
    } else if (chunk.type === 'tool-call-delta') {
      if (chunk.name) live.tool = str(chunk.name);
      live.phase = 'tool-call';
    } else if (chunk.type === 'usage') {
      live.usage = splitBuckets(chunk.usage);
      live.usageCost = computeCost(chunk.usage, record.model, Number(frame.time) || Date.now(), { prices: this.prices, peakAware: this.config.peakAware }).total;
    } else if (chunk.type === 'finish') {
      live.phase = 'finishing';
      live.finishReason = str(chunk.reason?.kind);
    }
    this.dirty = true;
  }

  // ─────────────────────────────── 摄入：非会话事件

  ingestGeneric(kind, title, detail, extra = {}) {
    return this.pushFrame({ kind, title, detail: this.clean(detail), ...extra });
  }

  ingestSubagent(dir, info) {
    const childId = str(pick(info ?? {}, ['childSessionId', 'sessionId', 'id', 'targetId']) ?? '');
    const parentId = str(pick(info ?? {}, ['parentSessionId', 'parentId', 'ownerSessionId', 'parent']) ?? '');
    const label = str(pick(info ?? {}, ['name', 'label', 'description', 'provider']) ?? '');
    if (childId) this.registerHeader({ id: childId, parentSession: parentId || undefined, origin: 'subagent', isSeeded: true, version: 4, createdAt: Date.now() });
    if (childId) this.setRunning(childId, dir === 'start');
    return this.pushFrame({
      kind: 'subagent',
      sid: childId || parentId,
      parentSid: parentId || '',
      ws: this.sessions.get(parentId)?.workspace ?? '',
      title: `${dir === 'start' ? '子代理启动' : '子代理结束'}${label ? ` · ${label}` : ''}`,
      detail: childId ? `会话 ${shortId(childId)}${parentId ? ` ← ${shortId(parentId)}` : ''}` : '',
      level: dir === 'start' ? 'info' : 'info',
      status: dir === 'start' ? 'running' : 'ok',
    });
  }

  ingestWorkflow(kind, info, extra) {
    const runId = str(pick(info ?? {}, ['runId', 'id', 'name']) ?? '');
    const sid = str(pick(info ?? {}, ['sessionId', 'parentSessionId']) ?? '');
    const titles = { start: '工作流启动', phase: '工作流阶段', log: '工作流日志', end: '工作流结束' };
    return this.pushFrame({
      kind: 'workflow',
      sid,
      ws: this.sessions.get(sid)?.workspace ?? '',
      title: `${titles[kind] ?? '工作流'}${runId ? ` · ${runId}` : ''}`,
      detail: this.clean(str(extra ?? pick(info ?? {}, ['meta', 'description', 'title']) ?? '')),
      status: kind === 'end' ? 'ok' : 'running',
    });
  }

  // ─────────────────────────────── 告警

  evaluateAlerts(now = Date.now()) {
    const alerts = [];
    for (const record of this.sessions.values()) {
      const window = record.contextWindow || record.cached?.contextWindow || 0;
      const used = record.surfaceTokens || record.cached?.surfaceTokens || 0;
      if (window > 0 && used / window >= this.config.contextWarn) {
        alerts.push({
          level: used / window >= 0.95 ? 'error' : 'warn',
          kind: 'context',
          sid: record.id,
          text: `上下文占用 ${((used / window) * 100).toFixed(0)}%（${formatTokens(used)}/${formatTokens(window)}）`,
          t: now,
        });
      }
      if (record.running && record.lastEventAt > 0 && now - record.lastEventAt > this.config.stuckMs) {
        alerts.push({
          level: 'warn',
          kind: 'stuck',
          sid: record.id,
          text: `已 ${Math.round((now - record.lastEventAt) / 60000)} 分钟没有新事件`,
          t: now,
        });
      }
      if (record.errStreak >= this.config.errorStreak) {
        alerts.push({ level: 'error', kind: 'errors', sid: record.id, text: `连续 ${record.errStreak} 次报错`, t: now });
      }
    }
    const todayKey = this.todayKey;
    const today = this.days.get(todayKey);
    const spent = today?.cost ?? 0;
    if (spent >= this.config.todayBudget) {
      alerts.push({
        level: spent >= this.config.todayBudget * 1.5 ? 'error' : 'warn',
        kind: 'budget',
        sid: '',
        text: `今日花费 ${formatMoney(spent)} 已达上限 ${formatMoney(this.config.todayBudget)}`,
        t: now,
      });
    }
    this.alerts = alerts;
    return alerts;
  }

  // ─────────────────────────────── 序列化

  sessionView(record) {
    const counts = record.files;
    const files = [...counts.values()].sort((a, b) => b.lastT - a.lastT).slice(0, 40);
    const live = record.live
      ? {
          phase: record.live.phase,
          startedAt: record.live.startedAt,
          endedAt: record.live.endedAt ?? 0,
          reasoningChars: record.live.reasoningChars,
          textChars: record.live.textChars,
          tool: record.live.tool,
          usage: record.live.usage,
          usageCost: record.live.usageCost ?? 0,
          turn: record.live.turn ?? 0,
          step: record.live.step ?? 0,
        }
      : null;
    const cachedTokens = record.cached?.tokens
      ? {
          uncachedInput: Number(cachedTokens_of(record.cached.tokens, 'uncachedInputTokens', 'uncachedInput')) || 0,
          cacheRead: Number(cachedTokens_of(record.cached.tokens, 'cacheReadTokens', 'cacheRead')) || 0,
          cacheWrite: Number(cachedTokens_of(record.cached.tokens, 'cacheWriteTokens', 'cacheWrite')) || 0,
          output: Number(cachedTokens_of(record.cached.tokens, 'outputTokens', 'output')) || 0,
        }
      : null;
    const contextWindow = record.contextWindow || record.cached?.contextWindow || 0;
    const surfaceTokens = record.surfaceTokens || record.cached?.surfaceTokens || 0;
    return {
      id: record.id,
      shortId: record.shortId,
      title: record.title || '',
      cwd: record.cwd,
      workspace: record.workspace,
      createdAt: record.createdAt,
      isSubagent: record.isSubagent,
      parentSession: record.parentSession,
      delegationDepth: record.delegationDepth,
      agentPreset: record.agentPreset,
      running: record.running,
      lastEventAt: record.lastEventAt,
      model: record.model || record.cached?.model || '',
      provider: record.provider,
      reasoningEffort: record.reasoningEffort,
      turns: record.turns,
      steps: record.steps,
      requests: record.requests,
      toolCalls: record.toolCalls,
      errors: record.errors,
      retries: record.retries,
      errStreak: record.errStreak,
      tokens: { session: record.tokens.session, today: record.tokens.today },
      cost: { session: record.cost.session, today: record.cost.today },
      contextWindow,
      surfaceTokens,
      pressure: contextWindow > 0 ? surfaceTokens / contextWindow : 0,
      live,
      files,
      todos: record.todos,
      goal: record.goal,
      cached: record.cached,
      cachedTokens,
      /** 投影缓存的 sessionStats：llmMs / toolMs / ttftMs / decodeMs / decodeTokens 等。 */
      stats: record.cached?.stats ?? null,
      byModel: [...record.byModel.entries()].map(([model, value]) => ({ model, cost: value.cost, tokens: value.tokens })),
    };
  }

  stats() {
    const now = Date.now();
    const sessions = [...this.sessions.values()]
      .filter((record) => record.lastEventAt > 0 || record.cached || record.running)
      .map((record) => this.sessionView(record))
      .sort((a, b) => b.lastEventAt - a.lastEventAt);
    const todayKey = this.todayKey;
    const today = this.days.get(todayKey);
    const trend = recentDayKeys(this.config.historyDays, now).map((key) => {
      const day = this.days.get(key);
      return { day: key, cost: day?.cost ?? 0, tokens: day?.tokens?.total ?? 0, requests: day?.requests ?? 0 };
    });
    const byWorkspace = new Map();
    for (const session of sessions) {
      if (!(session.cost.today > 0)) continue;
      const key = session.workspace || '（无工作区）';
      const entry = byWorkspace.get(key) ?? { workspace: key, cost: 0, tokens: 0, sessions: 0 };
      entry.cost += session.cost.today;
      entry.tokens += session.tokens.today.total;
      entry.sessions += 1;
      byWorkspace.set(key, entry);
    }
    const byModel = [...(today?.byModel ?? new Map()).entries()].map(([model, value]) => ({ model, cost: value.cost, tokens: value.tokens }));
    return {
      seq: this.frameSeq,
      now,
      todayKey,
      today: {
        key: todayKey,
        cost: today?.cost ?? 0,
        tokens: today?.tokens ?? zeroBuckets(),
        requests: today?.requests ?? 0,
        sessions: today?.sessions?.size ?? 0,
      },
      all: {
        cost: [...this.days.values()].reduce((sum, day) => sum + day.cost, 0),
        sessions: this.sessions.size,
      },
      sessions,
      trend,
      byWorkspace: [...byWorkspace.values()].sort((a, b) => b.cost - a.cost),
      byModel,
      wallet: this.wallet,
      alerts: this.alerts,
      config: this.config,
      prices: this.prices,
      backfill: this.backfill,
      counters: this.counters,
    };
  }

  snapshot() {
    return { ...this.stats(), activity: this.frames };
  }
}

function cachedTokens_of(source, snake, camel) {
  if (!source || typeof source !== 'object') return 0;
  const value = source[snake] ?? source[camel];
  return typeof value === 'number' ? value : 0;
}
