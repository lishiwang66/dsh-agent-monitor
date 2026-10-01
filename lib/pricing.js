/**
 * Agent 监视器 —— 单价与花费估算。
 *
 * 事实依据（2026-09 官方价目页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）：
 *   deepseek-flash    缓存命中 0.02 / 未命中 1 / 输出 4   （元 / 百万 tokens，空闲时段）
 *   deepseek-v4-pro   缓存命中 0.15 / 未命中 4.5 / 输出 13.5
 *   高峰时段 = 北京时间周一至周五 09:00-12:00、14:00-18:00，价格为空闲时段的两倍。
 *
 * 已知近似：法定节假日无法判定，会被当成高峰（略微高估）。缓存写入按「未命中」价计
 * （Q32 决策，与官方「未命中 = 完整推理输入」口径一致）。
 */

export const PRICE_UNIT = 1_000_000;

/** 官方人民币单价（可被用户在面板里整体替换）。 */
export const DEFAULT_PRICES = {
  'deepseek-flash': {
    label: 'deepseek-flash',
    currency: 'CNY',
    offPeak: { cacheRead: 0.02, cacheMiss: 1, output: 4 },
    peak: { cacheRead: 0.04, cacheMiss: 2, output: 8 },
  },
  'deepseek-v4-pro': {
    label: 'deepseek-v4-pro',
    currency: 'CNY',
    offPeak: { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheRead: 0.3, cacheMiss: 9, output: 27 },
  },
};

export const FALLBACK_MODEL = 'deepseek-flash';

/** 本机模型名 → 价目表键的别名（旧名与带后缀的名字都归一到同一档）。 */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
};

/** 北京时间（UTC+8，无夏令时）是否处于高峰时段。 */
export function isPeak(timeMs) {
  const t = Number.isFinite(timeMs) ? timeMs : Date.now();
  const bj = new Date(t + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 把一个模型名解析到价目表里的某一档。 */
export function resolvePrice(model, prices = DEFAULT_PRICES) {
  const table = prices && typeof prices === 'object' ? prices : DEFAULT_PRICES;
  const keys = Object.keys(table);
  const fallbackKey = keys.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : keys[0];
  if (!model) return { key: fallbackKey, entry: table[fallbackKey], priced: false };
  const raw = String(model);
  const lower = raw.toLowerCase();
  if (table[raw]) return { key: raw, entry: table[raw], priced: true };
  if (table[lower]) return { key: lower, entry: table[lower], priced: true };
  const alias = MODEL_ALIASES[lower];
  if (alias !== undefined && table[alias]) return { key: alias, entry: table[alias], priced: true };
  for (const key of keys) {
    const k = key.toLowerCase();
    if (lower.includes(k) || k.includes(lower)) return { key, entry: table[key], priced: true };
  }
  if (lower.includes('pro') && table['deepseek-v4-pro']) {
    return { key: 'deepseek-v4-pro', entry: table['deepseek-v4-pro'], priced: false };
  }
  return { key: fallbackKey, entry: table[fallbackKey], priced: false };
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * 把一次请求的 usage 归一成四个互不相交的记费桶。
 *
 * DSH 的离线字段里 `inputTokens` 已经是「未命中输入」，实测满足
 * `inputTokens + cacheReadTokens + outputTokens === totalTokens`（913+12800+188=13901）。
 * 若某个 provider 反而把完整提示词长度报进 `inputTokens`，用 totalTokens 反推修正。
 */
export function splitBuckets(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const cacheRead = num(u.cacheReadTokens);
  const cacheWrite = num(u.cacheWriteTokens);
  const output = num(u.outputTokens);
  let uncachedInput = num(u.inputTokens);
  const total = num(u.totalTokens);
  if (total > 0 && uncachedInput + cacheRead + cacheWrite + output > total + 1) {
    uncachedInput = Math.max(0, total - cacheRead - cacheWrite - output);
  }
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    output,
    reasoning: num(u.reasoningTokens),
    cacheMiss: uncachedInput + cacheWrite,
    total: uncachedInput + cacheRead + cacheWrite + output,
  };
}

/** 四个桶相加（投影、事件、流式帧都可能有部分字段）。 */
export function addBuckets(target, usage) {
  const b = splitBuckets(usage);
  target.uncachedInput += b.uncachedInput;
  target.cacheRead += b.cacheRead;
  target.cacheWrite += b.cacheWrite;
  target.output += b.output;
  target.reasoning += b.reasoning;
  target.total += b.total;
  return target;
}

export function zeroBuckets() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
}

/**
 * 一次 usage 的花费。峰谷按事件时间戳判定（Q31 决策）。
 * @returns {{total:number, currency:string, peak:boolean, model:string, priced:boolean, rate:object, parts:object}}
 */
export function computeCost(usage, model, timeMs, options = {}) {
  const prices = options.prices ?? DEFAULT_PRICES;
  const peakAware = options.peakAware !== false;
  const resolved = resolvePrice(model, prices);
  const entry = resolved.entry ?? DEFAULT_PRICES[FALLBACK_MODEL];
  const peak = peakAware ? isPeak(timeMs) : false;
  const rate = (peak && entry.peak) || entry.offPeak || { cacheRead: 0, cacheMiss: 0, output: 0 };
  const buckets = splitBuckets(usage);
  const parts = {
    cacheMiss: (buckets.cacheMiss / PRICE_UNIT) * (rate.cacheMiss ?? 0),
    cacheRead: (buckets.cacheRead / PRICE_UNIT) * (rate.cacheRead ?? 0),
    output: (buckets.output / PRICE_UNIT) * (rate.output ?? 0),
  };
  return {
    total: parts.cacheMiss + parts.cacheRead + parts.output,
    currency: entry.currency ?? 'CNY',
    peak,
    model: resolved.key,
    priced: resolved.priced,
    rate,
    parts,
  };
}

export function formatMoney(value, currency = 'CNY') {
  const symbol = currency === 'USD' ? '$' : '¥';
  const n = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(n);
  let digits = 2;
  if (abs > 0 && abs < 0.01) digits = 4;
  else if (abs < 1) digits = 3;
  return `${symbol}${n.toFixed(digits)}`;
}

export function formatTokens(value) {
  const n = Number.isFinite(value) ? value : 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(2)}k`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatPercent(ratio, digits = 0) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatDuration(ms) {
  const n = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** 本地自然日的起点（Q18 决策：自然日 + 本地 0 点重置）。 */
export function startOfLocalDay(timeMs) {
  const d = new Date(Number.isFinite(timeMs) ? timeMs : Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地自然日的 key：YYYY-MM-DD。 */
export function localDayKey(timeMs) {
  const d = new Date(Number.isFinite(timeMs) ? timeMs : Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 最近 n 天的 key 列表（含今天，按时间升序）。 */
export function recentDayKeys(n, nowMs = Date.now()) {
  const keys = [];
  for (let i = n - 1; i >= 0; i -= 1) keys.push(localDayKey(nowMs - i * 86_400_000));
  return keys;
}
