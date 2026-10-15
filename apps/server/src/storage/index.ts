/**
 * 对象存储适配层（审计 B3 修复）。
 *
 * 问题：打卡照片与旧照复原原本以 base64 data URL 存进 JSON 文件，
 * 一张手机照片 3~5MB，存十几张就把数据文件撑到几十 MB，读写迅速变慢。
 *
 * 现在改为：图片落对象存储，数据库里只存 URL。
 * 默认实现是本地磁盘（零配置即可跑），配了 S3 兼容凭证就自动切换
 * （Cloudflare R2 / 腾讯云 COS / 阿里云 OSS / MinIO / AWS S3 都是 S3 协议）。
 */

import { createHash, createHmac } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as FS, existsSync } from 'node:fs';
import { dirname as pathDirname, join, resolve, sep } from 'node:path';

const W_OK = FS.W_OK;

export type StorageDriver = 'local' | 's3';

export interface StoredObject {
  /** 存储键，形如 pets/pet-xxx/photo-123.jpg */
  key: string;
  /** 可直接给浏览器加载的地址 */
  url: string;
  bytes: number;
  contentType: string;
}

/**
 * 存储键约定：`<ownerId>/<random>.<ext>`
 * 不含业务前缀，这样一个键就能同时用于本地 URL 与 S3 对象名，
 * 避免出现 URL 与路由对不上的问题。
 */
export interface StorageProvider {
  readonly driver: StorageDriver;
  put(input: {
    key: string;
    data: Buffer;
    contentType: string;
  }): Promise<StoredObject>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  delete(key: string): Promise<boolean>;
  /** 生成可直接访问的 URL（本地驱动会带前缀路径） */
  urlFor(key: string): string;
  /** 健康探测：返回 false 表示存储不可用 */
  healthy(): Promise<boolean>;
}

/* ============================================================
 * 图片校验：不允许把任意文件当图片上传
 * ============================================================ */

const IMAGE_SIGNATURES: { ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.subarray(0, 3).toString('ascii') === 'GIF' },
  {
    ext: 'avif',
    mime: 'image/avif',
    test: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' && b.subarray(8, 12).toString('ascii').startsWith('avif'),
  },
];

/** 支持 data URL 与原始 Buffer 两种输入 */
export interface DecodedImage {
  ok: boolean;
  ext?: string;
  mime?: string;
  data?: Buffer;
  /** 原始字节数（未编码前） */
  bytes?: number;
  reason?: string;
}

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB：手机压缩后照片的合理上限

/** 解析并校验图片；这是「不信任客户端」的唯一入口 */
export function decodeImage(input: string | Buffer, maxBytes = MAX_IMAGE_BYTES): DecodedImage {
  let buf: Buffer;
  let declaredMime: string | undefined;

  if (typeof input === 'string') {
    const match = /^data:([\w/+.-]+);base64,(.*)$/s.exec(input.trim());
    if (!match) {
      return { ok: false, reason: '图片格式不正确：需要 data:<mime>;base64,<内容> 或直接上传文件' };
    }
    declaredMime = match[1];
    try {
      buf = Buffer.from(match[2] ?? '', 'base64');
    } catch {
      return { ok: false, reason: 'base64 解码失败' };
    }
  } else {
    buf = input;
  }

  if (buf.length === 0) return { ok: false, reason: '图片内容为空' };
  if (buf.length > maxBytes) {
    return {
      ok: false,
      reason: `图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请压缩到 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 以内`,
    };
  }

  // 用魔数判断真实类型，不信任客户端声明的 MIME
  const hit = IMAGE_SIGNATURES.find((sig) => sig.test(buf));
  if (!hit) {
    return { ok: false, reason: '只支持 JPEG / PNG / WebP / GIF / AVIF 图片' };
  }
  // 客户端声明的 MIME 与真实类型不符时以真实类型为准（可能是攻击尝试，记录但不放行差异类型）
  if (declaredMime && declaredMime !== hit.mime) {
    return { ok: false, reason: `声明的格式（${declaredMime}）与实际内容（${hit.mime}）不一致` };
  }

  return { ok: true, ext: hit.ext, mime: hit.mime, data: buf, bytes: buf.length };
}

/** 生成安全的存储键：只保留可预测字符，防止路径穿越与双斜杠 */
export function buildKey(ownerId: string, ext: string, unique = Date.now().toString(36)): string {
  const safe = (s: string, fallback: string) => s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || fallback;
  const owner = safe(ownerId, 'anonymous');
  const suffix = safe(ext, 'bin');
  return `${owner}/${unique}-${Math.random().toString(36).slice(2, 8)}.${suffix}`;
}

/* ============================================================
 * 本地磁盘驱动（默认，零配置）
 * ============================================================ */

export class LocalStorageProvider implements StorageProvider {
  readonly driver: StorageDriver = 'local';
  private readonly root: string;
  private readonly publicPrefix: string;

  /**
   * publicPrefix 必须与 docs/DEPLOYMENT.md 里的反向代理规则一致。
   * 默认 /api/uploads —— 这样静态文件由服务端自己服务，不需要额外配 Nginx；
   * 生产环境想让 Nginx 直接读盘的话，把它设成 /uploads 并加一条 location 规则即可。
   */
  constructor(root: string, publicPrefix = '/api/uploads') {
    this.root = root;
    this.publicPrefix = publicPrefix.replace(/\/$/, '');
  }

  private resolveKey(key: string): string | null {
    // 防目录穿越：规范化后必须仍在 root 之内
    const target = resolvePath(this.root, key);
    if (!target) return null;
    return target;
  }

  urlFor(key: string): string {
    return `${this.publicPrefix}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(input: { key: string; data: Buffer; contentType: string }): Promise<StoredObject> {
    const target = this.resolveKey(input.key);
    if (!target) throw new Error('INVALID_STORAGE_KEY');
    await mkdir(pathDirname(target), { recursive: true });
    await writeFile(target, input.data);
    return {
      key: input.key,
      url: this.urlFor(input.key),
      bytes: input.data.length,
      contentType: input.contentType,
    };
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    const target = this.resolveKey(key);
    if (!target || !existsSync(target)) return null;
    const data = await readFile(target);
    return { data, contentType: guessMime(key) };
  }

  async delete(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    if (!target || !existsSync(target)) return false;
    await rm(target, { force: true });
    return true;
  }

  async healthy(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function resolvePath(root: string, key: string): string | null {
  const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalizedKey || normalizedKey.includes('..')) return null;
  const target = resolve(root, normalizedKey);
  const rootResolved = resolve(root);
  return target === rootResolved || target.startsWith(`${rootResolved}${sep}`) ? target : null;
}

function guessMime(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

/* ============================================================
 * S3 兼容驱动（Cloudflare R2 / 腾讯云 COS / 阿里云 OSS / MinIO / AWS S3）
 * ============================================================ */

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** CDN 或公开访问前缀；为空时用 endpoint/bucket */
  publicBaseUrl?: string;
  /** 是否使用 path-style（MinIO、部分私有云需要） */
  forcePathStyle?: boolean;
}

/**
 * 用 AWS Signature V4 直接签名请求，因此**不需要 aws-sdk 依赖**。
 * 只实现了 put/get/delete，够本项目用。
 */
export class S3StorageProvider implements StorageProvider {
  readonly driver: StorageDriver = 's3';
  private readonly cfg: S3Config;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  private objectUrl(key: string): string {
    const base = this.cfg.endpoint.replace(/\/$/, '');
    return this.cfg.forcePathStyle === false
      ? `${base.replace('://', `://${this.cfg.bucket}.`)}/${key}`
      : `${base}/${this.cfg.bucket}/${key}`;
  }

  urlFor(key: string): string {
    const base = this.cfg.publicBaseUrl?.replace(/\/$/, '');
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return base ? `${base}/${encoded}` : this.objectUrl(key);
  }

  async put(input: { key: string; data: Buffer; contentType: string }): Promise<StoredObject> {
    const res = await this.signedFetch('PUT', input.key, input.data, input.contentType);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`S3 PUT 失败 ${res.status}：${text.slice(0, 200)}`);
    }
    return {
      key: input.key,
      url: this.urlFor(input.key),
      bytes: input.data.length,
      contentType: input.contentType,
    };
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    const res = await this.signedFetch('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET 失败 ${res.status}`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? guessMime(key),
    };
  }

  async delete(key: string): Promise<boolean> {
    const res = await this.signedFetch('DELETE', key);
    return res.ok || res.status === 404;
  }

  async healthy(): Promise<boolean> {
    try {
      // HEAD 一个不存在的键：403 说明签名/凭证有问题，404 说明连通正常
      const res = await this.signedFetch('HEAD', '__healthcheck__');
      return res.status !== 403 && res.status !== 401;
    } catch {
      return false;
    }
  }

  /** AWS Signature V4 签名（零依赖实现） */
  private async signedFetch(
    method: string,
    key: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const url = new URL(this.objectUrl(key));
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]!.trim()}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');

    const signingKey = hmacChain(this.cfg.secretAccessKey, dateStamp, this.cfg.region);
    const signature = hmacHex(signingKey, stringToSign);

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return fetch(url, {
      method,
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 从环境变量构建                                                   */
/* ------------------------------------------------------------------ */

export function createStorage(config: {
  dataDir: string;
  s3?: Partial<S3Config> & { bucket?: string };
}): StorageProvider {
  const s3 = config.s3;
  const complete =
    s3 && s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey;

  if (complete) {
    return new S3StorageProvider({
      endpoint: s3!.endpoint!,
      bucket: s3!.bucket!,
      accessKeyId: s3!.accessKeyId!,
      secretAccessKey: s3!.secretAccessKey!,
      region: s3!.region || 'auto',
      ...(s3!.publicBaseUrl ? { publicBaseUrl: s3!.publicBaseUrl } : {}),
      ...(s3!.forcePathStyle !== undefined ? { forcePathStyle: s3!.forcePathStyle } : {}),
    });
  }
  return new LocalStorageProvider(join(config.dataDir, 'uploads'));
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}
/** AWS 的密钥派生链：kDate → kRegion → kService → kSigning */
function hmacChain(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/* ============================================================
 * 图片引用校验（防止绕过上传接口）
 * ============================================================ */

/**
 * 为什么需要：`/api/upload` 已经限制了体积与类型，
 * 但如果 `/api/travel/checkin` 或 `/api/capsule` 仍然直接接受
 * 任意字符串作为 photoUrl，攻击者就能绕过上传接口，
 * 在 JSON body 里直接塞一个 5MB 的 base64 data URL（审计 B3 的残留口子）。
 *
 * 规则：
 *  - 允许空值（使用合成图或降级图）
 *  - 允许我们自己的存储 URL（含 S3/CDN 前缀）
 *  - 允许小体积 data URL（< 64KB，用于前端本地裁剪出的缩略图等场景）
 *  - 其它一律拒绝，并提示改用 /api/upload
 */
export const MAX_INLINE_DATA_URL_BYTES = 64 * 1024;

export interface ImageRefVerdict {
  ok: boolean;
  reason?: string;
  /** 规范化后的引用（原样返回或空字符串） */
  value: string;
}

export function validateImageRef(
  input: unknown,
  options: {
    /** 允许的 URL 前缀（来自 storage.urlFor 与 CDN 配置） */
    allowedPrefixes: string[];
    /** 是否允许外部 http(s) 图片（默认不允许，避免把别人的图当自己的存） */
    allowExternal?: boolean;
  },
): ImageRefVerdict {
  if (input === null || input === undefined || input === '') return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, reason: '图片地址必须是字符串', value: '' };

  const value = input.trim();
  if (value === '') return { ok: true, value: '' };

  if (value.startsWith('data:')) {
    // 近似估算解码后的字节数：base64 长度 * 3/4
    const comma = value.indexOf(',');
    const payloadLength = comma >= 0 ? value.length - comma - 1 : value.length;
    const estimated = Math.floor((payloadLength * 3) / 4);
    if (estimated > MAX_INLINE_DATA_URL_BYTES) {
      return {
        ok: false,
        reason:
          `内嵌图片太大（约 ${(estimated / 1024 / 1024).toFixed(1)}MB）。` +
          '请先调用 POST /api/upload 上传，再把返回的 url 传进来。',
        value: '',
      };
    }
    if (!value.startsWith('data:image/')) {
      return { ok: false, reason: '只接受图片类型的 data URL', value: '' };
    }
    return { ok: true, value };
  }

  if (options.allowedPrefixes.some((prefix) => prefix && value.startsWith(prefix))) {
    return { ok: true, value };
  }

  if (options.allowExternal && /^https?:\/\//i.test(value)) {
    return { ok: true, value };
  }

  return {
    ok: false,
    reason: '图片地址不受信任。请先调用 POST /api/upload 上传图片，再使用返回的 url。',
    value: '',
  };
}
