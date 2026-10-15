/**
 * 行为埋点抽象（审计 F3）。
 *
 * 说明书 2.5 风险 3 明确要求：「好感度的数值曲线与实际留存数据如何挂钩，
 * 需要首版埋点验证」。没有埋点，所有数值设计都只能靠猜。
 *
 * 隐私原则（这是产品价值观的一部分，不是可选项）：
 *   - 只采集**行为计数与时序**，不采集对话内容、不采集照片
 *   - 埋点里绝不出现宠物名字、用户昵称、邮箱
 *   - 本地实现把事件留在进程内（可导出为 JSON），不发往任何第三方
 *   - 接入真实分析服务时，同样只送这些白名单字段
 */

export type AnalyticsEventName =
  // 漏斗
  | 'auth.register'
  | 'survey.start'
  | 'survey.complete'
  | 'pet.create'
  | 'pet.generation_ready'
  | 'pet.generation_fallback'
  | 'onboarding.complete'
  // 核心循环
  | 'interact.feed'
  | 'interact.bathe'
  | 'interact.play'
  | 'interact.touch'
  | 'affection.capped'
  | 'affection.levelup'
  | 'streak.milestone'
  | 'reunion'
  // 对话
  | 'chat.send'
  | 'chat.instant_layer'
  | 'chat.free_layer'
  | 'chat.model_used'
  | 'chat.model_fallback'
  | 'chat.safety_blocked'
  | 'memory.created'
  // 旅行
  | 'travel.checkin'
  | 'travel.revisit'
  | 'journal.generate'
  | 'postcard.generate'
  | 'wishlist.unlock'
  // 商业化
  | 'shop.redeem'
  | 'spend.blocked'
  | 'subscribe.attempt'
  | 'subscribe.success'
  // 关怀与合规
  | 'care.rest_prompt'
  | 'care.support_resources'
  | 'capsule.create'
  | 'account.delete';

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  userId: string;
  /** 毫秒时间戳 */
  at: number;
  /** 白名单数值/枚举属性；不允许自由文本 */
  props?: Record<string, number | boolean | string>;
}

/** 允许出现在 props 里的键（白名单：防止有人顺手把对话内容塞进来） */
const ALLOWED_PROP_KEYS = new Set([
  'gain', 'capped', 'level', 'action', 'mood', 'longing', 'affection',
  'layer', 'modelUsed', 'blocked', 'category', 'destinationId', 'scene',
  'isRevisit', 'daysAgo', 'itemId', 'price', 'tier', 'amount', 'reason',
  'durationMs', 'count', 'slots', 'petIndex', 'template', 'cityCount',
  'memoryCount', 'degraded', 'provider', 'survivors',
]);

/** 过滤 props：只保留白名单键，值也限制在可序列化的原子类型 */
export function sanitizeProps(props: Record<string, unknown> | undefined): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (!ALLOWED_PROP_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value.length <= 40) out[key] = value;
    // 其它类型（对象/数组/函数）一律丢弃
  }
  return out;
}

export interface AnalyticsSummary {
  total: number;
  /** 各事件的计数 */
  counts: Record<string, number>;
  /** 按天分组的事件数，用于看留存趋势 */
  daily: Record<string, number>;
  /** 首次出现时间 */
  firstAt: number | null;
}

export class LocalAnalytics {
  private readonly events: AnalyticsEvent[] = [];
  private readonly maxKeep = 5000;

  track(event: AnalyticsEvent): void {
    this.events.push({ ...event, props: sanitizeProps(event.props) });
    if (this.events.length > this.maxKeep) {
      // 环形缓冲：只丢最旧的，保证长期运行不涨内存
      this.events.splice(0, this.events.length - this.maxKeep);
    }
  }

  list(limit = 200): AnalyticsEvent[] {
    return this.events.slice(-limit);
  }

  /** 汇总：这是说明书要的「数值曲线 vs 留存」的最小可用版本 */
  summary(userId?: string): AnalyticsSummary {
    const scoped = userId ? this.events.filter((e) => e.userId === userId) : this.events;
    const counts: Record<string, number> = {};
    const daily: Record<string, number> = {};
    for (const event of scoped) {
      counts[event.name] = (counts[event.name] ?? 0) + 1;
      const day = new Date(event.at).toISOString().slice(0, 10);
      daily[day] = (daily[day] ?? 0) + 1;
    }
    return {
      total: scoped.length,
      counts,
      daily,
      firstAt: scoped.length ? (scoped[0] as AnalyticsEvent).at : null,
    };
  }

  /** 导出为 JSON（便于本地分析或迁到真实分析服务） */
  export(): { exportedAt: string; count: number; events: AnalyticsEvent[] } {
    return { exportedAt: new Date().toISOString(), count: this.events.length, events: [...this.events] };
  }

  clear(): void {
    this.events.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface AnalyticsSink {
  readonly kind: 'local' | 'remote';
  track(event: AnalyticsEvent): void;
  flush(): Promise<void>;
}

/** 远端汇：把事件批量 POST 到真实分析服务 */
export class RemoteAnalyticsSink implements AnalyticsSink {
  readonly kind = 'remote' as const;
  private buffer: AnalyticsEvent[] = [];

  private readonly endpoint: string;
  private readonly writeKey: string;

  constructor(endpoint: string, writeKey: string) {
    this.endpoint = endpoint;
    this.writeKey = writeKey;
  }

  track(event: AnalyticsEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= 20) void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.writeKey}` },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      // 埋点失败绝不能影响主流程，也不重试（避免放大问题）
    }
  }
}

export class Analytics {
  readonly local = new LocalAnalytics();
  private readonly sink: AnalyticsSink | null;

  constructor(sink?: AnalyticsSink | null) {
    this.sink = sink ?? null;
  }

  get realSinkConfigured(): boolean {
    return this.sink !== null;
  }

  /**
   * 记录事件。**永远不抛异常** —— 埋点不该让用户的操作失败。
   * 本地始终记录一份（可导出），配了远端汇则额外上报。
   */
  track(name: AnalyticsEventName, userId: string, props?: Record<string, unknown>): void {
    try {
      const event: AnalyticsEvent = {
        name,
        userId,
        at: Date.now(),
        props: sanitizeProps(props),
      };
      this.local.track(event);
      this.sink?.track(event);
    } catch {
      /* 静默 */
    }
  }
}
