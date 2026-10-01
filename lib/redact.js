/**
 * Agent 监视器 —— 脱敏与截断（Q23 / Q30 决策）。
 *
 * 面板会展示工具参数与命令输出，其中可能夹带密钥、密码、token。这里在**写入内存缓冲之前**
 * 就完成脱敏，因此界面、SSE 推送、导出文件三者共用同一份已脱敏的数据，不存在「导出泄露」的旁路。
 */

const REDACTIONS = [
  // 私钥块
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[私钥已脱敏]'],
  // 常见前缀密钥（DeepSeek / OpenAI / Anthropic / GitHub / Slack / AWS）
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{12,}/g, 'gh*_***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, 'xox*-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza***'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, 'eyJ***.***.***'],
  // Authorization / Bearer
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // key=value 形态的敏感字段
  [
    /(["']?)(api[-_]?key|apikey|access[-_]?key|secret[-_]?key|client[-_]?secret|password|passwd|pwd|token|auth[-_]?token|access[-_]?token|refresh[-_]?token|credential|private[-_]?key)\1(\s*[:=]\s*)(["']?)([^\s"',;}{)\]]{4,})\4/gi,
    '$2$3***',
  ],
  // DSH 环境变量里的秘密
  [/\b(DSH_[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*\s*=\s*)\S+/gi, '$1***'],
  // 带凭据的 URL
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
];

/** 对一段文本做脱敏。非字符串原样返回（调用方负责序列化）。 */
export function redactText(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 深脱敏：对象/数组/字符串都处理，深度与节点数都有上限，防止超大参数把内存吃穿。 */
export function redactValue(value, state = { nodes: 0, depth: 0 }) {
  state.nodes += 1;
  if (state.nodes > 4000 || state.depth > 12) return '[已省略]';
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const next = { nodes: state.nodes, depth: state.depth + 1 };
    return value.slice(0, 500).map((item) => redactValue(item, next));
  }
  const next = { nodes: state.nodes, depth: state.depth + 1 };
  const out = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    if (count >= 200) {
      out['…'] = '[已省略]';
      break;
    }
    count += 1;
    out[key] = redactValue(value[key], next);
  }
  return out;
}

/**
 * 截断：界面默认只画前 maxBytes 字节 / maxLines 行（Q30 决策），完整内容留在内存里供展开。
 * @returns {{text:string, truncated:boolean, bytes:number, lines:number}}
 */
export function truncateForDisplay(text, maxBytes = 4096, maxLines = 200) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const bytes = Buffer.byteLength(source, 'utf8');
  const allLines = source.length === 0 ? 0 : source.split('\n').length;
  if (bytes <= maxBytes && allLines <= maxLines) {
    return { text: source, truncated: false, bytes, lines: allLines };
  }
  let clipped = source;
  if (allLines > maxLines) clipped = clipped.split('\n').slice(0, maxLines).join('\n');
  if (Buffer.byteLength(clipped, 'utf8') > maxBytes) {
    let slice = Buffer.from(clipped, 'utf8').subarray(0, maxBytes).toString('utf8');
    // 不让多字节字符被切成半个
    slice = slice.replace(/\uFFFD+$/u, '');
    clipped = slice;
  }
  return { text: clipped, truncated: true, bytes, lines: allLines };
}

/** 单字段入内存前的硬上限（防止一次巨大的工具输出把内存吃满）。 */
export const FIELD_MAX_BYTES = 64 * 1024;

export function clampField(text) {
  const source = typeof text === 'string' ? text : '';
  if (Buffer.byteLength(source, 'utf8') <= FIELD_MAX_BYTES) return source;
  const clipped = Buffer.from(source, 'utf8').subarray(0, FIELD_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/u, '');
  return `${clipped}\n…[监视器截断，原长 ${source.length} 字符]`;
}
