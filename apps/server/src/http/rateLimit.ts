/**
 * 限流与成本闸门（审计 S5）。
 *
 * 为什么必须有：`/api/chat` 每次都调用大模型，`/api/pet` 与 `/api/travel/checkin`
 * 会触发 3D 生成与图像合成——这些都是**按次计费**的外部调用。
 * 公开上线后只要有一个人写脚本狂刷，额度就会瞬间归零。
 *
 * 本实现是**滑动窗口计数**，零依赖、单实例内有效。
 * 多实例部署时把 LocalRateLimitStore 换成 Redis 实现即可（接口已抽象）。
 */

export interface RateLimitRule {
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 窗口内允许的最大请求数 */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 剩余可用次数 */
  remaining: number;
  /** 距离窗口滑出的毫秒数，用于 Retry-After */
  retryAfterMs: number;
  limit: number;
}

export interface RateLimitStore {
  hit(key: string, rule: RateLimitRule, now: number): RateLimitResult;
  /** 仅用于测试与运维观测 */
  reset(key?: string): void;
}

/**
 * 进程内滑动窗口。
 *
 * 只记录每次请求的时间戳，窗口外的时间戳在读取时丢弃。
 * 为了避免恶意请求把内存撑爆，单个 key 最多保留 max 个时间戳
 * （超过 max 的请求本来就会被拒绝，不需要再记录）。
 */
export class LocalRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  hit(key: string, rule: RateLimitRule, now: number): RateLimitResult {
    this.sweepIfNeeded(now, rule.windowMs);

    const windowStart = now - rule.windowMs;
    const existing = this.hits.get(key) ?? [];
    const fresh = existing.filter((t) => t > windowStart);

    if (fresh.length >= rule.max) {
      const oldest = fresh[0] ?? now;
      this.hits.set(key, fresh);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + rule.windowMs - now),
        limit: rule.max,
      };
    }

    fresh.push(now);
    this.hits.set(key, fresh);
    return {
      allowed: true,
      remaining: Math.max(0, rule.max - fresh.length),
      retryAfterMs: 0,
      limit: rule.max,
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  /** 定期清理过期条目，防止长期运行内存增长 */
  private sweepIfNeeded(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    const cutoff = now - windowMs;
    for (const [key, times] of this.hits) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}

/**
 * 各接口的限流规则。
 *
 * 分档依据是「一次请求的外部成本」：
 *  - 免费/纯本地计算  → 放宽，避免误伤正常用户
 *  - 会调用按次计费的模型或生成服务 → 收紧
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  // 纯本地读取，只防异常刷量
  'api:read': { windowMs: 60_000, max: 300 },
  // 会造成写盘的操作
  'api:write': { windowMs: 60_000, max: 120 },
  // 调用大模型：对话
  'api:chat': { windowMs: 60_000, max: 20 },
  // 调用 3D 生成：创建宠物
  'api:pet:create': { windowMs: 60 * 60_000, max: 5 },
  // 调用图像合成：打卡
  'api:checkin': { windowMs: 60_000, max: 10 },
  // 调用 TTS
  'api:tts': { windowMs: 60_000, max: 40 },
  // 时光胶囊复原（图生 3D，成本最高）
  'api:capsule': { windowMs: 60 * 60_000, max: 3 },
  // 认证接口：防暴力破解
  'api:auth': { windowMs: 15 * 60_000, max: 10 },
};

export function ruleFor(bucket: keyof typeof RATE_LIMITS | string): RateLimitRule {
  return RATE_LIMITS[bucket] ?? RATE_LIMITS['api:read']!;
}

/** 从请求里取客户端标识：优先登录用户，其次 IP */
export function clientKey(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
}, userId?: string | null): string {
  if (userId) return `u:${userId}`;
  const fwd = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(fwd) ? fwd[0] : fwd;
  const ip = forwarded?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

/**
 * 每日成本硬闸门。
 *
 * 与速率限流互补：速率限流防「瞬间打爆」，日闸门防「一整天慢慢刷」。
 * 按用户统计会调用外部付费能力的次数。
 */
export class DailyQuota {
  private readonly usage = new Map<string, { day: string; counts: Record<string, number> }>();

  private readonly limits: Record<string, number>;

  constructor(limits: Record<string, number>) {
    this.limits = limits;
  }

  /** 返回 false 表示今日额度已用尽 */
  consume(userId: string, kind: string, now = new Date()): { allowed: boolean; used: number; limit: number } {
    const day = now.toISOString().slice(0, 10);
    const limit = this.limits[kind] ?? Number.POSITIVE_INFINITY;
    const entry = this.usage.get(userId);
    const record = entry && entry.day === day ? entry : { day, counts: {} as Record<string, number> };
    const used = record.counts[kind] ?? 0;

    if (used >= limit) {
      this.usage.set(userId, record);
      return { allowed: false, used, limit };
    }
    record.counts[kind] = used + 1;
    this.usage.set(userId, record);
    return { allowed: true, used: used + 1, limit };
  }

  peek(userId: string, kind: string, now = new Date()): { used: number; limit: number } {
    const day = now.toISOString().slice(0, 10);
    const entry = this.usage.get(userId);
    const used = entry && entry.day === day ? (entry.counts[kind] ?? 0) : 0;
    return { used, limit: this.limits[kind] ?? Number.POSITIVE_INFINITY };
  }

  reset(): void {
    this.usage.clear();
  }
}

/** 每日额度默认值：免费档的硬闸门，防止单个账号刷爆成本 */
export const DEFAULT_DAILY_LIMITS: Record<string, number> = {
  chat: 100,
  petCreate: 2,
  checkin: 20,
  tts: 200,
  capsule: 3,
};

export const rateLimitStore: RateLimitStore = new LocalRateLimitStore();
export const dailyQuota = new DailyQuota(DEFAULT_DAILY_LIMITS);
