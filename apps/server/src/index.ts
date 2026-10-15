/**
 * RuaTrip（Rua途）v2.0 服务端入口
 *
 * 设计目标：
 *   - 零外部依赖即可启动（只用 Node 内置模块 + tsx 做 TS 运行）
 *   - 所有外部 AI / 3D / 语音能力都通过 adapters 抽象，未配置时回落 Mock
 *   - /api/integration 明确列出「需要介入 API 的地方」
 */
import { createServer } from 'node:http';
import { config } from './config.ts';
import { getStore } from './db/store.ts';
import { createPersistenceDriver } from './db/drivers.ts';
import { Repositories } from './repositories/index.ts';
import { readJsonBody, readRawBody, Router, sendError, sendJson, type Ctx } from './http/router.ts';
import { serveStatic, webDistAvailable } from './http/static.ts';
import { API_CSP, applyBaseHeaders, applyCors, contentSecurityPolicy } from './http/security.ts';
import { DEFAULT_DAILY_LIMITS, clientKey, dailyQuota, rateLimitStore, ruleFor } from './http/rateLimit.ts';
import { MultipartError, parseBoundary, parseMultipart } from './http/multipart.ts';
import { hasObjectStorage } from './config.ts';
import { buildKey, createStorage, decodeImage, validateImageRef } from './storage/index.ts';
import { integrationReport } from './adapters/registry.ts';
import {
  DESTINATIONS,
  PREFERENCE_QUESTIONS,
  SCENE_PRESETS,
  SHOP_ITEMS,
  SPECIES_CATALOG,
  SUBSCRIPTION_PLANS,
} from '../../../packages/shared/src/catalog.ts';
import { AFFECTION_RULES, DAILY_AFFECTION_CAP } from '../../../packages/shared/src/rules.ts';
import type { Pet, UserProfile } from '../../../packages/shared/src/index.ts';
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
function currentUser(): UserProfile {
  const existing = repos.getUser();
  if (existing) return existing;
  const created: UserProfile = {
    id: 'user-local',
    nickname: '毛绒屋主人',
    avatarEmoji: '🧸',
    tier: 'free',
    petSlots: 1,
    streakDays: 1,
    claimedMilestones: [],
    minorGuardEnabled: true,
    monthlySpendLimit: 200,
    createdAt: nowIso(),
  };
  repos.saveUser(created);
  return created;
}

function activePet(petId?: string | null): Pet | null {
  const pet = petId ? repos.getPet(petId) : repos.getActivePet();
  if (!pet) return null;
  return refreshPetState(repos, pet);
}


/**
 * 每日成本硬闸门（审计 S5）。
 *
 * 速率限流防「瞬间打爆」，这里防「一整天慢慢刷」。
 * 超限时抛出 429，前端会看到明确提示而不是静默变慢。
 */
function enforceDailyQuota(kind: keyof typeof DEFAULT_DAILY_LIMITS, userId: string): void {
  const verdict = dailyQuota.consume(userId, kind);
  if (!verdict.allowed) {
    throw Object.assign(new Error('DAILY_QUOTA_EXCEEDED'), {
      status: 429,
      quota: { kind, used: verdict.used, limit: verdict.limit },
    });
  }
}

function requirePet(petId?: string | null): Pet {
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
  'POST /api/chat': 'api:chat',
  'POST /api/pet': 'api:pet:create',
  'POST /api/travel/checkin': 'api:checkin',
  'POST /api/tts': 'api:tts',
  'POST /api/capsule': 'api:capsule',
};

const router = new Router();

/* -------- 引导与基础数据 -------- */
router.get('/api/health', () => ({ ok: true, data: { status: 'up', time: nowIso(), env: config.env } }));

router.get('/api/bootstrap', () => {
  const user = currentUser();
  const pet = activePet();
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
  const user = currentUser();
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
  const user = currentUser();
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
  const body = (ctx.body ?? {}) as { answers?: Record<string, string[]> };
  const answers = body.answers ?? {};
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
  const user = currentUser();
  enforceDailyQuota('petCreate', user.id);
  const body = (ctx.body ?? {}) as { answers?: Record<string, string[]>; name?: string; callName?: string };
  const answers = body.answers ?? repos.getAnswers() ?? {};
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
  const pet = requirePet(ctx.query.get('petId'));
  const petId = pet.id;
  return { ok: true, data: { pet, todayGain: todayUsage(repos, petId).totalGain } };
});

router.patch('/api/pet', (ctx) => {
  const body = (ctx.body ?? {}) as { petId?: string; name?: string; callName?: string; outfitId?: string | null; sceneId?: string };
  const pet = requirePet(body.petId);
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
  const job = repos.getJob(ctx.params.jobId!);
  if (!job) throw Object.assign(new Error('JOB_NOT_FOUND'), { status: 404 });
  const pet = requirePet(job.petId);
  return { ok: true, data: { job, pet, incubatingLines: INCUBATING_LINES } };
});

router.get('/api/pet/mood', (ctx) => {
  const pet = requirePet(ctx.query.get('petId'));
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
  const body = (ctx.body ?? {}) as { petId?: string; action?: 'feed' | 'bathe' | 'play'; toyId?: string };
  const action = body.action ?? 'feed';
  let pet = requirePet(body.petId);

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
  const body = (ctx.body ?? {}) as { petId?: string; part?: 'head' | 'chin' | 'tail'; gesture?: 'tap' | 'long' | 'double' };
  const pet = requirePet(body.petId);
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
  const pet = requirePet(ctx.query.get('petId'));
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
  const pet = requirePet(ctx.query.get('petId'));
  return { ok: true, data: shopFor(repos, pet) };
});

router.post('/api/shop/redeem', (ctx) => {
  const body = (ctx.body ?? {}) as { petId?: string; itemId?: string };
  const pet = requirePet(body.petId);
  const result = redeem(repos, pet, body.itemId ?? '');
  return { ok: true, data: result };
});

/* -------- 真心话小屋 -------- */
router.get('/api/chat', (ctx) => {
  const pet = requirePet(ctx.query.get('petId'));
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
  const body = (ctx.body ?? {}) as {
    petId?: string; conversationId?: string; text?: string; layer?: string; viaVoice?: boolean;
  };
  const pet = requirePet(body.petId);
  enforceDailyQuota('chat', pet.ownerId);
  const result = await sendMessage(repos, pet, {
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    text: (body.text ?? '').slice(0, 500),
    layer: (body.layer as never) ?? 'auto',
    viaVoice: Boolean(body.viaVoice),
  });
  return { ok: true, data: result };
});

router.get('/api/chat/memories', (ctx) => {
  const pet = requirePet(ctx.query.get('petId'));
  const user = currentUser();
  return {
    ok: true,
    data: { memories: repos.listMemories(pet.id), capacity: capacityFor(user.tier) },
  };
});

router.post('/api/tts', async (ctx) => {
  const body = (ctx.body ?? {}) as { petId?: string; text?: string };
  const pet = requirePet(body.petId);
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
  const pet = requirePet(ctx.query.get('petId'));
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
  const body = (ctx.body ?? {}) as {
    petId?: string; destinationId?: string; photoUrl?: string | null; lat?: number; lng?: number; note?: string;
  };
  const pet = requirePet(body.petId);
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
  const pet = requirePet(ctx.query.get('petId'));
  return { ok: true, data: { entries: repos.listJournals(pet.id).slice().reverse() } };
});

router.post('/api/journal', (ctx) => {
  const body = (ctx.body ?? {}) as {
    petId?: string; checkinId?: string; template?: string; destinationName?: string; extraNote?: string;
  };
  const pet = requirePet(body.petId);
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
  const body = (ctx.body ?? {}) as { petId?: string; checkinId?: string; to?: string; template?: string };
  const pet = requirePet(body.petId);
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

router.get('/api/capsule', () => {
  const user = currentUser();
  return { ok: true, data: { projects: repos.listCapsules(user.id) } };
});

router.post('/api/capsule', (ctx) => {
  const user = currentUser();
  enforceDailyQuota('capsule', user.id);
  const body = (ctx.body ?? {}) as { photoUrl?: string; petName?: string; letterTo?: string };
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
  const pet = requirePet(ctx.query.get('petId'));
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
  const body = (ctx.body ?? {}) as { petId?: string; friendName?: string; days?: number };
  const pet = requirePet(body.petId);
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
router.get('/api/profile', () => {
  const user = currentUser();
  const pet = activePet();
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
    },
  };
});

router.patch('/api/profile', (ctx) => {
  const body = (ctx.body ?? {}) as Partial<UserProfile>;
  const next = repos.patchUser({
    ...(body.nickname ? { nickname: body.nickname } : {}),
    ...(body.avatarEmoji ? { avatarEmoji: body.avatarEmoji } : {}),
    ...(body.minorGuardEnabled !== undefined ? { minorGuardEnabled: body.minorGuardEnabled } : {}),
    ...(body.monthlySpendLimit !== undefined ? { monthlySpendLimit: body.monthlySpendLimit } : {}),
  });
  return { ok: true, data: { user: next } };
});

router.post('/api/subscribe', (ctx) => {
  const body = (ctx.body ?? {}) as { tier?: 'free' | 'plus' | 'pro'; cycle?: 'monthly' | 'yearly' };
  const tier = body.tier ?? 'free';
  const cycle = body.cycle ?? 'monthly';
  const plan = SUBSCRIPTION_PLANS.find((p) => p.tier === tier) ?? SUBSCRIPTION_PLANS[0]!;
  const slots: Record<string, number> = { free: 1, plus: 3, pro: 6 };
  const user = repos.patchUser({ tier, petSlots: slots[tier] ?? 1 });
  return {
    ok: true,
    data: {
      user,
      plan: { tier, name: plan.name, price: cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly },
      // 未接入支付通道，明确告知是模拟开通
      simulated: true,
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
const server = createServer(async (req, res) => {
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
  const verdict = rateLimitStore.hit(limiterKey, rule, Date.now());
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
    if (req.method && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
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
      sendJson(res, 200, result);
    }
  } catch (error) {
    const err = error as Error & { status?: number; message: string };
    const status = err.status ?? 500;
    if (status >= 500) console.error('[ruatrip:error]', err);
    sendError(res, status, err.message || 'INTERNAL_ERROR', humanizeError(err.message));
  }
});

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
    CAPSULE_NOT_FOUND: '没有这个时光胶囊项目。',
    DAILY_QUOTA_EXCEEDED: '今天的额度用完了，明天再来吧。这是为了保护服务不被人刷爆。',
    RATE_LIMITED: '请求太频繁了，歇一会儿再试。',
    NO_FILE: '没有收到图片，请重新选择一张。',
    INVALID_MULTIPART: '上传格式不正确，请重试。',
    INVALID_IMAGE: '这个文件不是可用的图片。',
    FORBIDDEN: '没有权限操作这个文件。',
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

server.listen(config.port, () => {
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
