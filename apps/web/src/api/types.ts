/**
 * 前端使用的类型别名。
 * 直接复用 packages/shared 的领域模型，保证前后端契约只有一个来源。
 */
export type * from '../../../../packages/shared/src/index.ts';
export type * from '../../../../packages/shared/src/api.ts';

export {
  AFFECTION_RULES,
  DAILY_AFFECTION_CAP,
  STREAK_MILESTONES,
  levelFromAffection,
  longingFromIdle,
} from '../../../../packages/shared/src/rules.ts';

export {
  DESTINATIONS,
  MOOD_COPY,
  PREFERENCE_QUESTIONS,
  SCENE_PRESETS,
  SHOP_ITEMS,
  SPECIES_CATALOG,
  SUBSCRIPTION_PLANS,
} from '../../../../packages/shared/src/catalog.ts';

export type { ScenePreset } from '../../../../packages/shared/src/catalog.ts';

/* ------------------------------------------------------------------ */
/* 服务端专属的响应结构（前端展示用）                                   */
/* ------------------------------------------------------------------ */

/**
 * 计费状态。
 * 与 apps/server/src/services/billing.ts 的 BillingState 一一对应；
 * 放这里而不是 packages/shared，是因为它描述的是「服务端策略」而非领域模型，
 * 前端只做展示，不参与计算（避免两边各算一套导致不一致）。
 */
export interface BillingState {
  tier: 'free' | 'plus' | 'pro';
  minorGuardEnabled: boolean;
  monthlySpendLimit: number;
  /** 实际生效的月限额（未成年人会被硬上限钳制） */
  effectiveLimit: number;
  spentThisMonth: number;
  remaining: number;
  /** 单笔上限；未成年人有值，成年人为 null */
  singlePurchaseCap: number | null;
  petSlots: number;
  petCount: number;
  /** 是否已接入真实支付通道；false 时订阅为模拟开通 */
  paymentConfigured: boolean;
}

/** 各档位的配额上限，由服务端下发而不是前端硬编码 */
export interface PlanLimits {
  spendCap: Record<string, number>;
  petSlots: Record<string, number>;
  minorMonthlyHardCap: number;
}
