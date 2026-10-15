/**
 * 共享规则层的单元测试（node --test + 原生类型剥离）
 * 覆盖说明书 6.1 好感度体系的数值口径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AFFECTION_RULES,
  DAILY_AFFECTION_CAP,
  computeGain,
  deriveMood,
  levelFromAffection,
  levelThreshold,
  longingFromIdle,
  streakRewardFor,
} from '../src/rules.ts';

test('好感度规则覆盖全部行为，且都有明确次数上限', () => {
  const actions = ['feed', 'bathe', 'play', 'chat', 'checkin', 'streak', 'reunion'];
  for (const action of actions) {
    const rule = AFFECTION_RULES[action as keyof typeof AFFECTION_RULES];
    assert.ok(rule, `缺少规则：${action}`);
    assert.ok(rule.dailyLimit >= 1, `${action} 必须有每日上限`);
    assert.ok(rule.label.length > 0);
  }
});

test('说明书 6.1 的数值口径：喂饭 2 次 / 洗澡 1 次 / 陪玩 3 次', () => {
  assert.equal(AFFECTION_RULES.feed.dailyLimit, 2);
  assert.equal(AFFECTION_RULES.bathe.dailyLimit, 1);
  assert.equal(AFFECTION_RULES.play.dailyLimit, 3);
});

test('未超限时按原值结算，不衰减', () => {
  const first = computeGain('feed', 0, DAILY_AFFECTION_CAP);
  assert.equal(first.gain, AFFECTION_RULES.feed.gain);
  assert.equal(first.cappedGain, 0);
});

test('超出每日次数后收益明显衰减（防刷）', () => {
  const inLimit = computeGain('play', 0, DAILY_AFFECTION_CAP);
  const overLimit = computeGain('play', 6, DAILY_AFFECTION_CAP);
  assert.ok(overLimit.gain < inLimit.gain, '超限收益应低于正常收益');
  assert.ok(overLimit.gain >= 1, '衰减后仍应有保底收益，避免玩家感到被惩罚');
});

test('单日总上限会截断收益并单独记录被截断的部分', () => {
  const { gain, cappedGain } = computeGain('checkin', 0, 5);
  assert.equal(gain, 5);
  assert.ok(cappedGain > 0, '被上限截断的部分必须单独记录，便于调参');
});

test('每日总上限是 120，且好感度不可购买', () => {
  assert.equal(DAILY_AFFECTION_CAP, 120);
  const { gain } = computeGain('checkin', 0, 0);
  assert.equal(gain, 0);
});

test('等级曲线单调递增，且进度在 0~1 之间', () => {
  assert.ok(levelThreshold(2) > levelThreshold(1));
  assert.ok(levelThreshold(10) > levelThreshold(9));

  const fresh = levelFromAffection(0);
  assert.equal(fresh.level, 1);
  assert.equal(fresh.levelProgress, 0);

  const mid = levelFromAffection(75);
  assert.ok(mid.level >= 1);
  assert.ok(mid.levelProgress >= 0 && mid.levelProgress <= 1);
});

test('连续陪伴里程碑只在天数命中时返回奖励', () => {
  assert.ok(streakRewardFor(3));
  assert.ok(streakRewardFor(7));
  assert.ok(streakRewardFor(14));
  assert.ok(streakRewardFor(30));
  assert.equal(streakRewardFor(4), null);
  assert.equal(streakRewardFor(1), null);
});

test('想念值：18 小时内满值，久不登录显著下降但不归零', () => {
  assert.equal(longingFromIdle(2), 100);
  assert.equal(longingFromIdle(18), 100);
  const week = longingFromIdle(24 * 7);
  assert.ok(week < 45, '一周不登录应该进入「闹小情绪」区间');
  assert.ok(week >= 15, '想念值有下限，不应变成彻底的惩罚');
});

test('情绪推导优先照顾「想念」与生理需求', () => {
  const base = { hoursSinceFeed: 2, hoursSinceBathe: 2, hoursSincePlay: 2, longing: 100, hourOfDay: 14 };
  assert.equal(deriveMood(base), 'happy');
  assert.equal(deriveMood({ ...base, longing: 20 }), 'lonely');
  assert.equal(deriveMood({ ...base, hoursSinceFeed: 12 }), 'hungry');
  assert.equal(deriveMood({ ...base, hoursSinceBathe: 72 }), 'dirty');
  assert.equal(deriveMood({ ...base, hoursSincePlay: 30 }), 'playful');
  assert.equal(deriveMood({ ...base, hourOfDay: 2 }), 'sleepy');
});
