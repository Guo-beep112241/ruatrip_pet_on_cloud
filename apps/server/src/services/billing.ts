/**
 * 消费限额与计费闸门（审计 F6）。
 *
 * 原状：`minorGuardEnabled` 与 `monthlySpendLimit` 只是存了字段，
 * **从来没有被任何地方读取校验**。同时宠物位上限也没校验 ——
 * 免费档 1 只宠物，但接口允许无限创建（配额形同虚设）。
 *
 * 本模块提供：
 *   1. 消费台账（谁、什么商品、多少钱、什么时候）
 *   2. 下单前的限额校验（未成年人保护 + 月消费上限）
 *   3. 宠物位配额校验
 *
 * 关于支付：真实扣款必须由外部支付通道完成（见 docs/API-INTEGRATION.md 第 7 节）。
 * 本模块只负责「能不能买」的判断与记账，不发起扣款。
 * 未接入支付时订阅走「模拟开通」，但仍受限额约束 —— 这样上线接支付时不用改逻辑。
 */

import type { SubscriptionTier } from '../../../../packages/shared/src/index.ts';

/** 消费记录 */
export interface SpendEntry {
  id: string;
  userId: string;
  /** 商品类型 */
  kind: 'subscription' | 'outfit' | 'scene' | 'prop' | 'capsule-restore';
  /** 商品标识，如 plus / outfit-scarf */
  sku: string;
  /** 金额（人民币元）。好感度兑换为 0，不占消费额度 */
  amount: number;
  /** 是否真实扣款（未接支付时为 true 表示「模拟」，需明确标注） */
  simulated: boolean;
  createdAt: string;
}

/** 各订阅档位每月可花的钱（元）。0 表示不允许付费消费 */
export const TIER_SPEND_CAP: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 60,
  pro: 200,
};

/** 未成年人单笔上限（元）：即使家长把月限额调很高，单笔也不放开 */
export const MINOR_SINGLE_PURCHASE_CAP = 50;

/** 未成年人月限额的硬上限（元）：防止把限额设成天文数字绕过保护 */
export const MINOR_MONTHLY_HARD_CAP = 500;

/** 宠物位配额 */
export const PET_SLOTS: Record<SubscriptionTier, number> = {
  free: 1,
  plus: 3,
  pro: 6,
};

export interface SpendCheckInput {
  userId: string;
  kind: SpendEntry['kind'];
  sku: string;
  /**
   * 意图：
   *   subscribe —— 订阅/升级档位。**免费档用户也必须允许**，否则永远无法升级。
   *   purchase  —— 在现有档位内买单品。免费档不允许。
   */
  action?: 'subscribe' | 'purchase';
  /** 本次金额 */
  amount: number;
  /** 账号当前档位 */
  tier: SubscriptionTier;
  /** 是否开启未成年人保护 */
  minorGuardEnabled: boolean;
  /** 用户设置的月限额 */
  monthlySpendLimit: number;
  /** 本月已消费金额 */
  spentThisMonth: number;
}

export type SpendDecision =
  | { allowed: true; remainingAfter: number }
  | {
      allowed: false;
      code: 'SPEND_LIMIT_EXCEEDED' | 'MINOR_SINGLE_PURCHASE_LIMIT' | 'TIER_NOT_ALLOWED';
      message: string;
      /** 距离限额还差多少 */
      remaining: number;
    };

/**
 * 判断本次消费是否允许。
 *
 * 校验顺序（从最严到最松，命中即拒）：
 *   1. 金额非法（负数/非有限数）→ 直接拒，避免用它绕过台账
 *   2. 未成年人单笔上限
 *   3. 月限额（未成年人的限额先被硬上限钳制）
 *   4. 档位本身是否允许付费（free 档不允许任何付费消费）
 */
export function checkSpend(input: SpendCheckInput): SpendDecision {
  const { amount } = input;

  // 好感度兑换走 amount = 0，不需要任何限额校验
  if (amount === 0) return { allowed: true, remainingAfter: 0 };

  if (!Number.isFinite(amount) || amount < 0) {
    return {
      allowed: false,
      code: 'SPEND_LIMIT_EXCEEDED',
      message: '金额不合法。',
      remaining: 0,
    };
  }

  // 未成年人的月限额先钳到硬上限，避免家长/用户把保护设成无效值
  const effectiveMonthly = input.minorGuardEnabled
    ? Math.max(0, Math.min(input.monthlySpendLimit, MINOR_MONTHLY_HARD_CAP))
    : Math.max(0, input.monthlySpendLimit);

  if (input.minorGuardEnabled && amount > MINOR_SINGLE_PURCHASE_CAP) {
    return {
      allowed: false,
      code: 'MINOR_SINGLE_PURCHASE_LIMIT',
      message: `未成年人单笔消费不能超过 ¥${MINOR_SINGLE_PURCHASE_CAP}。如需购买，请由家长操作。`,
      remaining: MINOR_SINGLE_PURCHASE_CAP,
    };
  }

  const remaining = Math.max(0, effectiveMonthly - input.spentThisMonth);
  if (amount > remaining) {
    const reason = input.minorGuardEnabled ? '未成年人月消费限额' : '本月消费限额';
    return {
      allowed: false,
      code: 'SPEND_LIMIT_EXCEEDED',
      message:
        remaining <= 0
          ? `已达到${reason}（¥${effectiveMonthly}）。下个月自动重置，也可以在「我的 → 设置」里调整。`
          : `${reason}还剩 ¥${remaining}，不足以支付 ¥${amount}。`,
      remaining,
    };
  }

  /**
   * 免费档不允许买「档位内的付费单品」。
   *
   * 但订阅/升级本身必须放行 —— 否则免费档用户被这条规则挡住，
   * 永远无法变成付费用户（这是一个真实的死锁，实测踩到）。
   */
  const action = input.action ?? 'purchase';
  if (action === 'purchase' && input.tier === 'free' && amount > 0) {
    return {
      allowed: false,
      code: 'TIER_NOT_ALLOWED',
      message: '免费档不包含付费内容，请先订阅。',
      remaining: 0,
    };
  }

  return { allowed: true, remainingAfter: remaining - amount };
}

/** 宠物位校验 */
export function checkPetSlot(input: {
  tier: SubscriptionTier;
  /** 已有宠物数 */
  current: number;
  /** 账号上记录的 petSlots（以档位为准，取两者较小值，避免历史脏数据放大配额） */
  recordedSlots: number;
}): { allowed: boolean; limit: number; message?: string } {
  const tierLimit = PET_SLOTS[input.tier] ?? 1;
  const limit = Math.max(1, Math.min(tierLimit, input.recordedSlots || tierLimit));
  if (input.current >= limit) {
    return {
      allowed: false,
      limit,
      message:
        limit === 1
          ? '免费档只能养 1 只宠物。订阅 Plus 可以养到 3 只。'
          : `当前档位最多养 ${limit} 只宠物。`,
    };
  }
  return { allowed: true, limit };
}

/** 本月消费统计的键：UTC 年月，与计费口径一致 */
export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/** 从台账里统计某用户本月已消费金额（只统计真实或模拟的付费项） */
export function sumSpendThisMonth(entries: SpendEntry[], userId: string, now = new Date()): number {
  const target = monthKey(now);
  return entries
    .filter((e) => e.userId === userId && monthKey(new Date(e.createdAt)) === target)
    .reduce((sum, e) => sum + (Number.isFinite(e.amount) ? e.amount : 0), 0);
}

/** 供前端展示的计费状态 */
export interface BillingState {
  tier: SubscriptionTier;
  minorGuardEnabled: boolean;
  monthlySpendLimit: number;
  /** 实际生效的月限额（未成年人会被硬上限钳制） */
  effectiveLimit: number;
  spentThisMonth: number;
  remaining: number;
  /** 单笔上限；未成年人有值 */
  singlePurchaseCap: number | null;
  petSlots: number;
  petCount: number;
  /** 是否已接入真实支付通道 */
  paymentConfigured: boolean;
}

export function billingState(input: {
  tier: SubscriptionTier;
  minorGuardEnabled: boolean;
  monthlySpendLimit: number;
  spentThisMonth: number;
  petSlots: number;
  petCount: number;
  paymentConfigured: boolean;
}): BillingState {
  const effectiveLimit = input.minorGuardEnabled
    ? Math.max(0, Math.min(input.monthlySpendLimit, MINOR_MONTHLY_HARD_CAP))
    : Math.max(0, input.monthlySpendLimit);
  return {
    tier: input.tier,
    minorGuardEnabled: input.minorGuardEnabled,
    monthlySpendLimit: input.monthlySpendLimit,
    effectiveLimit,
    spentThisMonth: input.spentThisMonth,
    remaining: Math.max(0, effectiveLimit - input.spentThisMonth),
    singlePurchaseCap: input.minorGuardEnabled ? MINOR_SINGLE_PURCHASE_CAP : null,
    petSlots: input.petSlots,
    petCount: input.petCount,
    paymentConfigured: input.paymentConfigured,
  };
}
