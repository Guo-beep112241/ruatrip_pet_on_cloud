/**
 * 极小 HTTP 路由：零依赖，支持路径参数与 JSON 请求体。
 * 之所以不引框架，是为了让「服务端开箱即跑」——只需要 Node 与 tsx。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** multipart 请求的原始字节（普通 JSON 请求为 null） */
  rawBody?: Buffer | null;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export interface RouteOptions {
  /** 是否由 handler 自己写 res（二进制响应） */
  raw?: boolean;
  /** 限流分桶名（见 http/rateLimit.ts 的 RATE_LIMITS）。不传则按读写自动归类 */
  bucket?: string;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  raw?: boolean;
  bucket?: string;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: RouteOptions | boolean = {}): this {
    // 兼容旧的 raw 布尔写法，避免一次性改动所有路由
    const opts: RouteOptions = typeof options === 'boolean' ? { raw: options } : options;
    this.routes.push({
      method: method.toUpperCase(),
      segments: path.split('/').filter(Boolean),
      handler,
      ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
      ...(opts.bucket !== undefined ? { bucket: opts.bucket } : {}),
    });
    return this;
  }

  get(path: string, handler: Handler, options: RouteOptions | boolean = {}) { return this.add('GET', path, handler, options); }
  post(path: string, handler: Handler, options: RouteOptions | boolean = {}) { return this.add('POST', path, handler, options); }
  patch(path: string, handler: Handler, options: RouteOptions | boolean = {}) { return this.add('PATCH', path, handler, options); }
  put(path: string, handler: Handler, options: RouteOptions | boolean = {}) { return this.add('PUT', path, handler, options); }
  delete(path: string, handler: Handler, options: RouteOptions | boolean = {}) { return this.add('DELETE', path, handler, options); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string>; bucket?: string } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i]!;
        const value = parts[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(value);
        else if (seg !== value) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params, ...(route.bucket ? { bucket: route.bucket } : {}) };
    }
    return null;
  }
}

/** 读取原始字节（multipart 需要，不能转成字符串） */
export async function readRawBody(req: IncomingMessage, limitBytes = 30 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 12 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(buf);
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('INVALID_JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  sendJson(res, status, { ok: false, error: { code, message, ...extra } });
}
