/**
 * pet 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { SCENE_PRESETS } from '../../../../packages/shared/src/catalog.ts';
import type { Pet } from '../../../../packages/shared/src/index.ts';
import { generationDonePushText, longingPushText } from '../adapters/push.ts';
import { assertPetOwned } from '../http/auth.ts';
import { checkPetSlot } from '../services/billing.ts';
import { moodBubble, todayUsage } from '../services/growth.ts';
import { INCUBATING_LINES, createPetFromAnswers } from '../services/pet.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerPetRoutes(router: Router, svc: RouteServices): void {
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
  analytics.track('pet.create', auth.userId, {
    petIndex: repos.listPetsByOwner(auth.userId).length,
    slots: slot.limit,
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

  /**
   * 生成完成时发一次通知（F2）。
   * 用 meta 标记「已通知」避免前端多次轮询导致重复推送。
   */
  const done = job.stage === 'ready' || job.stage === 'fallback_used';
  const notifiedKey = `pushed:gen:${job.id}`;
  if (done && !repos.getMeta<boolean>(notifiedKey, false)) {
    repos.setMeta(notifiedKey, true);
    const degraded = job.stage === 'fallback_used';
    const text = generationDonePushText(pet.name, degraded);
    void push.send({
      userId: auth.userId,
      title: text.title,
      body: text.body,
      url: '/cabin',
      category: 'generation',
      tag: `gen-${job.id}`,
    });
    analytics.track(degraded ? 'pet.generation_fallback' : 'pet.generation_ready', auth.userId, {
      provider: job.provider,
      degraded,
    });
  }

  return { ok: true, data: { job, pet, incubatingLines: INCUBATING_LINES } };
});

/**
 * 通知列表（F2）。
 *
 * 未接真实推送通道时，这里就是用户唯一能看到提醒的地方，
 * 所以它不是「占位接口」而是本地通道的正经出口。
 */
  router.get('/api/notifications', (ctx) => {
  const auth = authOf(ctx.req);
  return {
    ok: true,
    data: {
      items: push.local.list(auth.userId, 20),
      channel: push.activeChannel,
      realChannelConfigured: push.realChannelConfigured,
      note: push.realChannelConfigured
        ? '已接入真实推送通道'
        : '当前为应用内通知（未接入 APNs/FCM/Web Push）。用户离开应用后收不到提醒，见 docs/API-INTEGRATION.md 第 9 节。',
    },
  };
});

/**
 * 主动检查是否需要召回提醒（F2 + 3.1-2）。
 *
 * 由前端在打开应用时调用一次：如果想念值低到该提醒，就发一条通知。
 * 设计成「打开时检查」而不是「定时推送」，是为了在未接推送通道时也能工作。
 */
  router.post('/api/notifications/longing-check', async (ctx) => {
  const auth = authOf(ctx.req);
  const pet = activePet(undefined, auth.userId);
  if (!pet) return { ok: true, data: { sent: false, reason: 'no-pet' } };

  const hourKey = `pushed:longing:${pet.id}:${new Date().toISOString().slice(0, 13)}`;
  if (repos.getMeta<boolean>(hourKey, false)) {
    return { ok: true, data: { sent: false, reason: 'already-sent-this-hour' } };
  }
  if (pet.longing >= 60) {
    return { ok: true, data: { sent: false, reason: 'longing-ok', longing: pet.longing } };
  }

  repos.setMeta(hourKey, true);
  const text = longingPushText(pet.name, pet.longing);
  const result = await push.send({
    userId: auth.userId,
    title: text.title,
    body: text.body,
    url: '/cabin',
    category: 'longing',
    tag: `longing-${pet.id}`,
  });
  analytics.track('care.rest_prompt', auth.userId, { longing: pet.longing });
  return { ok: true, data: { sent: result.delivered, longing: pet.longing, channel: result.channel } };
});

/**
 * 埋点汇总（F3）。仅供部署者自查与调参，需要登录。
 * 这正是说明书 2.5 风险 3 要的「用数据验证好感度曲线」的最小闭环。
 */
  router.get('/api/analytics/summary', (ctx) => {
  authOf(ctx.req);
  return {
    ok: true,
    data: {
      ...analytics.local.summary(),
      realSinkConfigured: analytics.realSinkConfigured,
      privacyNote:
        '只统计行为事件计数与时序，不包含对话内容、照片、宠物名或邮箱。' +
        'PROPS 键受白名单限制（见 adapters/analytics.ts）。',
    },
  };
});

/** 导出埋点原始事件，便于本地分析或迁到真实分析服务 */
  router.get('/api/analytics/export', (ctx) => {
  authOf(ctx.req);
  return { ok: true, data: analytics.local.export() };
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
}
