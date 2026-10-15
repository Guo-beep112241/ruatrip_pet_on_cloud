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
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** 是否为二进制响应（由 handler 自己写 res） */
  raw?: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, raw = false): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: path.split('/').filter(Boolean),
      handler,
      raw,
    });
    return this;
  }

  get(path: string, handler: Handler, raw = false) { return this.add('GET', path, handler, raw); }
  post(path: string, handler: Handler, raw = false) { return this.add('POST', path, handler, raw); }
  patch(path: string, handler: Handler, raw = false) { return this.add('PATCH', path, handler, raw); }
  put(path: string, handler: Handler, raw = false) { return this.add('PUT', path, handler, raw); }
  delete(path: string, handler: Handler, raw = false) { return this.add('DELETE', path, handler, raw); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
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
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
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
