/**
 * upload 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { config } from '../config.ts';
import { parseMultipart } from '../http/multipart.ts';
import { buildKey, decodeImage } from '../storage/index.ts';
import { multipartBoundary, MultipartError } from '../http/multipart.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerUploadRoutes(router: Router, svc: RouteServices): void {
  const {
    SESSION_SECRET,
    activePet,
    analytics,
    authOf,
    care,
    currentUser,
    enforceDailyQuota,
    imageRefPrefixes,
    migration,
    persistenceChoice,
    push,
    repos,
    requirePet,
    requireValidImageRef,
    storage,
    store,
    touchCounters,
  } = svc;
/* 文件上传（审计 B3：照片不再以 data URL 存进 JSON）                     */
/* ------------------------------------------------------------------ */

/**
 * 本地存储驱动的文件服务。
 *
 * 用 S3/COS/R2 时图片走 CDN，不需要这个路由；
 * 用本地磁盘（默认）时，前端拿到的 URL 是 /uploads/xxx，
 * 由这里读盘返回。生产环境建议让 Nginx/Caddy 直接服务 uploads 目录，
 * 性能更好（见 docs/DEPLOYMENT.md）。
 */
  router.get('/api/uploads/:owner/:file', async (ctx) => {
  if (storage.driver !== 'local') {
    ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end('当前使用对象存储，图片请从 CDN 访问');
    return null;
  }
  const key = `${ctx.params.owner}/${ctx.params.file}`;
  const object = await storage.get(key);
  if (!object) {
    ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end('not found');
    return null;
  }
  ctx.res.writeHead(200, {
    'content-type': object.contentType,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    // 图片不该被当成文档解析，避免 SVG 之类的向量被利用
    'content-security-policy': "default-src 'none'; sandbox",
  });
  ctx.res.end(object.data);
  return null;
});

/**
 * 上传图片。
 *
 * 支持两种入参：
 *   1. multipart/form-data —— 手机 <input type="file" capture> 走这条
 *   2. JSON { image: "data:image/jpeg;base64,..." } —— 兼容旧前端
 *
 * 校验：魔数判断真实类型（不信任客户端声明的 MIME）、4MB 上限、
 * 存储键由服务端生成（防目录穿越）。
 */
  router.post('/api/upload', async (ctx) => {
  const user = currentUser(ctx.req);
  let data: Buffer | null = null;
  let declared: string | undefined;
  let purpose = 'photo';

  if (ctx.rawBody) {
    const boundary = multipartBoundary(ctx.req.headers['content-type']);
    if (!boundary) throw Object.assign(new Error('INVALID_MULTIPART'), { status: 400 });
    const parsed = parseMultipart(ctx.rawBody, boundary, { maxFileBytes: config.storage.maxImageBytes });
    const file = parsed.files.find((f) => f.fieldName === 'file') ?? parsed.files[0];
    if (!file) throw Object.assign(new Error('NO_FILE'), { status: 400 });
    data = file.data;
    declared = file.contentType;
    purpose = (parsed.fields.purpose ?? 'photo').slice(0, 24);
  } else {
    const b = (ctx.body ?? {}) as { image?: string; purpose?: string };
    if (typeof b.image !== 'string') throw Object.assign(new Error('NO_FILE'), { status: 400 });
    const decoded = decodeImage(b.image, config.storage.maxImageBytes);
    if (!decoded.ok || !decoded.data || !decoded.ext) {
      throw Object.assign(new Error(decoded.reason ?? 'INVALID_IMAGE'), { status: 400 });
    }
    data = decoded.data;
    declared = decoded.mime;
    purpose = (b.purpose ?? 'photo').slice(0, 24);
  }

  const verified = decodeImage(data, config.storage.maxImageBytes);
  if (!verified.ok || !verified.data || !verified.ext || !verified.mime) {
    throw Object.assign(new Error(verified.reason ?? 'INVALID_IMAGE'), { status: 400 });
  }
  void declared; // 已由魔数决定真实类型，声明值仅用于参考

  // 键格式：<ownerId>/<random>.<ext>，与本地 URL 及 S3 对象名一一对应
  const key = buildKey(user.id, verified.ext);
  const stored = await storage.put({ key, data: verified.data, contentType: verified.mime });

  return {
    ok: true,
    data: {
      url: stored.url,
      key: stored.key,
      bytes: stored.bytes,
      contentType: stored.contentType,
      driver: storage.driver,
      purpose,
    },
  };
});

/** 删除已上传的图片（审计 F5：用户必须有删除通道） */
  router.delete('/api/upload/:owner/:file', async (ctx) => {
  const user = currentUser(ctx.req);
  // 只允许删除自己目录下的文件
  if (ctx.params.owner !== user.id) {
    throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
  }
  const key = `${ctx.params.owner}/${ctx.params.file}`;
  const removed = await storage.delete(key);
  return { ok: true, data: { removed, key } };
});
}
