/**
 * Agent 监视器 —— host 半。
 *
 * 事实与取舍（都有调研证据）：
 *  - `ctx.remote.$on()` 的合法频道是硬编码白名单，收不到 `session/event` / `agent/assistant-stream`
 *    这类事件，所以推送必须走自建 HTTP 路由 + SSE（Q4 决策：事件级推送）。
 *  - webserver 对插件路由**没有全局鉴权门**，因此每条路由都自己调
 *    `ctx.connection.requestRejection(req)`（这是与已装 `dsh-session-manager` 的关键差别：
 *    它没做这道门）。
 *  - 只读：不往 DSH 写任何东西；`~\.dsh` 下的文件一律不碰（Q20 决策）。
 */

import { Collector, DEFAULT_CONFIG } from './collector.js';
import { DEFAULT_PRICES, localDayKey, splitBuckets } from './pricing.js';

export const name = 'dsh-agent-monitor';

/** 硬依赖：webServer 提供路由，sessionPersistence 读历史，connection 提供鉴权门。 */
export const inject = ['webServer', 'sessionPersistence', 'connection'];

const API = '/agent-monitor/api';
const BODY_LIMIT = 256 * 1024;

const json = (res, code, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const csvCell = (value) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvOf = (header, rows) => [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');

const stamp = (time = Date.now()) => {
  const d = new Date(time);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

const isoLocal = (time) => {
  const d = new Date(time);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('请求体过大'), { code: 'body-too-large' });
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad-request' });
  }
}

export function apply(ctx, config = {}) {
  const collector = new Collector({
    ctx,
    config: { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) },
    prices: DEFAULT_PRICES,
  });

  const logger = ctx.logger ?? console;
  const seen = new Map(); // sessionId -> revision（回填用的失效判据）

  /** 鉴权门：requestRejection 返回 403/401 时拒绝；服务缺失时按既装插件的惯例放行并告警。 */
  const rejectionOf = (req) => {
    try {
      const rejection = ctx.connection?.requestRejection?.(req);
      return typeof rejection === 'number' ? rejection : undefined;
    } catch (error) {
      logger.warn?.(`[agent-monitor] requestRejection 失败，按放行处理：${error?.message ?? error}`);
      return undefined;
    }
  };

  const guard = (req, res) => {
    const rejection = rejectionOf(req);
    if (rejection === undefined) return false;
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`rejected ${rejection}`);
    return true;
  };

  // ─────────────────────────── 事件订阅（host 事件总线，无需 inject）

  const disposers = [];

  disposers.push(
    ctx.on('session/event', (session, event) => {
      try {
        collector.ingestEvent(session, event);
      } catch (error) {
        logger.warn?.(`[agent-monitor] 处理 session/event 失败：${error?.message ?? error}`);
      }
    }),
  );

  disposers.push(
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        collector.ingestStream(payload);
      } catch {
        /* 流式帧只是指示器，出错不影响记账 */
      }
    }),
  );

  disposers.push(
    ctx.on('agent/status', ({ agent, status }) => {
      const id = agent?.id ?? agent?.session?.id;
      if (id) collector.setRunning(String(id), status === 'running');
    }),
  );

  disposers.push(
    ctx.on('api-session/status', (sessionId, running) => {
      if (sessionId) collector.setRunning(String(sessionId), running === true);
    }),
  );

  disposers.push(
    ctx.on('agent/error', ({ agent, turn, step, error }) => {
      const id = String(agent?.id ?? '');
      const record = collector.ensureSession(id, agent?.session?.header);
      if (!record) return;
      record.errors += 1;
      record.errStreak += 1;
      collector.ingestGeneric('error', `Agent 报错（turn ${turn} / step ${step}）`, String(error?.message ?? error ?? ''), {
        sid: id,
        ws: record.workspace,
        level: 'error',
        ok: false,
      });
    }),
  );

  disposers.push(
    ctx.on('session/created', (session) => {
      const header = session?.header;
      if (header) collector.registerHeader(header);
    }),
  );

  disposers.push(
    ctx.on('session/disposed', (session) => {
      const id = session?.id;
      if (id) collector.setRunning(String(id), false);
    }),
  );

  disposers.push(
    ctx.on('subagent/start', (info) => collector.ingestSubagent('start', info)),
    ctx.on('subagent/end', (info) => collector.ingestSubagent('end', info)),
  );

  disposers.push(
    ctx.on('workflow/start', (info) => collector.ingestWorkflow('start', info)),
    ctx.on('workflow/phase', (info, title) => collector.ingestWorkflow('phase', info, title)),
    ctx.on('workflow/log', (info, message) => collector.ingestWorkflow('log', info, message)),
    ctx.on('workflow/end', (info, result) => collector.ingestWorkflow('end', info, result?.stopReason ?? result?.status ?? '')),
  );

  disposers.push(
    ctx.on('goal/changed', ({ agent, change }) => {
      const id = String(agent?.id ?? '');
      const record = collector.ensureSession(id, agent?.session?.header);
      if (!record) return;
      const goal = change?.goal ?? change?.value ?? change;
      const objective = goal?.objective ?? record.goal?.objective ?? '';
      const status = goal?.status ?? change?.kind ?? '';
      record.goal = { objective: collector.clean(String(objective)), action: String(status), t: Date.now() };
      collector.ingestGeneric('goal', `目标${status ? ` ${status}` : ''}`, String(objective), { sid: id, ws: record.workspace });
    }),
  );

  ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 忽略 */
        }
      }
    },
    'agent-monitor: event subscriptions',
  );

  // ─────────────────────────── 历史回填

  let backfillPromise = null;

  const readAllEvents = async (handle, expected) => {
    const first = await handle.read();
    let events = Array.isArray(first?.events) ? [...first.events] : [];
    let guardCount = 0;
    while ((expected === undefined || events.length < expected) && guardCount < 64) {
      guardCount += 1;
      const lastSeq = events.length > 0 ? Number(events[events.length - 1].seq) : -1;
      const next = await handle.read(lastSeq + 1);
      const more = Array.isArray(next?.events) ? next.events : [];
      if (more.length === 0) break;
      events = events.concat(more);
    }
    return events;
  };

  const backfill = async () => {
    collector.backfill = { state: 'scanning', scanned: 0, total: 0, startedAt: Date.now(), finishedAt: 0, error: null, events: 0 };
    collector.dirty = true;
    const persistence = ctx.sessionPersistence;
    if (!persistence || typeof persistence.list !== 'function') {
      collector.backfill = { ...collector.backfill, state: 'done', error: '没有 sessionPersistence 服务', finishedAt: Date.now() };
      return;
    }
    let snapshots = [];
    try {
      snapshots = [...(await persistence.list())];
    } catch (error) {
      collector.backfill = { ...collector.backfill, state: 'done', error: String(error?.message ?? error), finishedAt: Date.now() };
      return;
    }
    collector.backfill.total = snapshots.length;

    const projectionCache = ctx.get?.('sessionProjectionCache');

    for (const snapshot of snapshots) {
      const header = snapshot?.header;
      const id = String(header?.id ?? '');
      if (!id) continue;
      const record = collector.registerHeader(header);
      const revision = String(snapshot?.revision ?? snapshot?.sizeBytes ?? '');
      if (seen.get(id) === revision) {
        collector.backfill.scanned += 1;
        continue;
      }
      // 回填期间该会话的实时事件先丢弃：它们已经是持久事件，读日志时必然包含，避免重复记账。
      collector.markPending(id);
      try {
        if (projectionCache && typeof projectionCache.cachedSnapshot === 'function') {
          const view = projectionCache.cachedSnapshot(header);
          if (view) collector.attachCached(id, view.values);
        }
        const handle = await persistence.open(id, 'read');
        try {
          const events = await readAllEvents(handle, snapshot?.eventCount);
          collector.beginBatch();
          for (const event of events) collector.ingestEvent(record, event, { historical: true });
          collector.endBatch();
          collector.backfill.events += events.length;
          record.foldedUpTo = events.length > 0 ? Number(events[events.length - 1].seq) : -1;
        } finally {
          await handle.close?.();
        }
        seen.set(id, revision);
      } catch (error) {
        logger.warn?.(`[agent-monitor] 回填会话 ${id} 失败：${error?.message ?? error}`);
        collector.backfill.error = String(error?.message ?? error);
      } finally {
        collector.clearPending(id);
        collector.backfill.scanned += 1;
        collector.dirty = true;
      }
    }

    // 会话列表里已经不在持久层的（归档等）也登记一下，保证运行态可见
    for (const session of ctx.get?.('sessions')?.list?.() ?? []) {
      try {
        if (session?.header) collector.registerHeader(session.header);
      } catch {
        /* 忽略 */
      }
    }

    collector.backfill = { ...collector.backfill, state: 'done', finishedAt: Date.now() };
    collector.dirty = true;
    logger.info?.(`[agent-monitor] 历史回填完成：${collector.backfill.scanned}/${collector.backfill.total} 个会话，${collector.backfill.events} 条事件`);
  };

  const ensureBackfill = () => {
    if (backfillPromise) return backfillPromise;
    backfillPromise = backfill().catch((error) => {
      logger.warn?.(`[agent-monitor] 回填异常：${error?.message ?? error}`);
      collector.backfill = { ...collector.backfill, state: 'done', error: String(error?.message ?? error), finishedAt: Date.now() };
    });
    return backfillPromise;
  };

  // ─────────────────────────── 钱包余额

  const refreshWallet = async (reason = 'manual') => {
    const account = ctx.get?.('deepseekAccount');
    if (!account || typeof account.getBalance !== 'function') {
      collector.wallet = { at: Date.now(), status: 'unavailable', wallets: [], bonusWallets: [], error: '当前组合没有账号服务', reason };
      collector.dirty = true;
      return collector.wallet;
    }
    try {
      const balance = await account.getBalance({
        version: '0.1.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
      if (!balance) {
        collector.wallet = { at: Date.now(), status: 'signed-out', wallets: [], bonusWallets: [], error: null, reason };
      } else if (balance.status === 'failed') {
        collector.wallet = { at: Date.now(), status: 'failed', wallets: [], bonusWallets: [], error: '平台查询失败', reason };
      } else {
        collector.wallet = {
          at: Date.now(),
          status: 'ready',
          wallets: Array.isArray(balance.value) ? balance.value : [],
          bonusWallets: Array.isArray(balance.bonusWallets) ? balance.bonusWallets : [],
          error: null,
          reason,
        };
      }
    } catch (error) {
      collector.wallet = { at: Date.now(), status: 'error', wallets: [], bonusWallets: [], error: String(error?.message ?? error), reason };
    }
    collector.dirty = true;
    return collector.wallet;
  };

  // ─────────────────────────── 定时任务

  const timer = setInterval(() => {
    collector.rolloverIfNeeded(Date.now());
    const before = JSON.stringify(collector.alerts);
    collector.evaluateAlerts(Date.now());
    const changed = before !== JSON.stringify(collector.alerts);
    if (changed || collector.dirty) {
      collector.dirty = false;
      collector.notify({ type: 'stats', stats: collector.stats() });
    } else {
      collector.notify({ type: 'heartbeat', t: Date.now() });
    }
  }, 2000);
  timer.unref?.();

  let walletTicks = 0;
  const walletTimer = setInterval(() => {
    walletTicks += 1;
    if (walletTicks % 30 === 0) refreshWallet('auto'); // 2s × 30 = 60s
  }, 2000);
  walletTimer.unref?.();

  ctx.effect(
    () => () => {
      clearInterval(timer);
      clearInterval(walletTimer);
    },
    'agent-monitor: timers',
  );

  // ─────────────────────────── SSE

  const clients = new Set();

  const broadcast = (message) => {
    if (clients.size === 0) return;
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of clients) {
      try {
        res.write(line);
      } catch {
        clients.delete(res);
      }
    }
  };

  const unsubscribe = collector.subscribe((message) => {
    if (message?.type === 'stats') {
      broadcast({ type: 'stats', stats: message.stats });
      return;
    }
    broadcast(message);
  });

  ctx.effect(
    () => () => {
      unsubscribe();
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* 忽略 */
        }
      }
      clients.clear();
    },
    'agent-monitor: stream subscribers',
  );

  // ─────────────────────────── 路由

  const handleRequest = async (req, res, path) => {
    if (path === '/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        plugin: name,
        version: '0.1.0',
        backfill: collector.backfill.state,
        sessions: collector.sessions.size,
        frames: collector.frames.length,
        wallet: collector.wallet.status,
        prices: Object.keys(collector.prices),
      });
    }

    if (path === '/snapshot' && req.method === 'GET') {
      return json(res, 200, { ok: true, value: collector.snapshot() });
    }

    if (path === '/stats' && req.method === 'GET') {
      return json(res, 200, { ok: true, value: collector.stats() });
    }

    if (path === '/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': agent-monitor connected\n\n');
      clients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'snapshot', snapshot: collector.snapshot() })}\n\n`);
      ensureBackfill();
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keepAlive);
          clients.delete(res);
        }
      }, 15000);
      keepAlive.unref?.();
      const cleanup = () => {
        clearInterval(keepAlive);
        clients.delete(res);
      };
      res.on('close', cleanup);
      res.on('error', cleanup);
      return undefined;
    }

    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      const nextConfig = collector.updateConfig(body?.config ?? {});
      const nextPrices = body?.prices ? collector.updatePrices(body.prices) : collector.prices;
      return json(res, 200, { ok: true, value: { config: nextConfig, prices: nextPrices } });
    }

    if (path === '/wallet/refresh' && req.method === 'POST') {
      const wallet = await refreshWallet('manual');
      return json(res, 200, { ok: true, value: wallet });
    }

    if (path === '/export' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const what = url.searchParams.get('what') ?? 'daily';
      const format = url.searchParams.get('format') ?? 'csv';
      const stats = collector.stats();
      if (format === 'json') {
        const payload = JSON.stringify({ exportedAt: Date.now(), ...collector.snapshot() }, null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="agent-monitor-${stamp()}.json"`,
          'content-length': Buffer.byteLength(payload),
        });
        return res.end(payload);
      }

      let header;
      let rows;
      if (what === 'activity') {
        header = ['时间', '会话', '工作区', '类型', '工具', '摘要', '耗时ms', '状态', '模型', '未命中输入', '缓存命中', '缓存写入', '输出', '花费(元)', '峰时'];
        rows = collector.frames
          .filter((frame) => frame.hidden !== true)
          .map((frame) => {
            const tokens = frame.tokens ?? {};
            return [
              isoLocal(frame.t),
              frame.sid,
              frame.ws,
              frame.kind,
              frame.tool ?? '',
              frame.detail ?? '',
              frame.durationMs ?? '',
              frame.status ?? '',
              frame.model ?? '',
              tokens.uncachedInput ?? '',
              tokens.cacheRead ?? '',
              tokens.cacheWrite ?? '',
              tokens.output ?? '',
              typeof frame.cost === 'number' ? frame.cost.toFixed(6) : '',
              frame.peak === undefined ? '' : frame.peak ? '高峰' : '空闲',
            ];
          });
      } else if (what === 'sessions') {
        header = ['会话', '标题', '工作区', '是否子代理', '父会话', '模型', '轮次', '步骤', '请求', '工具调用', '报错', '会话花费(元)', '今日花费(元)', '会话未命中输入', '会话缓存命中', '会话输出', '上下文占用'];
        rows = stats.sessions.map((session) => [
          session.id,
          session.title,
          session.workspace,
          session.isSubagent ? '是' : '否',
          session.parentSession,
          session.model,
          session.turns,
          session.steps,
          session.requests,
          session.toolCalls,
          session.errors,
          session.cost.session.toFixed(6),
          session.cost.today.toFixed(6),
          session.tokens.session.uncachedInput,
          session.tokens.session.cacheRead,
          session.tokens.session.output,
          session.contextWindow > 0 ? `${((session.surfaceTokens / session.contextWindow) * 100).toFixed(1)}%` : '',
        ]);
      } else if (what === 'models') {
        header = ['模型', '今日花费(元)', '今日未命中输入', '今日缓存命中', '今日缓存写入', '今日输出'];
        rows = stats.byModel.map((entry) => [
          entry.model,
          entry.cost.toFixed(6),
          entry.tokens.uncachedInput,
          entry.tokens.cacheRead,
          entry.tokens.cacheWrite,
          entry.tokens.output,
        ]);
      } else {
        header = ['日期', '花费(元)', 'tokens', '请求数'];
        rows = stats.trend.map((entry) => [entry.day, entry.cost.toFixed(6), entry.tokens, entry.requests]);
      }
      const csv = csvOf(header, rows);
      const payload = `\uFEFF${csv}\r\n`;
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="agent-monitor-${what}-${stamp()}.csv"`,
        'content-length': Buffer.byteLength(payload),
      });
      return res.end(payload);
    }

    return json(res, 404, { ok: false, error: `no route: ${req.method} ${path}` });
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API,
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const url = new URL(req.url ?? '/', 'http://localhost');
          const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) || '/' : '/';
          try {
            await handleRequest(req, res, path);
          } catch (error) {
            const code = error?.code === 'body-too-large' ? 413 : error?.code === 'bad-request' ? 400 : 500;
            if (!res.headersSent) json(res, code, { ok: false, error: String(error?.message ?? error) });
            else res.end();
          }
        },
      }),
    `agent-monitor: routes under ${API}`,
  );

  // ─────────────────────────── 启动

  ctx.effect(() => {
    refreshWallet('startup');
    return undefined;
  }, 'agent-monitor: initial wallet read');

  // 有客户端连上时立刻回填；否则等第一帧事件也会触发一次，避免空转。
  const warmup = setTimeout(() => ensureBackfill(), 1500);
  warmup.unref?.();

  logger.info?.(`[agent-monitor] host 半已加载，路由前缀 ${API}`);
}
