/**
 * interact 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { AFFECTION_RULES, DAILY_AFFECTION_CAP } from '../../../../packages/shared/src/rules.ts';
import { SUPPORT_RESOURCES } from '../services/care.ts';
import { advanceStreak, applyGain, canPerform, reactionFor, todayUsage } from '../services/growth.ts';
import { INSTANT_POOL } from '../services/persona.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerInteractRoutes(router: Router, svc: RouteServices): void {
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

  // 埋点（F3）：只记行为与时序，不记内容
  analytics.track(`interact.${action}` as never, auth.userId, {
    gain: applied.gain,
    capped: applied.cappedGain,
    level: applied.pet.level,
    affection: applied.pet.affection,
  });
  if (applied.cappedGain > 0) {
    analytics.track('affection.capped', auth.userId, { capped: applied.cappedGain });
  }
  if (applied.levelUp) {
    analytics.track('affection.levelup', auth.userId, { level: applied.pet.level });
  }
  if (streak.reward) {
    analytics.track('streak.milestone', auth.userId, { count: streak.streakDays ?? 0 });
  }

  /**
   * 情绪关怀（F4）：每次互动都是观察点。
   *
   * actionCount 必须是「今日总活动量」而不是「单个动作的次数」——
   * 用后者的话，即便用户连点 200 次摸头也永远到不了阈值
   * （每次只 +1 到各自的计数器）。这里取今日全部互动日志的条数。
   */
  const careDecision = care.observe({
    userId: auth.userId,
    actionCount: usage.totalInteractions,
    griefMentions: repos.getMeta<number>(`grief:${auth.userId}`, 0),
  });

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
      /** 情绪关怀提示（F4）；不需要时是 null，前端不显示任何东西 */
      care: careDecision.shouldPrompt
        ? {
            signal: careDecision.signal,
            message: careDecision.message,
            supportResources: careDecision.showSupportResources ? SUPPORT_RESOURCES : [],
          }
        : null,
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

  /**
   * 抚摸是最容易被连点的入口，所以它也要计入关怀观察（F4）。
   * 抚摸本身不加好感度，但「一直点」正是高强度使用的信号。
   */
  touchCounters.set(body.petId!, (touchCounters.get(body.petId!) ?? 0) + 1);
  const careDecision = care.observe({
    userId: auth.userId,
    actionCount: touchCounters.get(body.petId!) ?? 0,
    griefMentions: repos.getMeta<number>(`grief:${auth.userId}`, 0),
  });

  return {
    ok: true,
    data: {
      pet,
      reaction: line,
      animation,
      animationMs: body.gesture === 'long' ? 1600 : 900,
      affectionDelta: 0,
      care: careDecision.shouldPrompt
        ? {
            signal: careDecision.signal,
            message: careDecision.message,
            supportResources: careDecision.showSupportResources ? SUPPORT_RESOURCES : [],
          }
        : null,
    },
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
}
