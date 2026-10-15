/**
 * 消费限额与配额测试（审计 F6）。
 *
 * 这些规则在修复前**完全没有被校验**：minorGuardEnabled 与 monthlySpendLimit
 * 只是存了字段，宠物位上限也是形同虚设。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MINOR_MONTHLY_HARD_CAP,
  MINOR_SINGLE_PURCHASE_CAP,
  PET_SLOTS,
  TIER_SPEND_CAP,
  billingState,
  checkPetSlot,
  checkSpend,
  monthKey,
  sumSpendThisMonth,
  type SpendEntry,
} from '../src/services/billing.ts';

const base = {
  userId: 'u1',
  kind: 'subscription' as const,
  sku: 'plus:monthly',
  action: 'subscribe' as const,
  amount: 25,
  tier: 'plus' as const,
  minorGuardEnabled: false,
  monthlySpendLimit: 200,
  spentThisMonth: 0,
};

/* ============================================================
 * 月消费限额
 * ============================================================ */

test('F6: 额度充足时放行，并给出剩余额度', () => {
  const d = checkSpend({ ...base, spentThisMonth: 100 });
  assert.equal(d.allowed, true);
  if (d.allowed) assert.equal(d.remainingAfter, 75, '200 - 100 - 25');
});

test('F6: 超过月限额被拒，并说明还剩多少', () => {
  const d = checkSpend({ ...base, spentThisMonth: 190 });
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.equal(d.code, 'SPEND_LIMIT_EXCEEDED');
    assert.equal(d.remaining, 10);
    assert.match(d.message, /还剩 ¥10/);
  }
});

test('F6: 额度刚好用完时被拒，且提示下月重置', () => {
  const d = checkSpend({ ...base, spentThisMonth: 200 });
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.equal(d.remaining, 0);
    assert.match(d.message, /下个月自动重置/);
  }
});

test('F6: 好感度兑换（金额 0）不受任何限额约束', () => {
  const d = checkSpend({ ...base, amount: 0, spentThisMonth: 99999 });
  assert.equal(d.allowed, true);
});

/* ============================================================
 * 未成年人保护
 * ============================================================ */

test('F6: 未成年人单笔上限独立于月限额', () => {
  // 月限额给得很宽松，但单笔仍然受限
  const d = checkSpend({
    ...base,
    amount: MINOR_SINGLE_PURCHASE_CAP + 1,
    minorGuardEnabled: true,
    monthlySpendLimit: 1000,
  });
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.equal(d.code, 'MINOR_SINGLE_PURCHASE_LIMIT');
    assert.match(d.message, /家长/);
  }
});

test('F6: 未成年人的月限额被硬上限钳制（防止把保护设成无效值）', () => {
  // 把月限额设成 99999，实际生效值必须被钳到 MINOR_MONTHLY_HARD_CAP
  const d = checkSpend({
    ...base,
    amount: 50,
    minorGuardEnabled: true,
    monthlySpendLimit: 99999,
    spentThisMonth: MINOR_MONTHLY_HARD_CAP,
  });
  assert.equal(d.allowed, false, '超过硬上限必须被拒');

  const ok = checkSpend({
    ...base,
    amount: 50,
    minorGuardEnabled: true,
    monthlySpendLimit: 99999,
    spentThisMonth: 0,
  });
  assert.equal(ok.allowed, true, '硬上限之内仍可消费');
});

test('F6: 关闭未成年人保护后按普通月限额执行', () => {
  const d = checkSpend({
    ...base,
    amount: 100,
    minorGuardEnabled: false,
    monthlySpendLimit: 200,
  });
  assert.equal(d.allowed, true, '成年人不受单笔 50 的限制');
});

/* ============================================================
 * 边界与防绕过
 * ============================================================ */

test('F6: 负数与非法金额被拒（避免用它绕过台账）', () => {
  for (const amount of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = checkSpend({ ...base, amount });
    assert.equal(d.allowed, false, `应拒绝金额 ${amount}`);
  }
});

test('F6: 免费档不能买档位内单品，但**可以订阅升级**', () => {
  // 买单品 → 拒绝
  const buy = checkSpend({ ...base, tier: 'free', action: 'purchase', amount: 1, monthlySpendLimit: 200 });
  assert.equal(buy.allowed, false);
  if (!buy.allowed) assert.equal(buy.code, 'TIER_NOT_ALLOWED');
  assert.equal(TIER_SPEND_CAP.free, 0);

  // 订阅升级 → 必须放行，否则免费档用户永远无法变成付费用户
  const upgrade = checkSpend({ ...base, tier: 'free', action: 'subscribe', amount: 25, monthlySpendLimit: 200 });
  assert.equal(upgrade.allowed, true, '免费档升级订阅不能被挡住（真实死锁）');
});

test('F6: 未显式指定 action 时按「买单品」处理（更严格）', () => {
  const noAction = { ...base, tier: 'free' as const, amount: 1 };
  delete (noAction as { action?: string }).action;
  const d = checkSpend(noAction);
  assert.equal(d.allowed, false, '默认应走更严格的语义');
});

test('F6: 月限额本身受账号设置约束（可为 0）', () => {
  const d = checkSpend({ ...base, amount: 1, monthlySpendLimit: 0 });
  assert.equal(d.allowed, false);
});

/* ============================================================
 * 宠物位配额（原实现完全没有校验）
 * ============================================================ */

test('F6: 免费档只能养 1 只', () => {
  assert.equal(checkPetSlot({ tier: 'free', current: 0, recordedSlots: 1 }).allowed, true);
  const full = checkPetSlot({ tier: 'free', current: 1, recordedSlots: 1 });
  assert.equal(full.allowed, false);
  assert.equal(full.limit, 1);
  assert.match(full.message ?? '', /Plus/);
});

test('F6: 档位决定上限，且不接受被放大的 recordedSlots', () => {
  // 免费档但记录里写着 99 个位 → 必须以档位为准，取较小值
  const inflated = checkPetSlot({ tier: 'free', current: 1, recordedSlots: 99 });
  assert.equal(inflated.allowed, false, '不能靠脏数据放大配额');
  assert.equal(inflated.limit, 1);

  assert.equal(checkPetSlot({ tier: 'plus', current: 2, recordedSlots: 3 }).allowed, true);
  assert.equal(checkPetSlot({ tier: 'plus', current: 3, recordedSlots: 3 }).allowed, false);
  assert.equal(checkPetSlot({ tier: 'pro', current: 5, recordedSlots: 6 }).allowed, true);
});

test('F6: 配额上限表与产品定义一致', () => {
  assert.deepEqual(PET_SLOTS, { free: 1, plus: 3, pro: 6 });
});

/* ============================================================
 * 台账统计
 * ============================================================ */

function entry(amount: number, iso: string, userId = 'u1'): SpendEntry {
  return {
    id: `s-${iso}-${amount}`,
    userId,
    kind: 'subscription',
    sku: 'plus:monthly',
    amount,
    simulated: true,
    createdAt: iso,
  };
}

test('F6: 本月消费只统计当月、只统计本人', () => {
  const now = new Date('2026-03-15T10:00:00Z');
  const ledger = [
    entry(25, '2026-03-01T00:00:00Z'),
    entry(25, '2026-03-14T00:00:00Z'),
    entry(99, '2026-02-28T00:00:00Z'), // 上月，不计
    entry(50, '2026-03-10T00:00:00Z', 'u2'), // 别人，不计
  ];
  assert.equal(sumSpendThisMonth(ledger, 'u1', now), 50);
  assert.equal(sumSpendThisMonth(ledger, 'u2', now), 50);
  assert.equal(sumSpendThisMonth(ledger, 'nobody', now), 0);
});

test('F6: monthKey 用 UTC，避免跨时区算错月份', () => {
  assert.equal(monthKey(new Date('2026-03-31T23:59:59Z')), '2026-03');
  assert.equal(monthKey(new Date('2026-04-01T00:00:01Z')), '2026-04');
});

test('F6: 台账里的非法金额不会污染统计', () => {
  const now = new Date('2026-03-15T10:00:00Z');
  const ledger = [entry(25, '2026-03-01T00:00:00Z'), entry(Number.NaN, '2026-03-02T00:00:00Z')];
  assert.equal(sumSpendThisMonth(ledger, 'u1', now), 25);
});

/* ============================================================
 * 前端展示状态
 * ============================================================ */

test('F6: billingState 给出实际生效的限额与剩余额度', () => {
  const adult = billingState({
    tier: 'plus',
    minorGuardEnabled: false,
    monthlySpendLimit: 200,
    spentThisMonth: 50,
    petSlots: 3,
    petCount: 1,
    paymentConfigured: false,
  });
  assert.equal(adult.effectiveLimit, 200);
  assert.equal(adult.remaining, 150);
  assert.equal(adult.singlePurchaseCap, null);

  const minor = billingState({
    tier: 'plus',
    minorGuardEnabled: true,
    monthlySpendLimit: 99999,
    spentThisMonth: 0,
    petSlots: 3,
    petCount: 1,
    paymentConfigured: false,
  });
  assert.equal(minor.effectiveLimit, MINOR_MONTHLY_HARD_CAP, '展示的必须是钳制后的值，与实际校验一致');
  assert.equal(minor.singlePurchaseCap, MINOR_SINGLE_PURCHASE_CAP);
});

test('F6: 剩余额度不会因为超支而变成负数', () => {
  const state = billingState({
    tier: 'plus',
    minorGuardEnabled: false,
    monthlySpendLimit: 100,
    spentThisMonth: 500,
    petSlots: 3,
    petCount: 1,
    paymentConfigured: false,
  });
  assert.equal(state.remaining, 0);
});

test('F6: paymentConfigured 反映支付是否接入（前端据此提示模拟开通）', () => {
  const on = billingState({
    tier: 'plus', minorGuardEnabled: false, monthlySpendLimit: 100,
    spentThisMonth: 0, petSlots: 3, petCount: 1, paymentConfigured: true,
  });
  assert.equal(on.paymentConfigured, true);
});
