/**
 * 好感度与成长引擎（说明书 6.1）
 *
 * 设计要点：
 *   - 好感度只能通过相处获得，任何接口都不提供「购买好感度」的通道；
 *   - 单日收益设上限，超出衰减；
 *   - 长时间不登录 → 想念值下降 → 回来触发「重逢」动画与补偿。
 */
import type {
  AffectionAction,
  AffectionLogEntry,
  Pet,
  PetMood,
} from '../../../../packages/shared/src/index.ts';
import {
  AFFECTION_RULES,
  DAILY_AFFECTION_CAP,
  computeGain,
  deriveMood,
  levelFromAffection,
  longingFromIdle,
  streakRewardFor,
} from '../../../../packages/shared/src/rules.ts';
import { MOOD_COPY } from '../../../../packages/shared/src/catalog.ts';
import type { Repositories } from '../repositories/index.ts';

export const nowIso = (): string => new Date().toISOString();
export const dayKey = (date = new Date()): string => date.toISOString().slice(0, 10);
export const hoursSince = (iso: string | null | undefined): number => {
  if (!iso) return 999;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 3_600_000);
};

export interface TodayUsage {
  totalGain: number;
  remainingCap: number;
  byAction: Record<string, { used: number; limit: number; remaining: number }>;
}

/** 统计当日已用次数与好感度（防刷基础数据） */
export function todayUsage(repos: Repositories, petId: string): TodayUsage {
  const since = `${dayKey()}T00:00:00.000Z`;
  const logs = repos.interactionsSince(petId, since);
  const totalGain = logs.reduce((sum, l) => sum + l.gain, 0);

  const byAction: TodayUsage['byAction'] = {};
  for (const [action, rule] of Object.entries(AFFECTION_RULES)) {
    const used = logs.filter((l) => l.action === action).length;
    byAction[action] = {
      used,
      limit: rule.dailyLimit,
      // 一律返回真实「剩余次数」，不用哨兵值，避免前端显示成天文数字
      remaining: Math.max(0, rule.dailyLimit - used),
    };
  }
  // 陪玩按「每种玩具单独计数」，这里的 used/remaining 是该动作的当日总量口径
  return { totalGain, remainingCap: Math.max(0, DAILY_AFFECTION_CAP - totalGain), byAction };
}

/** 检查某个动作当前是否还能加好感度 */
export function canPerform(
  repos: Repositories,
  petId: string,
  action: Exclude<AffectionAction, 'streak' | 'reunion'>,
): { allowed: boolean; reason?: string; used: number; limit: number } {
  const rule = AFFECTION_RULES[action];
  const usage = todayUsage(repos, petId);
  const used = usage.byAction[action]?.used ?? 0;
  if (action === 'chat') {
    // 对话是核心体验，到达上限只是不加好感度，不能阻止对话
    return { allowed: true, used, limit: rule.dailyLimit };
  }
  if (used >= rule.dailyLimit) {
    return {
      allowed: false,
      reason: `${rule.label}今天的次数用完了（${rule.dailyLimit} 次）。想继续可以用好感度兑换「额外互动次数」。`,
      used,
      limit: rule.dailyLimit,
    };
  }
  return { allowed: true, used, limit: rule.dailyLimit };
}

/** 结算一次好感度：写日志 + 更新宠物数值 + 返回实际收益 */
export function applyGain(
  repos: Repositories,
  pet: Pet,
  action: AffectionAction,
  note?: string,
): { pet: Pet; gain: number; cappedGain: number; log: AffectionLogEntry; levelUp: boolean } {
  const usage = todayUsage(repos, pet.id);
  const { gain, cappedGain } = computeGain(action, usage.byAction[action]?.used ?? 0, usage.remainingCap);

  const beforeLevel = levelFromAffection(pet.affection).level;
  const nextAffection = pet.affection + gain;
  const growth = levelFromAffection(nextAffection);

  const nextPet: Pet = {
    ...pet,
    affection: nextAffection,
    level: growth.level,
    levelProgress: growth.levelProgress,
    lastInteractionAt: nowIso(),
    lastVisitAt: nowIso(),
  };

  const log: AffectionLogEntry = {
    id: `aff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    petId: pet.id,
    action,
    gain,
    cappedGain,
    createdAt: nowIso(),
    note,
  };
  repos.addInteraction(log);
  repos.savePet(nextPet);

  return { pet: nextPet, gain, cappedGain, log, levelUp: growth.level > beforeLevel };
}

/** 宠物即时反馈文案（即时层，零延迟、零模型调用） */
export function reactionFor(action: AffectionAction, pet: Pet, seed = Math.random()): {
  text: string;
  emoji: string;
  animation: string;
  animationMs: number;
} {
  const pool: Record<string, { lines: string[]; emoji: string; animation: string; ms: number }> = {
    feed: { lines: ['（埋头吃）嗯……好吃。', '这个味道我记住了。下次还要这个。', '（舔舔嘴）今日份的幸福到账。'], emoji: '🍚', animation: 'eat-happy', ms: 1400 },
    bathe: { lines: ['……我不喜欢水。但洗完确实舒服。', '（甩毛）你看，我变得蓬松了。'], emoji: '🫧', animation: 'bath-fluffy', ms: 1600 },
    play: { lines: ['再来一次！那个球！', '（喘气）我赢了。你看清了吗，我赢了。'], emoji: '🎾', animation: 'play-pounce', ms: 1200 },
    chat: { lines: ['嗯……我在听。', '（点头）'], emoji: '💬', animation: 'talk-nod', ms: 900 },
    checkin: { lines: ['这里比照片好看。'], emoji: '📍', animation: 'reunion-run', ms: 1300 },
    streak: { lines: ['第几天了？我数着呢。'], emoji: '🔥', animation: 'mood-proud', ms: 1100 },
    reunion: { lines: ['……你终于来了。'], emoji: '🥺', animation: 'reunion-hug', ms: 1800 },
  };
  const entry = pool[action] ?? pool.chat!;
  const idx = Math.floor(seed * entry.lines.length) % entry.lines.length;
  return { text: entry.lines[idx] as string, emoji: entry.emoji, animation: entry.animation, animationMs: entry.ms };
}

/** 心情与想念值重算（每次读取宠物时调用） */
export function refreshPetState(repos: Repositories, pet: Pet): Pet {
  const hoursIdle = hoursSince(pet.lastVisitAt);
  const longing = longingFromIdle(hoursIdle);
  const mood: PetMood = deriveMood({
    hoursSinceFeed: hoursSince(repos.lastInteractionAt(pet.id, 'feed')),
    hoursSinceBathe: hoursSince(repos.lastInteractionAt(pet.id, 'bathe')),
    hoursSincePlay: hoursSince(repos.lastInteractionAt(pet.id, 'play')),
    longing,
    hourOfDay: new Date().getHours(),
  });
  const next: Pet = { ...pet, longing, mood };
  if (next.longing !== pet.longing || next.mood !== pet.mood) repos.savePet(next);
  return next;
}

/** 连续陪伴：按自然日推进，返回本日是否触发里程碑 */
export function advanceStreak(repos: Repositories, pet: Pet): {
  pet: Pet;
  streakDays: number;
  reward: { gain: number; reward: string } | null;
  reunion: boolean;
} {
  const lastKey = repos.getMeta<string>('lastActiveDay', '');
  const today = dayKey();
  if (lastKey === today) {
    return { pet, streakDays: repos.getMeta<number>('streakDays', 1), reward: null, reunion: false };
  }

  const yesterdayKey = dayKey(new Date(Date.now() - 86_400_000));
  const continues = lastKey === yesterdayKey;
  const streakDays = continues ? repos.getMeta<number>('streakDays', 1) + 1 : 1;
  repos.setMeta('lastActiveDay', today);
  repos.setMeta('streakDays', streakDays);
  repos.patchUser({ streakDays });

  const reward = streakRewardFor(streakDays);
  const reunion = !continues && lastKey !== '' && hoursSince(`${lastKey}T12:00:00.000Z`) > 48;

  let nextPet = pet;
  if (reward) {
    const applied = applyGain(repos, pet, 'streak', `连续陪伴第 ${streakDays} 天：${reward.reward}`);
    // 里程碑额外奖励直接叠加（不受当日上限限制，属于设计内的例外）
    nextPet = {
      ...applied.pet,
      affection: applied.pet.affection + reward.gain,
      ...levelFromAffection(applied.pet.affection + reward.gain),
    };
    repos.savePet(nextPet);
  }
  if (reunion) {
    const applied = applyGain(repos, nextPet, 'reunion', '久别重逢补偿');
    nextPet = applied.pet;
  }
  return { pet: nextPet, streakDays, reward, reunion };
}

export function moodBubble(mood: PetMood): string {
  return MOOD_COPY[mood]?.lines[0] ?? '（看着你）';
}

export { AFFECTION_RULES, DAILY_AFFECTION_CAP };
