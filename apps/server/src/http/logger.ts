/**
 * 结构化日志（审计 O3）。
 *
 * 原状：各处零散 console.log/warn/error，线上排查只能靠 grep 文本，
 * 而且无法按「请求」串联（一个慢请求涉及的几行日志是分开的）。
 *
 * 现在统一为 JSON Lines：
 *   - 每行一个 JSON，方便直接喂给日志平台（Render/CloudWatch/Loki 都能解析）
 *   - 每个请求带 requestId，把「请求开始 → 业务日志 → 请求结束」串起来
 *   - 敏感字段过滤：不打印密钥、token、密码、对话内容
 *   - 人类可读模式：开发环境自动转成易读格式（不然本地调试很痛苦）
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

/** 绝不能出现在日志里的字段名（含子串匹配） */
const REDACT_KEYS = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'authorization',
  'cookie', 'session', 'credential', 'privatekey', 'private_key', 'accesskey',
  // 用户内容类：日志里不该出现对话原话或图片数据
  'text', 'content', 'message', 'prompt', 'photourl', 'image', 'base64',
];

/** 递归脱敏：把敏感字段替换成 [redacted] */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // 长字符串一律截断：日志里不该塞进大段内容（也可能就是对话）
    return value.length > 200 ? `${value.slice(0, 200)}…[+${value.length - 200}]` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (REDACT_KEYS.some((r) => lower.includes(r))) {
      out[key] = '[redacted]';
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

/** 生成短请求 id（够用且不占日志宽度） */
export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface LoggerOptions {
  /** JSON Lines（生产）还是人类可读（开发） */
  pretty: boolean;
  /** 低于该级别不输出 */
  minLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly pretty: boolean;
  private readonly minLevel: LogLevel;

  constructor(options: LoggerOptions) {
    this.pretty = options.pretty;
    this.minLevel = options.minLevel ?? 'info';
  }

  /** 派生一个带固定字段的 logger（例如绑定 requestId 与路径） */
  child(base: LogFields): Logger {
    const parent = this;
    const child = new Logger({ pretty: this.pretty, minLevel: this.minLevel });
    // 覆盖 write，把 base 字段合并进去
    (child as unknown as { base: LogFields }).base = base;
    void parent;
    return child;
  }

  private base: LogFields = {};

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const merged = redact({ ...this.base, ...(fields ?? {}) }) as LogFields;
    const stamp = new Date().toISOString();

    if (this.pretty) {
      const icon = level === 'error' ? '✗' : level === 'warn' ? '!' : level === 'debug' ? '·' : ' ';
      const extras = Object.entries(merged)
        .filter(([k]) => k !== 'requestId')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' ');
      const rid = merged.requestId ? `[${String(merged.requestId)}] ` : '';
      // 用 stderr 输出 warn/error，便于平台区分级别
      const line = `${icon} ${rid}${message}${extras ? `  ${extras}` : ''}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
      return;
    }

    const line = JSON.stringify({ level, time: stamp, msg: message, ...merged });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

/** 进程级 logger；开发环境用易读格式 */
export function createLogger(env: string): Logger {
  return new Logger({ pretty: env !== 'production', minLevel: env === 'production' ? 'info' : 'debug' });
}

/* ------------------------------------------------------------------ */
/* 前端错误上报（O3 的另一半）                                         */
/* ------------------------------------------------------------------ */

export interface ClientErrorReport {
  /**
   * 崩溃信息。字段名刻意不用 `message`：日志脱敏规则会把 `message`
   * 视为可能含用户对话内容的字段而屏蔽。这里换成专用名，
   * 既保住脱敏规则，又能看到真正的崩溃原因。
   */
  errorMessage: string;
  /** 面包屑：用户做了什么导致这个错误（不含内容，只有事件名） */
  trail?: string[];
  url?: string;
  userAgent?: string;
  at?: number;
}

/**
 * 校验前端上报。**不信任客户端**：
 *   - 消息与面包屑都要限长，否则可以被灌大
 *   - 只保留结构，不解析内容（上报里不该有用户对话）
 */
export function sanitizeClientReport(input: unknown): ClientErrorReport | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const rawMessage = raw.errorMessage ?? raw.message;
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return null;

  const errorMessage = rawMessage.trim().slice(0, 500);
  const trail = Array.isArray(raw.trail)
    ? raw.trail.filter((t): t is string => typeof t === 'string').slice(0, 20).map((t) => t.slice(0, 80))
    : undefined;

  return {
    errorMessage,
    ...(trail ? { trail } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url.slice(0, 300) } : {}),
    ...(typeof raw.userAgent === 'string' ? { userAgent: raw.userAgent.slice(0, 200) } : {}),
    ...(typeof raw.at === 'number' && Number.isFinite(raw.at) ? { at: raw.at } : {}),
  };
}
