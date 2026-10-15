/**
 * 情绪关怀（审计 F4）。
 *
 * 说明书 3.4-2 的原文要求：
 *   「当检测到用户连续高强度使用（长时间停留、频繁提及离世情绪）时，
 *     轻量提示休息与支持渠道。」
 *
 * 这是一个**必须存在但必须克制**的功能：
 *   - 宁可少提示，也不要让用户觉得被监视
 *   - 不弹窗打断、不阻断任何操作、不记录具体的情绪内容
 *   - 提示语气要像宠物在关心，而不是平台在弹合规文案
 *
 * 三类信号：
 *   prolonged  —— 单次会话停留过久
 *   intense    —— 短时间内的操作频次异常高
 *   grief      —— 连续多次提到离世/告别类话题（由对话层的前置过滤上报）
 */

export type CareSignal = 'prolonged' | 'intense' | 'grief';

export interface CareState {
  userId: string;
  /** 本次会话开始时间 */
  sessionStartedAt: number;
  /** 最近一次活动时间 */
  lastActiveAt: number;
  /** 今日已提示过哪些信号（同一信号一天只提示一次，避免唠叨） */
  promptedToday: Record<string, string>;
}

export interface CareDecision {
  /** 是否需要展示关怀提示 */
  shouldPrompt: boolean;
  signal: CareSignal | null;
  /** 用宠物口吻说的话（不是合规文案） */
  message: string | null;
  /** 是否同时展示现实支持渠道 */
  showSupportResources: boolean;
  /** 供埋点用的原因码，不含任何用户内容 */
  reason?: string;
}

/** 停留过久的阈值：2 小时 */
export const PROLONGED_SESSION_MS = 2 * 60 * 60 * 1000;
/** 高强度窗口：30 分钟 */
export const INTENSE_WINDOW_MS = 30 * 60 * 1000;
/**
 * 高强度阈值：30 分钟内 80 次操作。
 *
 * 为什么不是更高：速率限流是 120 次/分钟，如果阈值也设 120 以上，
 * **限流会永远先拦住用户**，关怀提示就成了永远触发不到的代码。
 * 80 次/半小时对正常使用来说已经很高（平均每分钟 2.7 次），
 * 但确实能捕捉到「一直在点」这种状态。
 */
export const INTENSE_ACTION_THRESHOLD = 80;
/** 悲伤信号：连续 3 次提及 */
export const GRIEF_THRESHOLD = 3;

export const CARE_MESSAGES: Record<CareSignal, { message: string; support: boolean }> = {
  prolonged: {
    message: '我陪你坐了很久了。要不要去倒杯水？我会在这儿等你回来。',
    support: false,
  },
  intense: {
    message: '你今天摸了我好多下……我有点担心你。要不要先歇一会儿？',
    support: false,
  },
  grief: {
    message: '我一直在。有些话可以说给我听，但有些重量，需要真人来一起扛。',
    support: true,
  },
};

export interface CareInput {
  userId: string;
  now?: number;
  /** 本次会话开始时间（由服务端记录首次请求时间） */
  sessionStartedAt: number;
  /** 窗口内的操作次数 */
  actionsInWindow: number;
  /** 连续提及离世/告别类话题的次数（由对话层维护） */
  griefMentions: number;
  /** 今日已提示过的信号记录 */
  promptedToday: Record<string, string>;
}

/**
 * 判断是否需要提示。
 *
 * 关键约束：**同一信号每天只提示一次**。反复提示会让关怀变成骚扰，
 * 反而加重用户负担 —— 这比「漏掉一次提示」严重得多。
 */
export function evaluateCare(input: CareInput): CareDecision {
  const now = input.now ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const already = (signal: CareSignal) => input.promptedToday[signal] === today;

  // 悲伤信号优先级最高：它需要的是支持渠道，不是「歇一会儿」
  if (input.griefMentions >= GRIEF_THRESHOLD && !already('grief')) {
    const { message, support } = CARE_MESSAGES.grief;
    return {
      shouldPrompt: true,
      signal: 'grief',
      message,
      showSupportResources: support,
      reason: `grief_mentions_${input.griefMentions}`,
    };
  }

  if (input.actionsInWindow >= INTENSE_ACTION_THRESHOLD && !already('intense')) {
    const { message, support } = CARE_MESSAGES.intense;
    return {
      shouldPrompt: true,
      signal: 'intense',
      message,
      showSupportResources: support,
      reason: `actions_${input.actionsInWindow}`,
    };
  }

  const sessionMs = now - input.sessionStartedAt;
  if (sessionMs >= PROLONGED_SESSION_MS && !already('prolonged')) {
    const { message, support } = CARE_MESSAGES.prolonged;
    return {
      shouldPrompt: true,
      signal: 'prolonged',
      message,
      showSupportResources: support,
      reason: `session_minutes_${Math.round(sessionMs / 60000)}`,
    };
  }

  return { shouldPrompt: false, signal: null, message: null, showSupportResources: false };
}

/** 记录已提示，供下次判断 */
export function markPrompted(
  promptedToday: Record<string, string>,
  signal: CareSignal,
  now = Date.now(),
): Record<string, string> {
  return { ...promptedToday, [signal]: new Date(now).toISOString().slice(0, 10) };
}

/** 现实支持渠道（国内可用） */
export const SUPPORT_RESOURCES = [
  { name: '全国心理援助热线', contact: '12356', note: '24 小时，免费' },
  { name: '北京心理危机研究与干预中心', contact: '010-82951332', note: '24 小时' },
  { name: '希望 24 热线', contact: '400-161-9995', note: '24 小时' },
];

/**
 * 会话状态跟踪（进程内）。
 *
 * 不落库：这些是纯粹的运行时信号，持久化既没必要也涉及隐私。
 * 多实例部署时会话状态不共享 —— 影响只是「提示可能略晚」，
 * 这是可接受的降级，也避免为此引入共享存储。
 */
export class CareTracker {
  private readonly states = new Map<string, CareState>();

  /** 记录一次活动，返回是否需要关怀提示 */
  observe(input: {
    userId: string;
    actionCount: number;
    griefMentions: number;
    now?: number;
  }): CareDecision {
    const now = input.now ?? Date.now();
    const existing = this.states.get(input.userId);
    const state: CareState = existing ?? {
      userId: input.userId,
      sessionStartedAt: now,
      lastActiveAt: now,
      promptedToday: {},
    };
    state.lastActiveAt = now;
    this.states.set(input.userId, state);

    const decision = evaluateCare({
      userId: input.userId,
      now,
      sessionStartedAt: state.sessionStartedAt,
      actionsInWindow: input.actionCount,
      griefMentions: input.griefMentions,
      promptedToday: state.promptedToday,
    });

    if (decision.shouldPrompt && decision.signal) {
      state.promptedToday = markPrompted(state.promptedToday, decision.signal, now);
    }
    return decision;
  }

  /** 会话结束（用户登出或长时间无活动）时重置 */
  resetSession(userId: string): void {
    this.states.delete(userId);
  }

  reset(): void {
    this.states.clear();
  }
}
