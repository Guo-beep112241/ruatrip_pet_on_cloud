/**
 * 好感度规则与成长曲线（说明书 6.1）
 * 单项规则集中在这里，服务端按此计算，前端按此展示。
 */
import {
  DAILY_AFFECTION_CAP,
  STREAK_MILESTONES,
  type AffectionRule,
} from './index.ts';

export const AFFECTION_RULES: Record<AffectionRule['action'], AffectionRule> = {
  feed: {
    action: 'feed', label: '每日喂饭', gain: 8, dailyLimit: 2, decayAfterLimit: 0.4,
    description: '基础日常，最稳定的好感度来源', emoji: '🍚',
  },
  bathe: {
    action: 'bathe', label: '洗澡清洁', gain: 12, dailyLimit: 1, decayAfterLimit: 0.4,
    description: '洗完有「香香的」蓬松动画', emoji: '🫧',
  },
  play: {
    action: 'play', label: '陪玩互动', gain: 15, dailyLimit: 3, decayAfterLimit: 0.4,
    description: '每种玩具单独计数，避免一次刷满', emoji: '🎾',
  },
  chat: {
    action: 'chat', label: '真心话对话', gain: 4, dailyLimit: 8, decayAfterLimit: 0.3,
    description: '鼓励对话，而不是刷量', emoji: '💬',
  },
  checkin: {
    action: 'checkin', label: '旅行打卡', gain: 30, dailyLimit: 3, decayAfterLimit: 0.5,
    description: '把线下行为连接进关系', emoji: '📍',
  },
  streak: {
    action: 'streak', label: '连续陪伴', gain: 0, dailyLimit: 1, decayAfterLimit: 1,
    description: '第 3、7、14、30 天有额外奖励与专属动画', emoji: '🔥',
  },
  reunion: {
    action: 'reunion', label: '重逢补偿', gain: 20, dailyLimit: 1, decayAfterLimit: 1,
    description: '久别回来后的重逢动画与补偿', emoji: '🥺',
  },
};

/** 好感度 → 等级：每级所需经验递增，避免前期膨胀 */
export function levelThreshold(level: number): number {
  return Math.round(60 * Math.pow(level, 1.35));
}

export function levelFromAffection(affection: number): {
  level: number;
  levelProgress: number;
  currentLevelFloor: number;
  nextLevelAt: number;
} {
  let level = 1;
  let floor = 0;
  while (level < 60) {
    const need = levelThreshold(level);
    if (affection < floor + need) break;
    floor += need;
    level += 1;
  }
  const need = levelThreshold(level);
  const into = affection - floor;
  return {
    level,
    levelProgress: Math.max(0, Math.min(1, into / need)),
    currentLevelFloor: floor,
    nextLevelAt: floor + need,
  };
}

/** 单次收益（含超限衰减，防刷，说明书 6.1） */
export function computeGain(
  action: AffectionRule['action'],
  usedToday: number,
  remainingDailyCap: number,
): { gain: number; cappedGain: number } {
  const rule = AFFECTION_RULES[action];
  if (action === 'streak') return { gain: 0, cappedGain: 0 };

  const over = Math.max(0, usedToday - rule.dailyLimit);
  const multiplier = over === 0 ? 1 : Math.pow(rule.decayAfterLimit, over);
  let gain = Math.max(1, Math.round(rule.gain * multiplier));

  const cappedGain = Math.max(0, gain - remainingDailyCap);
  gain = Math.min(gain, Math.max(0, remainingDailyCap));
  return { gain, cappedGain };
}

/** 连续陪伴里程碑（说明书 6.1） */
export function streakRewardFor(day: number): { gain: number; reward: string } | null {
  const hit = STREAK_MILESTONES.find((m) => m.day === day);
  return hit ? { gain: hit.gain, reward: hit.reward } : null;
}

export { DAILY_AFFECTION_CAP, STREAK_MILESTONES };

/** 想念值曲线：多久没来 → 想念值（说明书 3.1-2） */
export function longingFromIdle(hoursIdle: number): number {
  if (hoursIdle <= 18) return 100;
  const days = hoursIdle / 24;
  const decay = Math.min(60, (days - 0.75) * 14);
  return Math.max(15, Math.round(100 - decay));
}

/** 情绪推导：由状态 + 想念值推出当前情绪 */
export function deriveMood(input: {
  hoursSinceFeed: number;
  hoursSinceBathe: number;
  hoursSincePlay: number;
  longing: number;
  hourOfDay: number;
}): 'happy' | 'sleepy' | 'hungry' | 'dirty' | 'playful' | 'lonely' | 'proud' | 'shy' {
  if (input.longing < 45) return 'lonely';
  if (input.hoursSinceFeed > 10) return 'hungry';
  if (input.hoursSinceBathe > 48) return 'dirty';
  if (input.hoursSincePlay > 20) return 'playful';
  if (input.hourOfDay >= 23 || input.hourOfDay < 7) return 'sleepy';
  return 'happy';
}
