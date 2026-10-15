/**
 * auth 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { hashPassword, issueSession, newUserId, normalizeEmail, passwordIssues, verifyPassword } from '../auth/index.ts';
import { config } from '../config.ts';
import { redeem } from '../services/pet.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerAuthRoutes(router: Router, svc: RouteServices): void {
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
/* 认证（审计 B2）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 前端启动时的第一个请求：库里有没有账号、是否需要登录。
 * 有了它，前端才能在「首次部署 → 引导注册」与「老库 → 直接进应用」之间正确选择。
 */
  router.get('/api/auth/status', (ctx) => {
  const accounts = repos.listAccounts().length;
  const mode = config.authMode;
  // 匿名请求也能拿到这个信息：它只暴露「有没有账号」这一个布尔量
  const authenticated = (() => {
    try {
      return authOf(ctx.req).authenticated;
    } catch {
      return false;
    }
  })();
  return {
    ok: true,
    data: {
      hasAccounts: accounts > 0,
      accountCount: accounts,
      mode,
      /** 无账号且是单用户模式 → 前端直接进引导问卷 */
      requiresSetup: accounts === 0,
      authenticated,
      /** 遗留数据是否需要认领（旧版无邮箱账号） */
      legacyClaimAvailable: repos.listAccounts().some((a) => a.email.endsWith('@legacy.local')),
    },
  };
});

/** 注册 */
  router.post('/api/auth/register', async (ctx) => {
  const body = check(ctx.body, SCHEMAS.register);
  const email = normalizeEmail(body.email);
  const password = body.password;

  const issues = passwordIssues(password);
  if (issues.length) {
    throw Object.assign(new Error('WEAK_PASSWORD'), { status: 400, detail: issues.join('；') });
  }
  if (repos.getAccountByEmail(email)) {
    throw Object.assign(new Error('EMAIL_TAKEN'), { status: 409 });
  }

  const account = repos.createAccount({
    id: newUserId(),
    email,
    passwordHash: await hashPassword(password),
    ...(body.nickname ? { nickname: body.nickname } : {}),
  });
  repos.touchLogin(account.id);

  return {
    ok: true,
    data: {
      token: issueSession({ userId: account.id, passwordVersion: account.passwordVersion }, SESSION_SECRET),
      user: account.profile,
    },
  };
});

/** 登录 */
  router.post('/api/auth/login', async (ctx) => {
  const body = check(ctx.body, SCHEMAS.login);
  const email = normalizeEmail(body.email);
  const password = body.password;

  const account = repos.getAccountByEmail(email);
  /**
   * 统一错误信息：不区分「邮箱不存在」与「密码错误」，
   * 避免被用来枚举已注册邮箱。
   * 即使账号不存在也跑一次哈希校验，抹平响应时间差异。
   */
  const ok = account
    ? await verifyPassword(password, account.passwordHash)
    : await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!account || !ok) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { status: 401 });
  }

  repos.touchLogin(account.id);
  return {
    ok: true,
    data: {
      token: issueSession({ userId: account.id, passwordVersion: account.passwordVersion }, SESSION_SECRET),
      user: account.profile,
    },
  };
});

/** 当前账号信息 */
  router.get('/api/auth/me', (ctx) => {
  const auth = authOf(ctx.req);
  return {
    ok: true,
    data: { user: auth.account.profile, authenticated: auth.authenticated },
  };
});

/** 改密码：成功后 passwordVersion 自增，所有旧 token 立即失效 */
  router.post('/api/auth/password', async (ctx) => {
  const auth = authOf(ctx.req);
  if (!auth.authenticated) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  const body = check(ctx.body, SCHEMAS.changePassword);

  const current = body.currentPassword ?? '';
  const next = body.newPassword;

  // 遗留账号（无密码哈希）：允许直接设置新密码，完成「认领」
  if (auth.account.passwordHash) {
    const ok = await verifyPassword(current, auth.account.passwordHash);
    if (!ok) throw Object.assign(new Error('INVALID_CREDENTIALS'), { status: 401 });
  }
  const issues = passwordIssues(next);
  if (issues.length) throw Object.assign(new Error('WEAK_PASSWORD'), { status: 400, detail: issues.join('；') });

  repos.setPassword(auth.userId, await hashPassword(next));
  const updated = repos.getAccount(auth.userId)!;
  return {
    ok: true,
    data: {
      // 旧 token 已失效，返回新 token 避免用户被动登出
      token: issueSession({ userId: updated.id, passwordVersion: updated.passwordVersion }, SESSION_SECRET),
      user: updated.profile,
    },
  };
});

/**
 * 注销账号：删除账号与全部关联数据（审计 F5 的数据删除通道）。
 * 需要输入密码确认，避免会话被劫持时被一键清空。
 */
  router.delete('/api/auth/account', async (ctx) => {
  const auth = authOf(ctx.req);
  if (!auth.authenticated) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  const body = check(ctx.body, SCHEMAS.deleteAccount);
  if (body.confirm !== 'DELETE') {
    throw Object.assign(new Error('CONFIRM_REQUIRED'), { status: 400 });
  }
  if (auth.account.passwordHash) {
    const ok = await verifyPassword(String(body.password ?? ''), auth.account.passwordHash);
    if (!ok) throw Object.assign(new Error('INVALID_CREDENTIALS'), { status: 401 });
  }
  const result = repos.deleteAccount(auth.userId);
  return { ok: true, data: { deleted: true, ...result } };
});

/* ------------------------------------------------------------------ */
/* 请求体校验规则（审计 M1）                                            */
/* ------------------------------------------------------------------ */

}
