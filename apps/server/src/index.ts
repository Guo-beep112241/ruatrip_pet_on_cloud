/**
 * RuaTrip（Rua途）v2.0 服务端入口
 *
 * 设计目标：
 *   - 零外部依赖即可启动（只用 Node 内置模块 + tsx 做 TS 运行）
 *   - 所有外部 AI / 3D / 语音能力都通过 adapters 抽象，未配置时回落 Mock
 *   - /api/integration 明确列出「需要介入 API 的地方」
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.ts';
import { getStore } from './db/store.ts';
import { createPersistenceDriver } from './db/drivers.ts';
import { Repositories } from './repositories/index.ts';
import { readJsonBody, readRawBody, Router, sendError, sendJson, type Ctx } from './http/router.ts';
import { serveStatic, webDistAvailable } from './http/static.ts';
import { API_CSP, applyBaseHeaders, applyCors, contentSecurityPolicy } from './http/security.ts';
import {
  DEFAULT_DAILY_LIMITS,
  clientKey,
  dailyQuota,
  rateLimitDisabled,
  rateLimitStore,
  ruleFor,
} from './http/rateLimit.ts';
import { MultipartError, multipartBoundary, parseBoundary, parseMultipart } from './http/multipart.ts';
import { validate, ValidationError, type Schema } from './http/validate.ts';
import { formatIssues, hasFatal, validateConfig } from './http/startupCheck.ts';
import {
  AuthError,
  assertCapsuleOwned,
  assertConversationOwned,
  assertPetOwned,
  resolveAuth,
  sessionSecret,
  type AuthContext,
} from './http/auth.ts';
import { hashPassword, newUserId, verifyPassword, passwordIssues, normalizeEmail, issueSession } from './auth/index.ts';
import {
  MINOR_MONTHLY_HARD_CAP,
  PET_SLOTS,
  TIER_SPEND_CAP,
  billingState,
  checkPetSlot,
  checkSpend,
  type SpendEntry,
} from './services/billing.ts';
import { hasObjectStorage } from './config.ts';
import { buildKey, createStorage, decodeImage, validateImageRef } from './storage/index.ts';
import { integrationReport } from './adapters/registry.ts';
import { activeLlmProvider, getLastLlmError } from './adapters/chat.ts';
import { Analytics, RemoteAnalyticsSink } from './adapters/analytics.ts';
import { PushService, WebPushProvider, generationDonePushText, longingPushText } from './adapters/push.ts';
import { CareTracker, SUPPORT_RESOURCES } from './services/care.ts';
import {
  DESTINATIONS,
  PREFERENCE_QUESTIONS,
  SCENE_PRESETS,
  SHOP_ITEMS,
  SPECIES_CATALOG,
  SUBSCRIPTION_PLANS,
} from '../../../packages/shared/src/catalog.ts';
import { AFFECTION_RULES, DAILY_AFFECTION_CAP } from '../../../packages/shared/src/rules.ts';
import type { Pet, SubscriptionTier, UserProfile } from '../../../packages/shared/src/index.ts';
import { inferProfile, suggestNames } from './services/inference.ts';
import { buildPersonalityCard, buildQuirks, INSTANT_POOL, speciesById } from './services/persona.ts';
import { createPetFromAnswers, INCUBATING_LINES, redeem, shopFor } from './services/pet.ts';
import {
  advanceStreak,
  applyGain,
  canPerform,
  moodBubble,
  nowIso,
  reactionFor,
  refreshPetState,
  todayUsage,
} from './services/growth.ts';
import { conversationHistory, ensureConversation, openingMessage, sendMessage } from './services/chat.ts';
import { capacityFor, rememberEvent } from './services/memory.ts';
import {
  badgesFor,
  destinationById,
  ensureWishlist,
  performCheckin,
  storyProgress,
} from './services/travel.ts';
import { generateJournal, generatePostcard } from './services/content.ts';
import { renderPetSvg, safePalette, safeSpecies } from './services/petArt.ts';
import { activeTtsProvider, VOICE_PRESETS } from './services/adapters-bridge.ts';

/**
 * 持久化驱动选择（审计 B1）。
 *
 * 默认用 SQLite（Node 22.5+ 内置，零依赖、真持久化），
 * 配了 DATABASE_URL=postgres:// 就切 Postgres（多实例部署的唯一正确选择），
 * STORAGE_DRIVER=file 才会退回原来的 JSON 文件。
 */
const persistenceChoice = createPersistenceDriver({
  dataDir: config.dataDir,
  driver: config.persistence.driver,
  databaseUrl: config.persistence.databaseUrl,
  sqliteFile: config.persistence.sqliteFile,
  pgSsl: config.persistence.pgSsl,
});

const store = getStore(config.dataDir, { driver: persistenceChoice.driver });
const repos = new Repositories(store);

/**
 * 埋点（审计 F3）：本地始终记录，配了 ANALYTICS_* 则额外上报。
 * 只采集行为计数与时序，不采集对话内容与照片（见 adapters/analytics.ts 的白名单）。
 */
const analytics = new Analytics(
  config.analytics.endpoint && config.analytics.writeKey
    ? new RemoteAnalyticsSink(config.analytics.endpoint, config.analytics.writeKey)
    : null,
);

/**
 * 推送（审计 F2）：未配真实通道时用本地实现（应用内通知列表），
 * 不会假装投递成功。
 */
const push = new PushService(
  config.push.endpoint && config.push.publicKey && config.push.privateKey
    ? new WebPushProvider({
        publicKey: config.push.publicKey,
        privateKey: config.push.privateKey,
        sendEndpoint: config.push.endpoint,
      })
    : undefined,
);

/** 情绪关怀（审计 F4）：会话级信号，不落库 */
const care = new CareTracker();

/**
 * 抚摸计数（按宠物）。
 * 抚摸不加好感度也没有日志，但「一直点」是最典型的高强度使用信号，
 * 所以单独计数用于关怀判断。
 */
const touchCounters = new Map<string, number>();

/** 对象存储：四个 S3 变量齐全就用 S3，否则本地磁盘（审计 B3） */
const storage = createStorage({
  dataDir: config.dataDir,
  s3: {
    endpoint: config.storage.endpoint,
    bucket: config.storage.bucket,
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
    region: config.storage.region,
    ...(config.storage.publicBaseUrl ? { publicBaseUrl: config.storage.publicBaseUrl } : {}),
    ...(config.storage.forcePathStyle !== undefined ? { forcePathStyle: config.storage.forcePathStyle } : {}),
  },
});

/** 允许的图片引用前缀：本地驱动与 CDN */
function imageRefPrefixes(): string[] {
  const prefixes = [storage.urlFor('')];
  if (config.storage.publicBaseUrl) prefixes.push(config.storage.publicBaseUrl);
  return prefixes.filter(Boolean);
}

/** 校验并使用图片引用；不合法就抛 400 并提示改用上传接口 */
function requireValidImageRef(input: unknown, field: string): string {
  const verdict = validateImageRef(input, { allowedPrefixes: imageRefPrefixes() });
  if (!verdict.ok) {
    throw Object.assign(new Error(verdict.reason ?? 'INVALID_IMAGE_REF'), {
      status: 400,
      field,
    });
  }
  return verdict.value;
}

/* ------------------------------------------------------------------ */
/* 用户：单用户本地档案（多用户版本接入鉴权后替换本段）                        */
/* ------------------------------------------------------------------ */
/**
 * 启动时的数据迁移：旧版单例 user → users 集合（审计 B2）。
 * 不迁移的话，老用户的宠物 ownerId 会指向一个不存在的账号，等于全部失联。
 */
const migration = repos.migrateLegacyUser();
if (migration.migrated) {
  console.log(`     已迁移旧版单用户数据到账号集合（userId=${migration.userId}）`);
}

/** 进程级会话密钥（生产环境缺配置会在这里直接抛错，见 auth/index.ts） */
const SESSION_SECRET = sessionSecret({
  secret: config.sessionSecret,
  isProduction: config.env === 'production',
});

/**
 * 从请求解析当前账号。
 * 原来这里是 `currentUser()` —— 永远返回同一个 user-local，
 * 也就是任何人打开网址都是同一只宠物。现在改为按 token 解析。
 */
function currentUser(req: Ctx['req']): UserProfile {
  return authOf(req).account.profile;
}

function authOf(req: Ctx['req']): AuthContext {
  return resolveAuth(req, {
    repos,
    secret: SESSION_SECRET,
    mode: config.authMode,
    isProduction: config.env === 'production',
  });
}

function activePet(petId?: string | null, userId?: string): Pet | null {
  const pet = petId ? repos.getPet(petId) : repos.getActivePet(userId);
  if (!pet) return null;
  return refreshPetState(repos, pet);
}


/**
 * 每日成本硬闸门（审计 S5）。
 *
 * 速率限流防「瞬间打爆」，这里防「一整天慢慢刷」。
 * 超限时抛出 429，前端会看到明确提示而不是静默变慢。
 */
const QUOTA_LABEL: Record<string, string> = {
  chat: '对话',
  petCreate: '创建宠物',
  checkin: '打卡',
  tts: '语音',
  capsule: '时光胶囊复原',
};

function enforceDailyQuota(kind: keyof typeof DEFAULT_DAILY_LIMITS, userId: string): void {
  const verdict = dailyQuota.consume(userId, kind);
  if (!verdict.allowed) {
    const label = QUOTA_LABEL[kind] ?? kind;
    throw Object.assign(new Error('DAILY_QUOTA_EXCEEDED'), {
      status: 429,
      detail: `今天的${label}次数用完了（上限 ${verdict.limit} 次/天）。明天自动重置。`,
      quota: { kind, used: verdict.used, limit: verdict.limit },
    });
  }
}

/**
 * 取宠物并校验归属。
 *
 * 修复前的版本只检查「宠物存在」，不检查「是不是你的」——
 * 任何人拿到别人的 petId 都能读写。现在必须传入当前 userId。
 */
function requirePet(petId: string | null | undefined, userId: string): Pet {
  assertPetOwned(repos, userId, petId);
  const pet = activePet(petId);
  if (!pet) {
    const error = new Error('PET_NOT_FOUND') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return pet;
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */
/**
 * 会调用「按次计费」外部能力的接口，单独限流（审计 S5）。
 *
 * 这些接口每被调用一次就产生真实成本：
 *   /api/chat            → 大模型对话
 *   /api/pet             → 3D 生成（一次几元量级）
 *   /api/travel/checkin  → 图像合成
 *   /api/tts             → 语音合成
 *   /api/capsule         → 图生 3D（成本最高）
 */
const EXPENSIVE_ROUTES: Record<string, string> = {
  // 认证接口用更严的额度：15 分钟 10 次，防暴力破解与撞库
  'POST /api/auth/register': 'api:auth',
  'POST /api/auth/login': 'api:auth',
  'POST /api/auth/password': 'api:auth',
  'POST /api/chat': 'api:chat',
  'POST /api/pet': 'api:pet:create',
  'POST /api/travel/checkin': 'api:checkin',
  'POST /api/tts': 'api:tts',
  'POST /api/capsule': 'api:capsule',
};

const router = new Router();

/* 路由注册（审计 M6：按业务域拆分） */
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCatalogRoutes } from './routes/catalog.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerCapsuleRoutes } from './routes/capsule.ts';
import { registerFosterRoutes } from './routes/foster.ts';
import { registerInteractRoutes } from './routes/interact.ts';
import { registerPetRoutes } from './routes/pet.ts';
import { registerProfileRoutes } from './routes/profile.ts';
import { registerShopRoutes } from './routes/shop.ts';
import { registerSurveyRoutes } from './routes/survey.ts';
import { registerTravelRoutes } from './routes/travel.ts';
import { registerUploadRoutes } from './routes/upload.ts';
import type { RouteServices } from './routes/services.ts';


/* ------------------------------------------------------------------ */
/* 认证（审计 B2）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 前端启动时的第一个请求：库里有没有账号、是否需要登录。
 * 有了它，前端才能在「首次部署 → 引导注册」与「老库 → 直接进应用」之间正确选择。
 */
/* ------------------------------------------------------------------ */
/* 依赖注入（审计 M6）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 组装路由依赖。
 *
 * 这里是「哪些服务被哪些域使用」的唯一可查之处：
 * 新增一个路由依赖就在这里加一行。
 */
function buildRouteServices(): RouteServices {
  return {
    // appContext（全局单例与请求级辅助）
    SESSION_SECRET, activePet, analytics, authOf, care, currentUser, enforceDailyQuota,
    imageRefPrefixes, migration, persistenceChoice, push, repos, requirePet,
    requireValidImageRef, storage, store, touchCounters,
    // 认证
    hashPassword, issueSession, newUserId, normalizeEmail, passwordIssues, verifyPassword, getLastLlmError,
    // 目录与资产
    AFFECTION_RULES, DAILY_AFFECTION_CAP, DESTINATIONS, PREFERENCE_QUESTIONS, SCENE_PRESETS,
    SHOP_ITEMS, SPECIES_CATALOG, SUBSCRIPTION_PLANS, VOICE_PRESETS,
    renderPetSvg, safePalette, safeSpecies, activeTtsProvider, activeLlmProvider,
    integrationReport, decodeImage, buildKey, parseMultipart, MultipartError, parseBoundary,
    // 画像与人格
    inferProfile, suggestNames, buildPersonalityCard, buildQuirks, speciesById, INSTANT_POOL,
    // 宠物与成长
    createPetFromAnswers, INCUBATING_LINES, shopFor, redeem, refreshPetState, nowIso,
    advanceStreak, applyGain, canPerform, moodBubble, reactionFor, todayUsage,
    // 对话与记忆
    conversationHistory, ensureConversation, openingMessage, sendMessage, capacityFor, rememberEvent,
    // 旅行与内容
    badgesFor, destinationById, ensureWishlist, performCheckin, storyProgress,
    generateJournal, generatePostcard,
    // 计费
    billingState, checkSpend, checkPetSlot, PET_SLOTS, TIER_SPEND_CAP, MINOR_MONTHLY_HARD_CAP,
    // 关怀与推送
    SUPPORT_RESOURCES, generationDonePushText, longingPushText,
    // 启动校验
    formatIssues, hasFatal, validateConfig,
    // 归属校验
    assertPetOwned, assertConversationOwned, assertCapsuleOwned,
    // 校验工具
    validate,
  };
}

const routeServices: RouteServices = buildRouteServices();

/* 路由定义已迁移到 src/routes/（审计 M6） */

/* 服务器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 创建 HTTP 服务器（不 listen）。
 *
 * 抽成工厂是为了让测试能在随机端口起一个真实实例，
 * 从而用真 HTTP 请求验证越权、限流、安全头这类只能在传输层验证的行为。
 */
export function createApp() {
  registerAuthRoutes(router, routeServices);
  registerCatalogRoutes(router, routeServices);
  registerUploadRoutes(router, routeServices);
  registerSurveyRoutes(router, routeServices);
  registerPetRoutes(router, routeServices);
  registerInteractRoutes(router, routeServices);
  registerShopRoutes(router, routeServices);
  registerChatRoutes(router, routeServices);
  registerTravelRoutes(router, routeServices);
  registerCapsuleRoutes(router, routeServices);
  registerFosterRoutes(router, routeServices);
  registerProfileRoutes(router, routeServices);
  return createServer(handleRequest);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 安全响应头：所有响应都带（审计 S4）
  applyBaseHeaders(res);
  // 严格 CORS：不匹配白名单就不设 ACAO（审计 S2）
  const cors = applyCors(res, req.headers.origin, config.corsOrigins, req.method);
  if (cors.preflightHandled) return;

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const matched = router.match(req.method ?? 'GET', url.pathname);

  if (!matched) {
    // 非 /api 的 GET/HEAD 请求交给前端静态资源（生产环境同源部署）
    if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api')) {
      // 前端页面单独一套 CSP：需要允许 data: 图片、字体 CDN、以及与后端通信
      res.setHeader('content-security-policy', contentSecurityPolicy(config.corsOrigins.filter((o) => o !== '*')));
      if (serveStatic(req, res, url.pathname)) return;
    }
    sendError(res, 404, 'NOT_FOUND', `未找到路由 ${req.method} ${url.pathname}`);
    return;
  }

  // ---- 限流（审计 S5）----
  // 分桶优先用路由声明的，其次查「昂贵接口」集中表，最后按读写自动归类。
  // 集中表的好处：不必为了传参数去改每个路由的签名，新增昂贵接口只要加一行。
  const bucket =
    matched.bucket ??
    EXPENSIVE_ROUTES[`${req.method} ${url.pathname}`] ??
    (req.method === 'GET' ? 'api:read' : 'api:write');
  const rule = ruleFor(bucket);
  const limiterKey = `${bucket}|${clientKey(req)}`;
  const verdict = rateLimitDisabled()
    ? { allowed: true, remaining: rule.max, retryAfterMs: 0, limit: rule.max }
    : rateLimitStore.hit(limiterKey, rule, Date.now());
  if (!verdict.allowed) {
    const retryAfterSec = Math.ceil(verdict.retryAfterMs / 1000);
    res.setHeader('retry-after', String(retryAfterSec));
    res.setHeader('x-ratelimit-limit', String(verdict.limit));
    res.setHeader('x-ratelimit-remaining', '0');
    sendError(res, 429, 'RATE_LIMITED', `请求太频繁了，请 ${retryAfterSec} 秒后再试。`);
    return;
  }
  res.setHeader('x-ratelimit-limit', String(verdict.limit));
  res.setHeader('x-ratelimit-remaining', String(verdict.remaining));

  try {
    let body: unknown = null;
    let rawBody: Buffer | null = null;
    // DELETE 也允许带 body：注销账号需要「确认串 + 密码」，
    // 放在 query 里会进访问日志与浏览器历史，不合适。
    if (req.method && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      if (multipartBoundary(req.headers['content-type'])) {
        // 手机拍照上传走 multipart：必须按字节读，转字符串会破坏图片
        rawBody = await readRawBody(req, 30 * 1024 * 1024);
      } else {
        body = await readJsonBody(req);
      }
    }
    const ctx: Ctx = {
      req,
      res,
      url,
      params: matched.params,
      query: url.searchParams,
      body,
      rawBody,
    };
    const result = await matched.handler(ctx);
    if (result !== null && !res.writableEnded) {
      // API 响应不需要任何外部来源
      if (!res.hasHeader('content-security-policy')) res.setHeader('content-security-policy', API_CSP);
      // handler 可以返回 { __status } 包裹来指定状态码（健康检查用 503 触发平台重启）
      const wrapped = result as { __status?: number; __body?: unknown };
      if (typeof wrapped.__status === 'number' && '__body' in wrapped) {
        sendJson(res, wrapped.__status, wrapped.__body);
      } else {
        sendJson(res, 200, result);
      }
    }
  } catch (error) {
    const err = error as Error & { status?: number; message: string };
    const status = err.status ?? 500;
    if (status >= 500) console.error('[ruatrip:error]', err);

    // 参数校验失败：把每个字段的问题都带上，前端可以逐个标红
    if (err instanceof ValidationError) {
      sendError(res, 400, 'VALIDATION_FAILED', err.issues.map((i) => i.message).join('；'), {
        issues: err.issues,
      });
      return;
    }

    // 其它业务错误把 detail 带上（如密码强度要求、限额原因）
    const detail = (err as Error & { detail?: unknown }).detail;
    const extra = detail !== undefined ? { detail } : {};
    sendError(res, status, err.message || 'INTERNAL_ERROR', humanizeError(err.message), extra);
  }
}

function humanizeError(code: string): string {
  const map: Record<string, string> = {
    PET_NOT_FOUND: '还没有宠物，先去完成问卷、孵化一只吧。',
    DESTINATION_NOT_FOUND: '没有这个目的地。',
    ITEM_NOT_FOUND: '没有这件兑换物。',
    NOT_ENOUGH_AFFECTION: '好感度不够。好感度只能靠相处获得，不能购买。',
    LIMIT_REACHED: '今天的次数用完了。',
    OUTFIT_LOCKED: '这件衣服还没有解锁。',
    SCENE_LOCKED: '这个场景还没有解锁。',
    PAYLOAD_TOO_LARGE: '上传内容太大了。',
    INVALID_JSON: '请求体不是合法 JSON。',
    VALIDATION_FAILED: '提交的内容有问题。',
    CAPSULE_NOT_FOUND: '没有这个时光胶囊项目。',
    DAILY_QUOTA_EXCEEDED: '今天的额度用完了，明天再来吧。这是为了保护服务不被人刷爆。',
    RATE_LIMITED: '请求太频繁了，歇一会儿再试。',
    NO_FILE: '没有收到图片，请重新选择一张。',
    INVALID_MULTIPART: '上传格式不正确，请重试。',
    INVALID_IMAGE: '这个文件不是可用的图片。',
    FORBIDDEN: '没有权限操作这个文件。',
    AUTH_REQUIRED: '需要先登录。',
    INVALID_SESSION: '登录状态无效，请重新登录。',
    SESSION_EXPIRED: '登录已过期，请重新登录。',
    SESSION_REVOKED: '密码已修改，请重新登录。',
    ACCOUNT_NOT_FOUND: '账号不存在。',
    INVALID_CREDENTIALS: '邮箱或密码不正确。',
    EMAIL_TAKEN: '这个邮箱已经注册过了。',
    WEAK_PASSWORD: '密码强度不够。',
    CONFIRM_REQUIRED: '请输入 DELETE 以确认注销。',
    PET_SLOT_LIMIT: '宠物位已满。订阅更高档位可以养更多宠物。',
    SPEND_LIMIT_EXCEEDED: '已达到消费限额。',
    MINOR_SINGLE_PURCHASE_LIMIT: '未成年人单笔消费受限，请由家长操作。',
    TIER_NOT_ALLOWED: '当前档位不包含这个内容。',
    TIER_DOWNGRADE_BLOCKED: '现有宠物数量超过目标档位上限，无法降级。',
    UNKNOWN_PLAN: '没有这个订阅档位。',
    PET_ID_REQUIRED: '缺少 petId。',
    CONVERSATION_NOT_FOUND: '没有这个会话。',
    CHECKIN_NOT_FOUND: '没有这条打卡记录。',
    JOB_NOT_FOUND: '没有这个生成任务。',
  };
  return map[code] ?? code;
}

/**
 * 启动前置：异步加载持久化数据。
 *
 * 文件驱动在构造期已同步加载，这一步是幂等的；
 * sqlite/postgres 必须等这一步完成才能接受请求，否则会读到空档。
 */
await store.init();

/** 是否作为主程序运行（被 import 时不自动 listen，便于测试） */
const isMainModule = (() => {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('index.ts') || entry.endsWith('index.js');
})();

const server = createApp();

/**
 * 优雅退出（审计 M3）。
 *
 * 为什么必须有：数据落盘是防抖 + 异步的，进程被 SIGTERM 直接杀掉会丢掉
 * 最后一次写入（用户刚做的互动就没了）。云平台滚动更新、容器缩容都会发 SIGTERM。
 *
 * 顺序：停止接受新连接 → 等待在途请求 → 落盘并关闭数据库连接 → 退出。
 * 加超时兜底：卡住也必须退出，否则平台会强杀（那才会丢数据）。
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n  收到 ${signal}，正在安全退出…`);
  const timeout = setTimeout(() => {
    console.error('  退出超时，强制结束（可能有未落盘的数据）');
    process.exit(1);
  }, 8000);
  timeout.unref();

  try {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 没有连接时 close 回调也会触发；已有连接会自然结束
    });
    await store.close();
    console.log('  数据已落盘，驱动已关闭。');
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    console.error('  退出过程中出错：', error);
    clearTimeout(timeout);
    process.exit(1);
  }
}

if (isMainModule) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  // 未捕获异常不要静默：记录后退出，让平台重启（带着完整日志）
  process.on('uncaughtException', (error) => {
    console.error('[ruatrip:fatal] 未捕获异常：', error);
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[ruatrip:fatal] 未处理的 Promise 拒绝：', reason);
  });
}

if (isMainModule) server.listen(config.port, () => {
  if (webDistAvailable()) console.log('     已托管前端构建产物：apps/web/dist');
  else console.log('     未发现前端构建产物（跑 npm run build 后可由本服务同源托管）');
  const report = integrationReport();
  const live = report.items.filter((i) => i.configured && !['mock', 'local-svg-composer', 'browser-web-speech', 'universal-skeleton'].includes(i.provider));
  console.log('');
  console.log('  🐾 RuaTrip（Rua途）v2.0 服务端已启动');
  console.log(`     http://localhost:${config.port}`);
  console.log(`     数据目录：${config.dataDir}`);
  console.log(`     持久化：${persistenceChoice.description}`);
  if (persistenceChoice.productionWarning) {
    console.log(`     ⚠️  ${persistenceChoice.productionWarning}`);
  }
  console.log(`     接入模式：${report.mode}（真实通道 ${live.length} 个）`);
  if (!live.length) {
    console.log('     提示：当前全部为 Mock 模式，功能完整。需要接入真实能力见 docs/API-INTEGRATION.md');
  }
  console.log('');
});

export { server, store, repos };
