/**
 * 请求认证（审计 B2 的第二半）。
 *
 * 职责：把 `Authorization: Bearer <token>` 解析成受信任的 userId，
 * 并为每个请求提供归属校验入口。所有涉及用户数据的路由都必须经过这里。
 *
 * 关于「匿名模式」：
 *   项目早期是单用户无鉴权的。为了不破坏既有部署（以及演示/本地开发体验），
 *   当 `AUTH_MODE=optional` 且库里只有一个遗留账号时，允许匿名请求落到该账号。
 *   生产环境请设 `AUTH_MODE=required`，此时未登录一律 401。
 */

import type { IncomingMessage } from 'node:http';
import { resolveSessionSecret, verifySession } from '../auth/index.ts';
import type { AccountRecord } from '../auth/index.ts';
import type { Repositories } from '../repositories/index.ts';

export type AuthMode = 'required' | 'optional';

export interface AuthContext {
  /** 当前请求所属账号 */
  account: AccountRecord;
  /** 该账号的 id */
  userId: string;
  /** 是否来自真实登录（false = 匿名回落） */
  authenticated: boolean;
}

export class AuthError extends Error {
  readonly status = 401;
  constructor(code: string) {
    super(code);
    this.name = 'AuthError';
  }
}

/** 从请求头解析 Bearer token */
export function extractBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export interface AuthDeps {
  repos: Repositories;
  secret: string;
  mode: AuthMode;
  /** 生产环境禁止匿名回落 */
  isProduction: boolean;
}

/**
 * 解析当前请求的身份。
 *
 * 顺序：
 *   1. 有 token 且有效 → 真实账号
 *   2. 无 token 且允许匿名，且库里只有一个账号 → 回落到它（兼容旧部署）
 *   3. 否则 401
 */
export function resolveAuth(req: IncomingMessage, deps: AuthDeps): AuthContext {
  const token = extractBearerToken(req);

  if (token) {
    const verdict = verifySession(token, deps.secret);
    if (!verdict.ok) {
      // 过期要单独告知，前端才能清掉本地 token 并跳登录
      throw new AuthError(verdict.reason === 'expired' ? 'SESSION_EXPIRED' : 'INVALID_SESSION');
    }
    const account = deps.repos.getAccount(verdict.payload.userId);
    if (!account) throw new AuthError('ACCOUNT_NOT_FOUND');
    // 密码版本不匹配 → 改过密码，旧 token 作废
    if (account.passwordVersion !== verdict.payload.pwv) {
      throw new AuthError('SESSION_REVOKED');
    }
    return { account, userId: account.id, authenticated: true };
  }

  if (deps.mode !== 'optional' || deps.isProduction) {
    throw new AuthError('AUTH_REQUIRED');
  }

  /**
   * 匿名回落（仅用于平滑迁移旧部署）。
   *
   * 条件是「库里恰好有一个**遗留占位账号**」——也就是由旧版单用户数据
   * 迁移而来、email 形如 xxx@legacy.local 的账号。
   * 通过正常注册创建的账号一律不允许匿名访问，
   * 否则「刚注册第一个用户的真实部署」就等于没有鉴权。
   */
  const accounts = deps.repos.listAccounts();
  if (accounts.length === 1 && accounts[0]!.email.endsWith(LEGACY_EMAIL_SUFFIX)) {
    const only = accounts[0]!;
    return { account: only, userId: only.id, authenticated: false };
  }
  throw new AuthError('AUTH_REQUIRED');
}

/** 遗留占位账号的邮箱后缀（见 repositories.migrateLegacyUser） */
export const LEGACY_EMAIL_SUFFIX = '@legacy.local';

/* ------------------------------------------------------------------ */
/* 归属校验                                                           */
/* ------------------------------------------------------------------ */

/**
 * 断言宠物属于当前用户。
 *
 * 这是修复「拿到别人的 petId 就能读写」的关键点：
 * 原来的 requirePet 只检查「宠物存在」，不检查「是不是你的」。
 */
export function assertPetOwned(
  repos: Repositories,
  userId: string,
  petId: string | null | undefined,
): string {
  if (!petId) throw Object.assign(new Error('PET_ID_REQUIRED'), { status: 400 });
  if (!repos.ownsPet(userId, petId)) {
    // 统一返回 404 而不是 403：不泄漏「这个 id 确实存在」的信息
    throw Object.assign(new Error('PET_NOT_FOUND'), { status: 404 });
  }
  return petId;
}

export function assertConversationOwned(
  repos: Repositories,
  userId: string,
  conversationId: string,
): string {
  if (!repos.ownsConversation(userId, conversationId)) {
    throw Object.assign(new Error('CONVERSATION_NOT_FOUND'), { status: 404 });
  }
  return conversationId;
}

export function assertCheckinOwned(repos: Repositories, userId: string, checkinId: string): string {
  if (!repos.ownsCheckin(userId, checkinId)) {
    throw Object.assign(new Error('CHECKIN_NOT_FOUND'), { status: 404 });
  }
  return checkinId;
}

export function assertCapsuleOwned(repos: Repositories, userId: string, capsuleId: string): string {
  if (!repos.ownsCapsule(userId, capsuleId)) {
    throw Object.assign(new Error('CAPSULE_NOT_FOUND'), { status: 404 });
  }
  return capsuleId;
}

/* ------------------------------------------------------------------ */
/* 会话密钥（进程内缓存一次）                                          */
/* ------------------------------------------------------------------ */

let cachedSecret: string | null = null;

export function sessionSecret(config: { secret: string; isProduction: boolean }): string {
  if (!cachedSecret) cachedSecret = resolveSessionSecret(config);
  return cachedSecret;
}

/** 仅供测试重置缓存的密钥 */
export function __resetSessionSecretForTests(): void {
  cachedSecret = null;
}
