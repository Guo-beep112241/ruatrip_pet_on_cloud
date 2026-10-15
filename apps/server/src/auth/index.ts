/**
 * 认证与会话（审计 B2）。
 *
 * 原实现的问题：`currentUser()` 永远返回同一个 `user-local`，
 * 也就是说**任何人打开网址都是同一只宠物、同一份好感度**。
 * 公开上线必须解决，否则等于所有访客共享一个账号。
 *
 * 设计取舍：
 *   - 用 Node 内置的 `crypto.scrypt` 做密码哈希，不引 bcrypt/argon2
 *     （避免原生编译依赖，云平台构建更省事）。参数见 HASH_PARAMS，符合当前推荐强度。
 *   - 会话用 HMAC 签名的无状态 token（不存服务端 session），
 *     这样多实例部署不需要共享 session 存储；代价是无法即时吊销单个会话，
 *     因此 token 有效期较短，并提供基于「密码版本号」的全量吊销。
 *   - 邮箱 + 密码先做，手机号/微信登录留接口（国内上线通常需要，见 docs/API-INTEGRATION.md）。
 */

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { SubscriptionTier, UserProfile } from '../../../../packages/shared/src/index.ts';

/**
 * scrypt 的 Promise 包装。
 * 不用 util.promisify：它的重载解析会吞掉带 options 的调用签名，
 * 而我们需要传 N/r/p 参数。
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { ...options, maxmem: SCRYPT_MAXMEM }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * scrypt 参数：N=2^14, r=8, p=1。
 *
 * 为什么不是 N=2^15：Node 的 scrypt 默认 maxmem 是 32MB，
 * 内存需求约 128*N*r 字节，N=32768 正好撞到上限并抛
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS。这里用 N=2^14（约 16MB）
 * 并把 maxmem 提到 64MB，兼容性更好，强度依然足够（约 30~60ms/次）。
 */
const HASH_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

/** scrypt 内存上限：必须大于 128*N*r，留一倍余量 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 会话有效期：30 天。无状态 token 无法即时吊销，所以不宜过长 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 密码                                                               */
/* ------------------------------------------------------------------ */

/** 生成 `scrypt$N$r$p$salt$hash` 格式的密码哈希 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordStrength(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, HASH_PARAMS.keylen, {
    N: HASH_PARAMS.N,
    r: HASH_PARAMS.r,
    p: HASH_PARAMS.p,
  });
  return [
    'scrypt',
    HASH_PARAMS.N,
    HASH_PARAMS.r,
    HASH_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * 校验密码。
 * 用 timingSafeEqual 做定长比较，避免通过响应时间推断哈希前缀。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltRaw ?? '', 'base64');
  const expected = Buffer.from(hashRaw ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, { N, r, p });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 密码强度要求：至少 8 位且不是纯数字/纯字母 */
export function assertPasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw Object.assign(new Error('WEAK_PASSWORD'), { status: 400, detail: '密码至少 8 位' });
  }
  if (password.length > 200) {
    throw Object.assign(new Error('WEAK_PASSWORD'), { status: 400, detail: '密码过长' });
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasOther = /[^a-zA-Z]/.test(password);
  if (!hasLetter || !hasOther) {
    throw Object.assign(new Error('WEAK_PASSWORD'), {
      status: 400,
      detail: '密码需要同时包含字母与数字/符号',
    });
  }
}

/** 客户端可先自查，避免白跑一次请求 */
export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 8) issues.push('至少 8 位');
  if (!/[a-zA-Z]/.test(password)) issues.push('需要包含字母');
  if (!/[^a-zA-Z]/.test(password)) issues.push('需要包含数字或符号');
  return issues;
}

/* ------------------------------------------------------------------ */
/* 邮箱                                                               */
/* ------------------------------------------------------------------ */

/** 宽松但安全的邮箱校验：不做 RFC 全量匹配，够用且不会误拒 */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') {
    throw Object.assign(new Error('INVALID_EMAIL'), { status: 400 });
  }
  const value = email.trim().toLowerCase();
  if (value.length < 5 || value.length > 254) {
    throw Object.assign(new Error('INVALID_EMAIL'), { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
    throw Object.assign(new Error('INVALID_EMAIL'), { status: 400 });
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* 会话 token（无状态 HMAC）                                          */
/* ------------------------------------------------------------------ */

export interface SessionPayload {
  userId: string;
  /** 密码版本：改密码后自增，旧 token 立即失效（弥补无状态无法单点吊销） */
  pwv: number;
  /** 签发时间 */
  iat: number;
  /** 过期时间 */
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueSession(
  input: { userId: string; passwordVersion: number },
  secret: string,
  now = Date.now(),
): string {
  const payload: SessionPayload = {
    userId: input.userId,
    pwv: input.passwordVersion,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

export type SessionVerdict =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifySession(token: string, secret: string, now = Date.now()): SessionVerdict {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };
  const [body, signature] = token.split('.');
  if (!body || !signature) return { ok: false, reason: 'malformed' };

  const expected = sign(body, secret);
  // 定长比较：签名长度固定，直接比长度再 timingSafeEqual
  if (expected.length !== signature.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.userId !== 'string' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

/* ------------------------------------------------------------------ */
/* 用户记录                                                           */
/* ------------------------------------------------------------------ */

/**
 * 账号记录：包含凭据，**绝不能**直接返回给前端。
 * 对外展示的部分是 UserProfile（shared 里定义）。
 */
export interface AccountRecord {
  id: string;
  email: string;
  /** scrypt 哈希，格式见 hashPassword */
  passwordHash: string;
  /** 密码版本；改密码时 +1，使旧 token 失效 */
  passwordVersion: number;
  profile: UserProfile;
  /** 第三方登录绑定（预留手机号 / 微信） */
  wechatOpenId?: string;
  phone?: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 剔除凭据后的对外形态 */
export function publicProfile(account: AccountRecord): UserProfile {
  return account.profile;
}

export function createDefaultProfile(input: {
  id: string;
  nickname?: string;
  tier?: SubscriptionTier;
  avatarEmoji?: string;
}): UserProfile {
  const slots: Record<string, number> = { free: 1, plus: 3, pro: 6 };
  const tier = input.tier ?? 'free';
  return {
    id: input.id,
    nickname: input.nickname?.trim() || '毛绒屋主人',
    avatarEmoji: input.avatarEmoji || '🧸',
    tier,
    petSlots: slots[tier] ?? 1,
    streakDays: 1,
    claimedMilestones: [],
    // 默认开启未成年人保护：宁可多一层确认
    minorGuardEnabled: true,
    monthlySpendLimit: 200,
    createdAt: new Date().toISOString(),
  };
}

export function newUserId(): string {
  return `u-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/* ------------------------------------------------------------------ */
/* 会话密钥                                                           */
/* ------------------------------------------------------------------ */

/**
 * 取会话签名密钥。
 *
 * 生产环境必须显式配置 SESSION_SECRET；未配置时：
 *   - 开发环境：用进程内随机密钥（重启后旧 token 失效，可接受）
 *   - 生产环境：直接拒绝启动，避免用可预测的默认值签名（那等于没有鉴权）
 */
export function resolveSessionSecret(config: { secret: string; isProduction: boolean }): string {
  if (config.secret && config.secret.length >= 32) return config.secret;
  if (config.secret && config.secret.length > 0) {
    throw new Error('SESSION_SECRET_TOO_SHORT：SESSION_SECRET 至少需要 32 个字符。');
  }
  if (config.isProduction) {
    throw new Error(
      'SESSION_SECRET_MISSING：生产环境必须配置 SESSION_SECRET（至少 32 字符随机串）。' +
        '生成方法：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }
  return randomBytes(32).toString('base64url');
}
