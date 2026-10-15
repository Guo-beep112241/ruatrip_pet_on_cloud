/**
 * 前端 API 客户端。
 *
 * 约定：所有请求都发到 /api（开发环境由 Vite 代理到服务端，生产环境同源部署）。
 * 前端永远不会接触任何第三方密钥 —— 所有 AI / 3D / 语音调用都发生在服务端。
 */
export interface ApiFailureShape {
  code: string;
  message: string;
  fallback?: boolean;
  detail?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/api';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const url = `${BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(signal ? { signal } : {}),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', '连不上服务端。请确认后端已启动（npm run dev:server）。', error);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'BAD_RESPONSE', `服务端返回了非 JSON 内容：${text.slice(0, 80)}`);
    }
  }

  const payload = json as { ok?: boolean; data?: T; error?: ApiFailureShape } | null;
  if (!res.ok || !payload?.ok) {
    const err = payload?.error;
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? `请求失败（${res.status}）`, err?.detail);
  }
  return payload.data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
};

/** 带 query 的小工具 */
export function withQuery(path: string, params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return path;
  const search = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
  return `${path}?${search.toString()}`;
}
