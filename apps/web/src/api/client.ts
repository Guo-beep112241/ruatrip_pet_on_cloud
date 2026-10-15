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

/* ============================================================
 * 会话 token（审计 B2）
 * ============================================================ */

const TOKEN_KEY = 'ruatrip.token';

/**
 * token 存 localStorage：Web 端没有更安全的选择
 * （httpOnly cookie 需要服务端会话与 CSRF 防护，本项目用无状态 token）。
 * 因此 XSS 是最高优先级风险 —— 这也是为什么服务端加了 CSP、
 * 并且 SVG 注入被当作 P0 修掉。线上务必保持 CSP 开启。
 */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可用，此时退化为「仅当前会话有效」 */
  }
}

export function isLoggedIn(): boolean {
  return Boolean(getToken());
}

/** 会话失效时通知应用回到登录页（由 store 注册回调，避免循环依赖） */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** 这些错误码表示会话已不可用，前端应该清 token 并回到登录页 */
const SESSION_ERROR_CODES = new Set([
  'AUTH_REQUIRED',
  'INVALID_SESSION',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'ACCOUNT_NOT_FOUND',
]);

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const init: RequestInit = {
    method,
    headers,
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
    const code = err?.code ?? 'UNKNOWN';
    // 会话失效：清掉本地 token 并让应用回到登录页，
    // 否则用户会一直看到「连不上服务端」而不知道要重新登录。
    if (SESSION_ERROR_CODES.has(code)) {
      setToken(null);
      onUnauthorized?.();
    }
    throw new ApiError(res.status, code, err?.message ?? `请求失败（${res.status}）`, err?.detail);
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

/* ============================================================
 * 文件上传（审计 B3）
 * ============================================================ */

export interface UploadResult {
  url: string;
  key: string;
  bytes: number;
  contentType: string;
  driver: 'local' | 's3';
  purpose?: string;
}

/**
 * 上传图片并拿到可持久化的 URL。
 *
 * 为什么不让前端直接传 base64：
 * 一张手机照片 base64 后 4~7MB，塞进 JSON 会让数据库迅速膨胀
 * （实测十几张就把数据文件撑到 13MB+）。改为先上传、库里只存 URL。
 *
 * 用 FormData 走 multipart，浏览器会自动处理边界与二进制编码。
 */
export async function uploadImage(file: File, purpose = 'photo'): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('purpose', purpose);

  let res: Response;
  try {
    const token = getToken();
    res = await fetch(`${BASE}/upload`, {
      method: 'POST',
      body: form,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', '上传失败：连不上服务端。', error);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'BAD_RESPONSE', '上传返回了非 JSON 内容。');
    }
  }
  const payload = json as { ok?: boolean; data?: UploadResult; error?: ApiFailureShape } | null;
  if (!res.ok || !payload?.ok || !payload.data) {
    throw new ApiError(res.status, payload?.error?.code ?? 'UPLOAD_FAILED', payload?.error?.message ?? '上传失败');
  }
  return payload.data;
}

/** 删除自己上传的图片（对应设置里的删除通道） */
export async function deleteUpload(key: string): Promise<boolean> {
  const [owner, file] = key.split('/');
  if (!owner || !file) return false;
  const token = getToken();
  const res = await fetch(`${BASE}/upload/${encodeURIComponent(owner)}/${encodeURIComponent(file)}`, {
    method: 'DELETE',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  if (!res.ok) return false;
  const json = (await res.json()) as { ok?: boolean; data?: { removed?: boolean } };
  return Boolean(json?.data?.removed);
}

/** 把一张图片压缩到指定上限内（客户端先减负，避免上传被拒） */
export async function compressImage(file: File, maxBytes = 4 * 1024 * 1024): Promise<File> {
  if (file.size <= maxBytes) return file;
  // 用 canvas 渐进降质；失败就原样返回，让服务端给出明确提示
  try {
    const bitmap = await createImageBitmap(file);
    let quality = 0.8;
    let blob: Blob | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      blob = await new Promise<Blob | null>((resolve) =>
        canvasFrom(bitmap).toBlob(resolve, 'image/jpeg', quality),
      );
      if (blob && blob.size <= maxBytes) break;
      quality -= 0.15;
    }
    if (blob && blob.size <= maxBytes) {
      return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    }
  } catch {
    /* 浏览器不支持时走原文件，由服务端校验 */
  }
  return file;
}

function canvasFrom(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  // 长边限制到 1600px，足够手机屏幕展示，也能显著减小体积
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}


/* ============================================================
 * 认证接口（审计 B2）
 * ============================================================ */

export interface AuthStatus {
  hasAccounts: boolean;
  accountCount: number;
  mode: 'required' | 'optional';
  requiresSetup: boolean;
  authenticated: boolean;
  legacyClaimAvailable: boolean;
}

export interface AuthSession {
  token: string;
  user: import('./types').UserProfile;
}

export const auth = {
  status: () => request<AuthStatus>('GET', '/auth/status'),
  me: () => request<{ user: import('./types').UserProfile; authenticated: boolean }>('GET', '/auth/me'),

  async register(input: { email: string; password: string; nickname?: string }): Promise<AuthSession> {
    const session = await request<AuthSession>('POST', '/auth/register', input);
    setToken(session.token);
    return session;
  },

  async login(input: { email: string; password: string }): Promise<AuthSession> {
    const session = await request<AuthSession>('POST', '/auth/login', input);
    setToken(session.token);
    return session;
  },

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<AuthSession> {
    const session = await request<AuthSession>('POST', '/auth/password', input);
    setToken(session.token);
    return session;
  },

  async deleteAccount(input: { password: string; confirm: string }): Promise<void> {
    await request('DELETE', '/auth/account', input);
    setToken(null);
  },

  logout(): void {
    setToken(null);
  },
};
