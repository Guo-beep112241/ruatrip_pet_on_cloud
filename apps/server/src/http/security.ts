/**
 * 安全响应头与 CORS 策略。
 *
 * 背景（审计 S2 / S4）：
 *  - 旧实现里 origin 不匹配白名单时会回落 `Access-Control-Allow-Origin: *`，
 *    同时带 `Allow-Credentials: true`。这既是安全反模式，也违反 CORS 规范
 *    （`*` 不允许与 credentials 共存）。等于没有白名单。
 *  - 旧实现没有任何安全响应头，缺少点击劫持、MIME 嗅探、Referrer 泄漏的防护。
 */

/** 全部响应都该带的头 */
const BASE_HEADERS: Record<string, string> = {
  // 禁止浏览器猜测 MIME（配合接口显式声明 content-type）
  'x-content-type-options': 'nosniff',
  // 不允许被 iframe 嵌套（防点击劫持）；如需嵌入可换成 SAMEORIGIN
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // 明确关闭项目用不到的敏感能力
  'permissions-policy': 'geolocation=(self), microphone=(self), camera=(self), payment=()',
  // 隐藏技术栈指纹
  'x-powered-by': '',
  // 跨源隔离相关的保守设置
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * 前端的 CSP。
 *
 * 允许项都有明确理由，不用 'unsafe-eval'：
 *  - style-src 'unsafe-inline'  : Tailwind 运行时注入与 inline style（渐变/光影）需要
 *  - img-src data: blob:        : 打卡照片、合成图、降级 SVG 都是 data URL
 *  - connect-src 'self' + 白名单: 前后端分离部署时前端要能调后端
 *  - media-src data: blob:      : TTS 音频是 data URL
 *  - style-src fonts.googleapis.com + font-src fonts.gstatic.com : Quicksand 字体
 *    （国内访问 Google Fonts 可能不稳定，所以 index.html 里同时配了系统圆体兜底，
 *      字体加载失败不影响任何功能，只是字形会退化成系统字体）
 */
export function contentSecurityPolicy(extraConnectSrc: string[] = []): string {
  const connect = ["'self'", ...extraConnectSrc].join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    // Google Fonts 的样式表来自 fonts.googleapis.com，
    // 字体文件来自 fonts.gstatic.com（见下面的 font-src）。
    // 两者都必须显式放行，否则字体加载会被 CSP 拦掉。
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src " + connect,
  ].join('; ');
}

/** 对 API 响应更严格：不需要任何非 self 来源 */
export const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function applyBaseHeaders(res: {
  setHeader(name: string, value: string): void;
}, extra: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries({ ...BASE_HEADERS, ...extra })) {
    if (value === '') continue; // 空值表示「删除该头」
    res.setHeader(key, value);
  }
}

/**
 * 严格 CORS。
 *
 * 规则：
 *  - 白名单里明确写了 `*`  → 允许任意来源，但**绝不允许带凭证**（规范要求）
 *  - origin 在白名单里      → 回显该 origin，允许凭证
 *  - origin 不在白名单里    → **不设置任何 ACAO 头**，浏览器自会拦截
 *
 * 返回 true 表示应当继续处理请求（预检会直接结束）。
 */
export function applyCors(
  res: {
    setHeader(name: string, value: string): void;
    writeHead(status: number): void;
    end(): void;
  },
  requestOrigin: string | undefined,
  allowedOrigins: string[],
  requestMethod: string | undefined,
): { preflightHandled: boolean; origin: string | null } {
  const allowAny = allowedOrigins.includes('*');

  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-request-id');
  res.setHeader('access-control-max-age', '600');
  // 让 CDN 知道响应随 Origin 变化，避免把 A 站点的响应缓存给 B 站点
  res.setHeader('vary', 'Origin');

  let effective: string | null = null;
  if (allowAny) {
    // 通配模式：不允许凭证，否则浏览器也会拒绝
    res.setHeader('access-control-allow-origin', '*');
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('access-control-allow-origin', requestOrigin);
    res.setHeader('access-control-allow-credentials', 'true');
    effective = requestOrigin;
  }
  // 不在白名单：什么都不设 → 浏览器拦截跨域请求（同源访问不受影响）

  if (requestMethod === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return { preflightHandled: true, origin: effective };
  }
  return { preflightHandled: false, origin: effective };
}
