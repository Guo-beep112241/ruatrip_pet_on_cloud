/**
 * profile 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { SUBSCRIPTION_PLANS } from '../../../../packages/shared/src/catalog.ts';
import type { SubscriptionTier } from '../../../../packages/shared/src/index.ts';
import type { SpendEntry } from '../services/billing.ts';
import { integrationReport } from '../adapters/registry.ts';
import { config } from '../config.ts';
import { parseBoundary } from '../http/multipart.ts';
import { MINOR_MONTHLY_HARD_CAP, PET_SLOTS, TIER_SPEND_CAP, billingState, checkSpend } from '../services/billing.ts';
import { nowIso } from '../services/growth.ts';
// TODO(M6): multipartBoundary 仍在 index.ts 内定义，需下沉
import { multipartBoundary, MultipartError, parseMultipart } from '../http/multipart.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerProfileRoutes(router: Router, svc: RouteServices): void {
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
/* -------- 我的 / 订阅 -------- */
  router.get('/api/profile', (ctx) => {
  const auth = authOf(ctx.req);
  const user = auth.account.profile;
  const pet = activePet(undefined, auth.userId);
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
      /** 计费状态（审计 F6）：前端据此展示剩余额度与限额说明 */
      billing: billingState({
        tier: user.tier,
        minorGuardEnabled: user.minorGuardEnabled,
        monthlySpendLimit: user.monthlySpendLimit,
        spentThisMonth: repos.spentThisMonth(auth.userId),
        petSlots: user.petSlots,
        petCount: repos.listPetsByOwner(auth.userId).length,
        paymentConfigured: Boolean(config.payment.providerKey),
      }),
      /** 各档位可花多少钱与能养几只，供前端展示而不是硬编码 */
      planLimits: { spendCap: TIER_SPEND_CAP, petSlots: PET_SLOTS, minorMonthlyHardCap: MINOR_MONTHLY_HARD_CAP },
    },
  };
});

  router.patch('/api/profile', (ctx) => {
  const auth = authOf(ctx.req);
  const body = check(ctx.body, SCHEMAS.patchProfile);
  /**
   * 只允许改这些字段。
   * 白名单而不是展开整个 body：否则客户端可以自行把 tier 改成 pro、
   * 或把 petSlots 改成 99（权限提升）。
   */
  const next = repos.patchProfile(auth.userId, {
    ...(body.nickname ? { nickname: body.nickname } : {}),
    ...(body.avatarEmoji ? { avatarEmoji: body.avatarEmoji } : {}),
    ...(body.minorGuardEnabled !== undefined ? { minorGuardEnabled: body.minorGuardEnabled } : {}),
    ...(body.monthlySpendLimit !== undefined
      ? { monthlySpendLimit: Math.max(0, Math.min(5000, Number(body.monthlySpendLimit) || 0)) }
      : {}),
  });
  return { ok: true, data: { user: next } };
});

/**
 * 订阅（审计 F6 + 十一）。
 *
 * 三件事：
 *   1. **限额校验**：未成年人单笔/月上限、账号月消费上限
 *   2. **记账**：写入消费台账，供后续校验与对账
 *   3. **降级保护**：从高档位降到低档位时，如果已有宠物超过新配额，拒绝降级
 *      （否则用户会瞬间失去对已有宠物的访问）
 *
 * ⚠️ 仍未接入真实支付。未接入时 `simulated: true` 会透传给前端，
 * 且**不会**绕过限额校验 —— 这样以后接支付时逻辑不用改。
 */
  router.post('/api/subscribe', (ctx) => {
  const auth = authOf(ctx.req);
  const body = check(ctx.body, SCHEMAS.subscribe);
  const tier: SubscriptionTier = body.tier ?? 'free';
  const cycle = body.cycle ?? 'monthly';

  const plan = SUBSCRIPTION_PLANS.find((p) => p.tier === tier);
  if (!plan) throw Object.assign(new Error('UNKNOWN_PLAN'), { status: 400 });

  const profile = auth.account.profile;
  const paymentsOn = Boolean(config.payment.providerKey);
  const amount = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;

  // 降级保护：不能降到装不下已有宠物的档位
  const ownedPets = repos.listPetsByOwner(auth.userId).length;
  const targetSlots = PET_SLOTS[tier] ?? 1;
  if (ownedPets > targetSlots) {
    throw Object.assign(new Error('TIER_DOWNGRADE_BLOCKED'), {
      status: 409,
      detail: `你已经有 ${ownedPets} 只宠物，${plan.name}档最多 ${targetSlots} 只。请先删除多余的宠物再降级。`,
    });
  }

  // 限额校验（免费档金额为 0，会直接通过）
  const spent = repos.spentThisMonth(auth.userId);
  const decision = checkSpend({
    userId: auth.userId,
    kind: 'subscription',
    sku: tier,
    // 订阅/升级必须放行（免费档也不例外），否则永远无法升级
    action: 'subscribe',
    amount,
    tier: profile.tier,
    minorGuardEnabled: profile.minorGuardEnabled,
    monthlySpendLimit: profile.monthlySpendLimit,
    spentThisMonth: spent,
  });
  if (!decision.allowed) {
    throw Object.assign(new Error(decision.code), { status: 403, detail: decision.message });
  }

  // 记账（即使金额为 0 也记一条，便于对账「何时开通了什么档位」）
  const entry: SpendEntry = {
    id: `spend-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: auth.userId,
    kind: 'subscription',
    sku: `${tier}:${cycle}`,
    amount,
    simulated: !paymentsOn,
    createdAt: nowIso(),
  };
  repos.addSpend(entry);

  const user = repos.patchProfile(auth.userId, { tier, petSlots: targetSlots });
  return {
    ok: true,
    data: {
      user,
      plan: { tier, name: plan.name, price: amount },
      // 未接入支付通道时明确告知是模拟开通，前端会显示提示
      simulated: !paymentsOn,
      /** 本次消费后本月的剩余额度 */
      remainingAfter: decision.allowed ? decision.remainingAfter : undefined,
      spendEntry: entry,
    },
  };
});

/** 判断请求是否为 multipart/form-data */
function multipartBoundary(contentType: string | string[] | undefined): string | null {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return parseBoundary(value);
}

/* ------------------------------------------------------------------ */
}
