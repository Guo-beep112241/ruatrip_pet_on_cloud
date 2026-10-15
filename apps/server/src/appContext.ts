/**
 * 应用上下文（审计 M6）。
 *
 * 从 index.ts 抽出：所有「跨路由共享」的实例与辅助函数集中在这里，
 * 这样路由模块只依赖一个入口，依赖关系是单向的（routes → appContext → adapters/services）。
 *
 * 为什么不做成类或依赖注入容器：本项目只有一个进程、一份全局状态，
 * 引入 DI 只会增加阅读成本。等真的需要多实例（例如测试并行隔离）时再重构。
 */
import { config, hasObjectStorage } from './config.ts';
import { getStore } from './db/store.ts';
import { createPersistenceDriver } from './db/drivers.ts';
import { Repositories } from './repositories/index.ts';
import { Analytics, RemoteAnalyticsSink } from './adapters/analytics.ts';
import { PushService, WebPushProvider } from './adapters/push.ts';
import { CareTracker } from './services/care.ts';
import { createStorage, validateImageRef } from './storage/index.ts';
import { DEFAULT_DAILY_LIMITS, dailyQuota } from './http/rateLimit.ts';
import { resolveAuth, sessionSecret, assertPetOwned, type AuthContext } from './http/auth.ts';
import { refreshPetState } from './services/growth.ts';
import type { Ctx } from './http/router.ts';
import type { Pet, UserProfile } from '../../../packages/shared/src/index.ts';

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
export {
  persistenceChoice,
  store,
  repos,
  analytics,
  push,
  care,
  touchCounters,
  storage,
  imageRefPrefixes,
  requireValidImageRef,
  migration,
  SESSION_SECRET,
  currentUser,
  authOf,
  activePet,
  QUOTA_LABEL,
  enforceDailyQuota,
  requirePet,
};
