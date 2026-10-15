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
import { MultipartError, parseBoundary, parseMultipart } from './http/multipart.ts';
import { validate, ValidationError, type Schema } from './http/validate.ts';
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
import { activeLlmProvider } from './adapters/chat.ts';
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

/* ------------------------------------------------------------------ */
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

/**
 * 所有写接口的入参规则集中在这里。
 *
 * 好处：一眼能看全「哪些字段会被接受」，新增字段必须显式声明；
 * 未声明的字段会被丢弃 —— 这一点挡住了「客户端顺手塞 tier/ownerId 做权限提升」。
 */
const SCHEMAS = {
  survey: {
    answers: { type: 'stringArray', label: '问卷答案', maxItems: 12, maxLength: 64 },
  },
  createPet: {
    name: { type: 'string', label: '名字', min: 1, max: 12, required: true },
    callName: { type: 'string', label: '昵称', max: 12 },
  },
  patchPet: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    name: { type: 'string', label: '名字', min: 1, max: 12 },
    callName: { type: 'string', label: '昵称', max: 12 },
    outfitId: { type: 'nullableString', label: '服饰', max: 64 },
    sceneId: { type: 'string', label: '场景', max: 64 },
  },
  interact: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    action: { type: 'enum', values: ['feed', 'bathe', 'play'] as const, label: '互动类型', required: true },
    toyId: { type: 'string', label: '玩具', max: 32 },
  },
  touchPet: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    part: { type: 'enum', values: ['head', 'chin', 'tail'] as const, label: '部位' },
    gesture: { type: 'enum', values: ['tap', 'long', 'double'] as const, label: '手势' },
  },
  redeem: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    itemId: { type: 'string', label: '兑换物', max: 64, required: true },
  },
  chat: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    conversationId: { type: 'string', label: '会话', max: 64 },
    text: { type: 'string', label: '内容', min: 1, max: 500, required: true },
    layer: { type: 'enum', values: ['auto', 'instant', 'scene', 'free', 'memory'] as const, label: '分层' },
    viaVoice: { type: 'boolean', label: '语音输入' },
  },
  tts: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    text: { type: 'string', label: '文本', min: 1, max: 300, required: true },
  },
  checkin: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    destinationId: { type: 'string', label: '目的地', max: 48, required: true },
    photoUrl: { type: 'imageRef', label: '照片' },
    lat: { type: 'number', label: '纬度', min: -90, max: 90 },
    lng: { type: 'number', label: '经度', min: -180, max: 180 },
    note: { type: 'string', label: '备注', max: 200 },
  },
  journal: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    checkinId: { type: 'string', label: '打卡记录', max: 64 },
    template: { type: 'enum', values: ['warm-paper', 'polaroid', 'magazine', 'minimal'] as const, label: '模板' },
    destinationName: { type: 'string', label: '目的地', max: 48 },
    extraNote: { type: 'string', label: '补充', max: 300 },
  },
  postcard: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    checkinId: { type: 'string', label: '打卡记录', max: 64 },
    to: { type: 'string', label: '收件人', max: 32 },
    template: { type: 'enum', values: ['postcard-classic', 'instagram-grid', 'wechat-moments'] as const, label: '模板' },
  },
  capsule: {
    photoUrl: { type: 'imageRef', label: '旧照', required: true },
    petName: { type: 'string', label: '名字', min: 1, max: 24, required: true },
    letterTo: { type: 'string', label: '想说的话', max: 400 },
  },
  foster: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    friendName: { type: 'string', label: '好友昵称', max: 24, required: true },
    days: { type: 'number', label: '天数', min: 1, max: 14, integer: true },
  },
  patchProfile: {
    nickname: { type: 'string', label: '昵称', min: 1, max: 24 },
    avatarEmoji: { type: 'string', label: '头像', max: 8 },
    minorGuardEnabled: { type: 'boolean', label: '未成年人保护' },
    monthlySpendLimit: { type: 'number', label: '月消费上限', min: 0, max: 5000 },
  },
  subscribe: {
    tier: { type: 'enum', values: ['free', 'plus', 'pro'] as const, label: '档位' },
    cycle: { type: 'enum', values: ['monthly', 'yearly'] as const, label: '周期' },
  },
  register: {
    email: { type: 'string', label: '邮箱', min: 5, max: 254, required: true },
    password: { type: 'string', label: '密码', min: 1, max: 200, required: true },
    nickname: { type: 'string', label: '昵称', max: 24 },
  },
  login: {
    email: { type: 'string', label: '邮箱', min: 1, max: 254, required: true },
    password: { type: 'string', label: '密码', min: 1, max: 200, required: true },
  },
  changePassword: {
    currentPassword: { type: 'string', label: '当前密码', max: 200 },
    newPassword: { type: 'string', label: '新密码', min: 1, max: 200, required: true },
  },
  deleteAccount: {
    password: { type: 'string', label: '密码', max: 200 },
    confirm: { type: 'string', label: '确认串', required: true, max: 16 },
  },
  petIdQuery: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
  },
} satisfies Record<string, Schema>;

/** 校验入口：统一抛出带 issues 的 400 */
function check<S extends Schema>(input: unknown, schema: S): ReturnType<typeof validate<S>> {
  return validate(input, schema);
}

/* -------- 引导与基础数据 -------- */
/**
 * 健康检查（审计 M5）。
 *
 * 旧版只回 `{status:'up'}`，即使数据源或对象存储已经坏掉也报健康，
 * 平台不会重启、告警也不会响。
 *
 * 现在真实探测依赖，并且区分两种语义：
 *   - status: 'ok'       —— 全部正常
 *   - status: 'degraded' —— 核心可用但依赖异常（仍返回 200，避免被平台误杀）
 *   - status: 'error'    —— 核心不可用（返回 503，让平台重启或摘流量）
 */
router.get('/api/health', async () => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. 持久化：能否正常读写
  try {
    const ok = await persistenceChoice.driver.healthy();
    checks.persistence = {
      ok,
      detail: `${persistenceChoice.description}${ok ? '' : '（不可用）'}`,
    };
  } catch (error) {
    checks.persistence = { ok: false, detail: String(error).slice(0, 120) };
  }

  // 2. 最近一次落盘是否失败
  const writeError = store.writeError;
  checks.lastWrite = writeError
    ? { ok: false, detail: writeError.message.slice(0, 120) }
    : { ok: true };

  // 3. 对象存储
  try {
    const ok = await storage.healthy();
    checks.storage = { ok, detail: `${storage.driver} 驱动${ok ? '' : '（不可用）'}` };
  } catch (error) {
    checks.storage = { ok: false, detail: String(error).slice(0, 120) };
  }

  // 4. 大模型通道（只报是否配置，不实际调用 —— 健康检查不该花钱）
  const llmProvider = activeLlmProvider();
  checks.llm = {
    ok: true,
    detail: llmProvider.meta.id === 'mock' ? 'Mock 模式（未配 key）' : `已接入 ${llmProvider.meta.id}`,
  };

  const persistenceOk = checks.persistence?.ok !== false;
  const storageOk = checks.storage?.ok !== false;
  const writeOk = checks.lastWrite?.ok !== false;
  const status = !persistenceOk || !writeOk ? 'error' : storageOk ? 'ok' : 'degraded';

  const body = {
    ok: true,
    data: {
      status,
      time: nowIso(),
      env: config.env,
      uptimeSec: Math.round(process.uptime()),
      driver: store.driverKind,
      /** 数据规模，用于发现异常膨胀（例如图片又被塞进 JSON） */
      dataBytes: store.sizeBytes(),
      checks,
    },
  };

  // 核心不可用时返回 503：平台会据此重启或摘掉流量
  return status === 'error' ? { __status: 503, __body: body } : body;
});

router.get('/api/bootstrap', (ctx) => {
  const auth = authOf(ctx.req);
  const user = auth.account.profile;
  const pet = activePet(undefined, auth.userId);
  const steps = [
    { step: 'survey', done: Boolean(repos.getAnswers()) },
    { step: 'generate-pet', done: Boolean(pet) },
    { step: 'first-feed', done: Boolean(repos.lastInteractionAt(pet?.id ?? '', 'feed')) },
    { step: 'first-chat', done: Boolean(pet && repos.listConversations(pet.id).length) },
    { step: 'first-checkin', done: Boolean(pet && repos.listCheckins(pet.id).length) },
    { step: 'first-journal', done: Boolean(pet && repos.listJournals(pet.id).length) },
  ];
  return {
    ok: true,
    data: {
      user,
      pet,
      integration: integrationReport().items,
      scenes: SCENE_PRESETS,
      onboarding: steps,
    },
  };
});

router.get('/api/integration', () => ({ ok: true, data: integrationReport() }));

router.get('/api/catalog', () => ({
  ok: true,
  data: {
    species: SPECIES_CATALOG,
    questions: PREFERENCE_QUESTIONS,
    destinations: DESTINATIONS,
    shop: SHOP_ITEMS,
    plans: SUBSCRIPTION_PLANS,
    scenes: SCENE_PRESETS,
    affectionRules: AFFECTION_RULES,
    dailyCap: DAILY_AFFECTION_CAP,
    voicePresets: VOICE_PRESETS,
  },
}));

/**
 * 本地降级宠物形象：Mock 模式下的形象母版，也是低端机降级通道。
 *
 * 安全：species / palette 一律走白名单（safeSpecies / safePalette），
 * name 在渲染函数内部转义并截断长度。响应额外加 CSP，即使有人找到
 * 绕过路径也没法执行脚本。
 */
router.get('/api/asset/pet.svg', (ctx) => {
  const species = safeSpecies(ctx.query.get('species'));
  const palette = safePalette((ctx.query.get('palette') ?? '').split(',').filter(Boolean));
  const name = ctx.query.get('name') ?? '宠物';
  const svg = renderPetSvg({ species, palette, name });
  ctx.res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=86400',
    // SVG 是唯一能「承载脚本的图片格式」，所以单独给它上锁
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'x-content-type-options': 'nosniff',
  });
  ctx.res.end(svg);
  return null;
});

/* ------------------------------------------------------------------ */
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

/* -------- 偏好问卷 -------- */
router.get('/api/survey', () => ({
  ok: true,
  data: { questions: PREFERENCE_QUESTIONS, savedAnswers: repos.getAnswers() },
}));

router.post('/api/survey', (ctx) => {
  const body = check(ctx.body, SCHEMAS.survey);
  // 问卷答案是多维度的对象（{species:[...]}），这里只做顶层校验，
  // 维度合法性由 services/inference.ts 的白名单保证。
  const answers = (ctx.body as { answers?: Record<string, string[]> })?.answers ?? {};
  repos.saveAnswers(answers);
  const inference = inferProfile(answers);
  const species = speciesById(inference.vector.species);
  const card = buildPersonalityCard(species.id, inference.vector);
  return {
    ok: true,
    data: {
      inference,
      suggestedNames: suggestNames(species.id),
      suggestedQuirks: buildQuirks(species.id, inference.vector),
      petDraft: {
        species: species.id,
        speciesEmoji: species.emoji,
        personalityPreview: {
          traits: card.traits,
          speechRhythm: card.speechRhythm,
          catchphrases: card.catchphrases,
        },
        palette: inference.vector.palette,
        fur: inference.vector.fur,
        bodySize: inference.vector.bodySize,
      },
    },
  };
});

/* -------- 宠物生成与展示 -------- */
router.post('/api/pet', (ctx) => {
  const auth = authOf(ctx.req);
  const user = auth.account.profile;

  /**
   * 校验顺序很重要：先看「档位够不够」再看「今天次数用完没」。
   * 反过来的话，免费档用户会先看到「今天次数用完」（明天还会成功），
   * 而真正的原因是「需要订阅」——会误导用户。
   */
  const slot = checkPetSlot({
    tier: user.tier,
    current: repos.listPetsByOwner(user.id).length,
    recordedSlots: user.petSlots,
  });
  if (!slot.allowed) {
    throw Object.assign(new Error('PET_SLOT_LIMIT'), { status: 403, detail: slot.message });
  }
  enforceDailyQuota('petCreate', user.id);
  const body = check(ctx.body, SCHEMAS.createPet);
  const rawAnswers = (ctx.body as { answers?: Record<string, string[]> })?.answers;
  const answers = rawAnswers ?? repos.getAnswers() ?? {};
  const { pet, job } = createPetFromAnswers(repos, {
    answers,
    name: body.name ?? '小家伙',
    ...(body.callName ? { callName: body.callName } : {}),
    userId: user.id,
    tier: user.tier,
  });
  return { ok: true, data: { pet, job } };
});

router.get('/api/pet', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const petId = pet.id;
  return { ok: true, data: { pet, todayGain: todayUsage(repos, petId).totalGain } };
});

router.patch('/api/pet', (ctx) => {
  const body = check(ctx.body, SCHEMAS.patchPet);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  const next: Pet = {
    ...pet,
    name: body.name?.trim() || pet.name,
    callName: body.callName?.trim() || pet.callName,
  };
  if (body.outfitId !== undefined) {
    if (body.outfitId && !next.unlockedOutfits.includes(body.outfitId)) throw Object.assign(new Error('OUTFIT_LOCKED'), { status: 400 });
    next.equippedOutfit = body.outfitId;
  }
  if (body.sceneId) {
    if (!next.unlockedScenes.includes(body.sceneId) && !SCENE_PRESETS.some((s) => s.id === body.sceneId && s.id === 'home-warm')) {
      throw Object.assign(new Error('SCENE_LOCKED'), { status: 400 });
    }
    next.activeScene = body.sceneId;
  }
  repos.savePet(next);
  return { ok: true, data: { pet: next } };
});

router.get('/api/pet/generation/:jobId', (ctx) => {
  const auth = authOf(ctx.req);
  const job = repos.getJob(ctx.params.jobId!);
  if (!job) throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 });
  // 归属校验：jobId 是全局唯一的，不校验就能看到别人的生成进度
  assertPetOwned(repos, auth.userId, job.petId);
  const pet = requirePet(job.petId, auth.userId);
  return { ok: true, data: { job, pet, incubatingLines: INCUBATING_LINES } };
});

router.get('/api/pet/mood', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const outfits = [...pet.unlockedOutfits];
  return {
    ok: true,
    data: {
      petId: pet.id,
      mood: pet.mood,
      bubble: moodBubble(pet.mood),
      available: [
        { id: 'feed', label: '喂饭', emoji: '🍚', locked: false },
        { id: 'bathe', label: '洗澡', emoji: '🫧', locked: false },
        { id: 'play', label: '陪玩', emoji: '🎾', locked: false },
        { id: 'chat', label: '真心话', emoji: '💬', locked: false },
        { id: 'wardrobe', label: '衣橱', emoji: '🧣', locked: false },
        { id: 'scene', label: '场景', emoji: '🖼️', locked: false },
        { id: 'photo', label: '合影', emoji: '📸', locked: false },
        { id: 'capsule', label: '时光胶囊', emoji: '🕯️', locked: false, reason: outfits.length ? undefined : '从这里安静地进入' },
      ],
    },
  };
});

/* -------- 互动（好感度核心循环） -------- */
router.post('/api/interact', (ctx) => {
  const body = check(ctx.body, SCHEMAS.interact);
  const action = body.action;
  const auth = authOf(ctx.req);
  let pet = requirePet(body.petId, auth.userId);

  // 每次进入都先推进连续陪伴与想念值
  const streak = advanceStreak(repos, pet);
  pet = streak.pet;

  const gate = canPerform(repos, pet.id, action);
  if (!gate.allowed) throw Object.assign(new Error('LIMIT_REACHED'), { status: 429, message: gate.reason });

  const applied = applyGain(repos, pet, action, body.toyId ? `陪玩：${body.toyId}` : undefined);
  const reaction = reactionFor(action, applied.pet);
  const usage = todayUsage(repos, applied.pet.id);

  return {
    ok: true,
    data: {
      pet: applied.pet,
      gain: applied.gain,
      cappedGain: applied.cappedGain,
      reaction: reaction.text,
      reactionEmoji: reaction.emoji,
      animation: reaction.animation,
      animationMs: reaction.animationMs,
      remainingToday: usage.remainingCap,
      levelUp: applied.levelUp,
      streakReward: streak.reward,
      log: applied.log,
    },
  };
});

/** 抚摸部位：点击身体不同部位有不同反应（说明书 6.3 交互细节） */
router.post('/api/interact/pet', (ctx) => {
  const body = check(ctx.body, SCHEMAS.touchPet);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  const key =
    body.gesture === 'long' ? 'pet.long'
      : body.gesture === 'double' ? 'pet.double'
        : body.part === 'chin' ? 'pet.chin'
          : body.part === 'tail' ? 'pet.tail'
            : 'pet.head';
  const pool = INSTANT_POOL[key] ?? INSTANT_POOL['pet.head']!;
  const line = pool[Math.floor(Math.random() * pool.length)]!;
  const animation = body.gesture === 'double' ? 'mood-shy' : body.gesture === 'long' ? 'reunion-hug' : 'talk-tilt';
  return {
    ok: true,
    data: { pet, reaction: line, animation, animationMs: body.gesture === 'long' ? 1600 : 900, affectionDelta: 0 },
  };
});

router.get('/api/affection', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const usage = todayUsage(repos, pet.id);
  const streakDays = repos.getMeta<number>('streakDays', 1);
  const milestones = [3, 7, 14, 30];
  const next = milestones.find((d) => d > streakDays);
  return {
    ok: true,
    data: {
      pet,
      todayGain: usage.totalGain,
      dailyCap: DAILY_AFFECTION_CAP,
      remainingByAction: usage.byAction,
      recent: repos.listInteractions(pet.id, 30),
      nextStreakMilestone: next ? { day: next, reward: AFFECTION_RULES.streak.description, daysLeft: next - streakDays } : null,
    },
  };
});

/* -------- 商店（好感度兑换，禁止购买） -------- */
router.get('/api/shop', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  return { ok: true, data: shopFor(repos, pet) };
});

router.post('/api/shop/redeem', (ctx) => {
  const body = check(ctx.body, SCHEMAS.redeem);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  const result = redeem(repos, pet, body.itemId ?? '');
  return { ok: true, data: result };
});

/* -------- 真心话小屋 -------- */
router.get('/api/chat', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const { conversation, messages } = conversationHistory(repos, pet);
  if (!messages.length) {
    const opening = openingMessage(repos, pet, conversation.id);
    repos.addMessage(opening);
    return {
      ok: true,
      data: { conversation, messages: [opening], personality: pet.personality, memories: repos.listMemories(pet.id) },
    };
  }
  return {
    ok: true,
    data: { conversation, messages, personality: pet.personality, memories: repos.listMemories(pet.id) },
  };
});

router.post('/api/chat', async (ctx) => {
  // 先校验参数再查归属：否则「text 太长」会被报成「宠物不存在」，
  // 用户拿到的是误导性提示。
  const body = check(ctx.body, SCHEMAS.chat);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  enforceDailyQuota('chat', pet.ownerId);
  // 归属校验：否则可以往别人的会话里插消息
  if (body.conversationId) assertConversationOwned(repos, auth.userId, body.conversationId);
  const result = await sendMessage(repos, pet, {
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    text: (body.text ?? '').slice(0, 500),
    layer: (body.layer as never) ?? 'auto',
    viaVoice: Boolean(body.viaVoice),
  });
  return { ok: true, data: result };
});

router.get('/api/chat/memories', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const user = currentUser(ctx.req);
  return {
    ok: true,
    data: { memories: repos.listMemories(pet.id), capacity: capacityFor(user.tier) },
  };
});

router.post('/api/tts', async (ctx) => {
  const body = (ctx.body ?? {}) as { petId?: string; text?: string };
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  enforceDailyQuota('tts', pet.ownerId);
  const provider = activeTtsProvider();
  const result = await provider.synthesize({
    text: (body.text ?? '').slice(0, 300),
    voiceProfile: pet.personality.voiceProfile,
    emotion: pet.mood,
  });
  return { ok: true, data: result };
});

/* -------- 旅行模块 -------- */
router.get('/api/travel', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const wishlist = ensureWishlist(repos, pet);
  return {
    ok: true,
    data: {
      destinations: DESTINATIONS,
      wishlist,
      checkins: repos.listCheckins(pet.id),
      badges: badgesFor(repos, pet),
      journals: repos.listJournals(pet.id),
      postcards: repos.listPostcards(pet.id),
      storyProgress: storyProgress(repos, pet),
    },
  };
});

router.post('/api/travel/checkin', async (ctx) => {
  const body = check(ctx.body, SCHEMAS.checkin);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  enforceDailyQuota('checkin', pet.ownerId);
  if (!destinationById(body.destinationId ?? '')) throw Object.assign(new Error('DESTINATION_NOT_FOUND'), { status: 404 });
  const outcome = await performCheckin(repos, pet, {
    destinationId: body.destinationId!,
    photoUrl: requireValidImageRef(body.photoUrl, 'photoUrl') || null,
    ...(body.lat !== undefined ? { lat: body.lat } : {}),
    ...(body.lng !== undefined ? { lng: body.lng } : {}),
    ...(body.note ? { note: body.note } : {}),
  });
  return { ok: true, data: outcome };
});

router.get('/api/journal', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  return { ok: true, data: { entries: repos.listJournals(pet.id).slice().reverse() } };
});

router.post('/api/journal', (ctx) => {
  const body = check(ctx.body, SCHEMAS.journal);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  // 用「属于这只宠物」而不是全局 id 查找，天然完成归属校验
  const checkin = body.checkinId ? repos.listCheckins(pet.id).find((c) => c.id === body.checkinId) : null;
  const destination =
    (checkin ? destinationById(checkin.destinationId) : null) ??
    DESTINATIONS.find((d) => d.name === body.destinationName) ??
    DESTINATIONS[0]!;
  const entry = generateJournal({
    pet,
    destination,
    checkinId: checkin?.id ?? null,
    ...(body.template ? { template: body.template as never } : {}),
    ...(checkin?.composedPhotoUrl ? { composedPhotoUrl: checkin.composedPhotoUrl } : {}),
    ...(checkin?.revisitMemory ? { revisitMemory: checkin.revisitMemory } : {}),
    ...(body.extraNote ? { extraNote: body.extraNote } : {}),
  });
  repos.addJournal(entry);
  return { ok: true, data: { entry } };
});

router.post('/api/postcard', (ctx) => {
  const body = check(ctx.body, SCHEMAS.postcard);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  // 同上：限定在这只宠物的打卡记录里查找
  const checkin = body.checkinId ? repos.listCheckins(pet.id).find((c) => c.id === body.checkinId) : null;
  const destination = (checkin ? destinationById(checkin.destinationId) : null) ?? DESTINATIONS[0]!;
  const card = generatePostcard({
    pet,
    destination,
    checkinId: checkin?.id ?? null,
    ...(body.to ? { to: body.to } : {}),
    ...(body.template ? { template: body.template as never } : {}),
  });
  repos.addPostcard(card);
  return { ok: true, data: { postcard: card } };
});

/* -------- 时光胶囊（独立安静入口） -------- */
const CAPSULE_DISCLAIMER =
  '这里生成的是「基于照片的陪伴形象」，不是它本人。它会像它，但不会是它。慢慢来，不着急。';

router.get('/api/capsule', (ctx) => {
  const auth = authOf(ctx.req);
  return { ok: true, data: { projects: repos.listCapsules(auth.userId) } };
});

router.post('/api/capsule', (ctx) => {
  const user = currentUser(ctx.req);
  enforceDailyQuota('capsule', user.id);
  const body = check(ctx.body, SCHEMAS.capsule);
  const project = {
    id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: user.id,
    photoUrl: requireValidImageRef(body.photoUrl, 'photoUrl'),
    petName: body.petName?.trim() || '它',
    letterTo: body.letterTo ?? '',
    stage: 'uploaded' as const,
    progress: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repos.saveCapsule(project);
  // 异步推进：analyzing → restoring → done
  void advanceCapsule(project.id);
  return { ok: true, data: { project, disclaimer: CAPSULE_DISCLAIMER } };
});

router.get('/api/capsule/:id', (ctx) => {
  const auth = authOf(ctx.req);
  // 归属校验：否则拿到别人的 capsuleId 就能看到别人上传的旧照
  assertCapsuleOwned(repos, auth.userId, ctx.params.id!);
  const project = repos.getCapsule(ctx.params.id!);
  if (!project) throw Object.assign(new Error('CAPSULE_NOT_FOUND'), { status: 404 });
  return { ok: true, data: { project, disclaimer: CAPSULE_DISCLAIMER } };
});

async function advanceCapsule(id: string): Promise<void> {
  const stages: { stage: 'analyzing' | 'restoring' | 'done'; progress: number; delay: number }[] = [
    { stage: 'analyzing', progress: 30, delay: 900 },
    { stage: 'restoring', progress: 68, delay: 2200 },
    { stage: 'done', progress: 100, delay: 4200 },
  ];
  for (const s of stages) {
    await new Promise((r) => setTimeout(r, s.delay));
    const current = repos.getCapsule(id);
    if (!current) return;
    repos.saveCapsule({
      ...current,
      stage: s.stage,
      progress: s.progress,
      restoredImageUrl: s.stage === 'done'
        ? `/api/asset/pet.svg?species=ragdoll&palette=oat,chestnut&name=${encodeURIComponent(current.petName)}`
        : current.restoredImageUrl,
      updatedAt: nowIso(),
    });
  }
}

/* -------- 云代养 / 双宠同行（第三阶段：先把关系网络打通） -------- */
router.get('/api/foster', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const requests = repos.listFosters(pet.id);
  const completed = requests.find((r) => r.status === 'completed');
  return {
    ok: true,
    data: {
      requests,
      incomingLine: completed ? `${pet.name}回来了，它说：「你的朋友对我挺好的，但我还是想睡你的床。」` : null,
    },
  };
});

router.post('/api/foster', (ctx) => {
  const body = check(ctx.body, SCHEMAS.foster);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  const req = {
    id: `fos-${Date.now()}`,
    petId: pet.id,
    ownerId: pet.ownerId,
    friendName: body.friendName?.trim() || '好友',
    days: Math.max(1, Math.min(14, body.days ?? 3)),
    status: 'active' as const,
    friendInteractions: 0,
    createdAt: nowIso(),
  };
  repos.saveFoster(req);
  rememberEvent(repos, pet.id, `被${req.friendName}代养了 ${req.days} 天`, 6, ['foster']);
  return { ok: true, data: { request: req } };
});

/* -------- 我的 / 订阅 -------- */
router.get('/api/profile', (ctx) => {
  const auth = authOf(ctx.req);
  const user = auth.account.profile;
  const pet = activePet(undefined, auth.userId);
  const checkins = pet ? repos.listCheckins(pet.id) : [];
  const journals = pet ? repos.listJournals(pet.id) : [];
  const memories = pet ? repos.listMemories(pet.id) : [];
  return {
    ok: true,
    data: {
      user,
      pet,
      stats: {
        daysTogether: pet ? Math.max(1, Math.round((Date.now() - new Date(pet.createdAt).getTime()) / 86_400_000)) : 0,
        checkinCount: checkins.length,
        journalCount: journals.length,
        memoryCount: memories.length,
        affectionTotal: pet?.affection ?? 0,
        cityCount: new Set(checkins.map((c) => c.destinationId)).size,
      },
      integration: integrationReport().items,
      /** 计费状态（审计 F6）：前端据此展示剩余额度与限额说明 */
      billing: billingState({
        tier: user.tier,
        minorGuardEnabled: user.minorGuardEnabled,
        monthlySpendLimit: user.monthlySpendLimit,
        spentThisMonth: repos.spentThisMonth(auth.userId),
        petSlots: user.petSlots,
        petCount: repos.listPetsByOwner(auth.userId).length,
        paymentConfigured: Boolean(config.payment.providerKey),
      }),
      /** 各档位可花多少钱与能养几只，供前端展示而不是硬编码 */
      planLimits: { spendCap: TIER_SPEND_CAP, petSlots: PET_SLOTS, minorMonthlyHardCap: MINOR_MONTHLY_HARD_CAP },
    },
  };
});

router.patch('/api/profile', (ctx) => {
  const auth = authOf(ctx.req);
  const body = check(ctx.body, SCHEMAS.patchProfile);
  /**
   * 只允许改这些字段。
   * 白名单而不是展开整个 body：否则客户端可以自行把 tier 改成 pro、
   * 或把 petSlots 改成 99（权限提升）。
   */
  const next = repos.patchProfile(auth.userId, {
    ...(body.nickname ? { nickname: body.nickname } : {}),
    ...(body.avatarEmoji ? { avatarEmoji: body.avatarEmoji } : {}),
    ...(body.minorGuardEnabled !== undefined ? { minorGuardEnabled: body.minorGuardEnabled } : {}),
    ...(body.monthlySpendLimit !== undefined
      ? { monthlySpendLimit: Math.max(0, Math.min(5000, Number(body.monthlySpendLimit) || 0)) }
      : {}),
  });
  return { ok: true, data: { user: next } };
});

/**
 * 订阅（审计 F6 + 十一）。
 *
 * 三件事：
 *   1. **限额校验**：未成年人单笔/月上限、账号月消费上限
 *   2. **记账**：写入消费台账，供后续校验与对账
 *   3. **降级保护**：从高档位降到低档位时，如果已有宠物超过新配额，拒绝降级
 *      （否则用户会瞬间失去对已有宠物的访问）
 *
 * ⚠️ 仍未接入真实支付。未接入时 `simulated: true` 会透传给前端，
 * 且**不会**绕过限额校验 —— 这样以后接支付时逻辑不用改。
 */
router.post('/api/subscribe', (ctx) => {
  const auth = authOf(ctx.req);
  const body = check(ctx.body, SCHEMAS.subscribe);
  const tier: SubscriptionTier = body.tier ?? 'free';
  const cycle = body.cycle ?? 'monthly';

  const plan = SUBSCRIPTION_PLANS.find((p) => p.tier === tier);
  if (!plan) throw Object.assign(new Error('UNKNOWN_PLAN'), { status: 400 });

  const profile = auth.account.profile;
  const paymentsOn = Boolean(config.payment.providerKey);
  const amount = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;

  // 降级保护：不能降到装不下已有宠物的档位
  const ownedPets = repos.listPetsByOwner(auth.userId).length;
  const targetSlots = PET_SLOTS[tier] ?? 1;
  if (ownedPets > targetSlots) {
    throw Object.assign(new Error('TIER_DOWNGRADE_BLOCKED'), {
      status: 409,
      detail: `你已经有 ${ownedPets} 只宠物，${plan.name}档最多 ${targetSlots} 只。请先删除多余的宠物再降级。`,
    });
  }

  // 限额校验（免费档金额为 0，会直接通过）
  const spent = repos.spentThisMonth(auth.userId);
  const decision = checkSpend({
    userId: auth.userId,
    kind: 'subscription',
    sku: tier,
    // 订阅/升级必须放行（免费档也不例外），否则永远无法升级
    action: 'subscribe',
    amount,
    tier: profile.tier,
    minorGuardEnabled: profile.minorGuardEnabled,
    monthlySpendLimit: profile.monthlySpendLimit,
    spentThisMonth: spent,
  });
  if (!decision.allowed) {
    throw Object.assign(new Error(decision.code), { status: 403, detail: decision.message });
  }

  // 记账（即使金额为 0 也记一条，便于对账「何时开通了什么档位」）
  const entry: SpendEntry = {
    id: `spend-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: auth.userId,
    kind: 'subscription',
    sku: `${tier}:${cycle}`,
    amount,
    simulated: !paymentsOn,
    createdAt: nowIso(),
  };
  repos.addSpend(entry);

  const user = repos.patchProfile(auth.userId, { tier, petSlots: targetSlots });
  return {
    ok: true,
    data: {
      user,
      plan: { tier, name: plan.name, price: amount },
      // 未接入支付通道时明确告知是模拟开通，前端会显示提示
      simulated: !paymentsOn,
      /** 本次消费后本月的剩余额度 */
      remainingAfter: decision.allowed ? decision.remainingAfter : undefined,
      spendEntry: entry,
    },
  };
});

/** 判断请求是否为 multipart/form-data */
function multipartBoundary(contentType: string | string[] | undefined): string | null {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return parseBoundary(value);
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 创建 HTTP 服务器（不 listen）。
 *
 * 抽成工厂是为了让测试能在随机端口起一个真实实例，
 * 从而用真 HTTP 请求验证越权、限流、安全头这类只能在传输层验证的行为。
 */
export function createApp() {
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
