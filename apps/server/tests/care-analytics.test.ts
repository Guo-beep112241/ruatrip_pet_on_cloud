/**
 * 情绪关怀（F4）、埋点（F3）、推送（F2）的测试。
 *
 * 这三个功能的共同点是「做错比不做更糟」：
 *   - 关怀做成唠叨会伤害用户
 *   - 埋点采到隐私内容会造成实质风险
 *   - 推送假装成功会让部署者误判
 * 所以测试重点放在边界与克制上，而不只是「能跑」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARE_MESSAGES,
  CareTracker,
  GRIEF_THRESHOLD,
  INTENSE_ACTION_THRESHOLD,
  PROLONGED_SESSION_MS,
  SUPPORT_RESOURCES,
  evaluateCare,
  markPrompted,
} from '../src/services/care.ts';
import { Analytics, LocalAnalytics, sanitizeProps } from '../src/adapters/analytics.ts';
import { LocalPushProvider, PushService, generationDonePushText, longingPushText } from '../src/adapters/push.ts';

/* ============================================================
 * F4 情绪关怀
 * ============================================================ */

const baseCare = {
  userId: 'u1',
  now: 1_700_000_000_000,
  sessionStartedAt: 1_700_000_000_000,
  actionsInWindow: 0,
  griefMentions: 0,
  promptedToday: {},
};

test('F4: 正常使用不提示（关怀必须克制）', () => {
  const d = evaluateCare(baseCare);
  assert.equal(d.shouldPrompt, false);
  assert.equal(d.signal, null);
  assert.equal(d.message, null);
});

test('F4: 停留超过 2 小时提示休息，但不附支持渠道', () => {
  const d = evaluateCare({
    ...baseCare,
    now: baseCare.sessionStartedAt + PROLONGED_SESSION_MS + 1,
  });
  assert.equal(d.shouldPrompt, true);
  assert.equal(d.signal, 'prolonged');
  assert.equal(d.showSupportResources, false, '只是用久了，不该上升到心理支持');
  assert.match(d.message ?? '', /等你回来/);
});

test('F4: 高强度操作提示休息', () => {
  const d = evaluateCare({ ...baseCare, actionsInWindow: INTENSE_ACTION_THRESHOLD });
  assert.equal(d.signal, 'intense');
  assert.equal(d.showSupportResources, false);
});

test('F4: 高强度阈值低于速率限流，否则永远触发不到', () => {
  // 速率限流是 120 次/分钟；若关怀阈值 >= 120，限流会永远先拦住用户
  assert.ok(INTENSE_ACTION_THRESHOLD < 120, `阈值 ${INTENSE_ACTION_THRESHOLD} 必须低于限流上限 120`);
});

test('F4: 悲伤信号优先于其它信号，且附现实支持渠道', () => {
  const d = evaluateCare({
    ...baseCare,
    griefMentions: GRIEF_THRESHOLD,
    actionsInWindow: INTENSE_ACTION_THRESHOLD,
    now: baseCare.sessionStartedAt + PROLONGED_SESSION_MS + 1,
  });
  assert.equal(d.signal, 'grief', '悲伤需要的是支持渠道，不是「歇一会儿」');
  assert.equal(d.showSupportResources, true);
  assert.ok(SUPPORT_RESOURCES.length > 0);
  for (const r of SUPPORT_RESOURCES) {
    assert.ok(r.contact.length > 0, '支持渠道必须有联系方式');
  }
});

test('F4: 同一信号一天只提示一次（避免关怀变成唠叨）', () => {
  const now = baseCare.now;
  const first = evaluateCare({ ...baseCare, actionsInWindow: INTENSE_ACTION_THRESHOLD });
  assert.equal(first.shouldPrompt, true);

  const prompted = markPrompted({}, 'intense', now);
  const second = evaluateCare({
    ...baseCare,
    actionsInWindow: INTENSE_ACTION_THRESHOLD * 2,
    promptedToday: prompted,
  });
  assert.equal(second.shouldPrompt, false, '同一天不应重复提示同一信号');

  // 不同信号互不影响
  const other = evaluateCare({
    ...baseCare,
    now: now + PROLONGED_SESSION_MS + 1,
    promptedToday: prompted,
  });
  assert.equal(other.signal, 'prolonged', '其它信号仍可提示');
});

test('F4: 跨天后可以再次提示', () => {
  const day1 = new Date('2026-03-01T10:00:00Z').getTime();
  const prompted = markPrompted({}, 'intense', day1);
  const day2 = new Date('2026-03-02T10:00:00Z').getTime();
  const d = evaluateCare({
    ...baseCare,
    now: day2,
    sessionStartedAt: day2,
    actionsInWindow: INTENSE_ACTION_THRESHOLD,
    promptedToday: prompted,
  });
  assert.equal(d.shouldPrompt, true);
});

test('F4: CareTracker 累积计数并互不干扰', () => {
  const tracker = new CareTracker();
  // 用户 A 达到阈值
  let decision = { shouldPrompt: false } as { shouldPrompt: boolean };
  for (let i = 0; i <= INTENSE_ACTION_THRESHOLD; i += 1) {
    decision = tracker.observe({ userId: 'a', actionCount: i, griefMentions: 0 });
  }
  assert.equal(decision.shouldPrompt, true);

  // 用户 B 不受 A 的影响
  const b = tracker.observe({ userId: 'b', actionCount: 1, griefMentions: 0 });
  assert.equal(b.shouldPrompt, false, '不同用户的状态必须隔离');

  tracker.reset();
  const afterReset = tracker.observe({ userId: 'a', actionCount: 1, griefMentions: 0 });
  assert.equal(afterReset.shouldPrompt, false);
});

test('F4: 关怀文案是宠物口吻，不是合规弹窗', () => {
  for (const signal of ['prolonged', 'intense', 'grief'] as const) {
    const msg = CARE_MESSAGES[signal].message;
    assert.ok(!/根据.*规定|请知悉|温馨提示/.test(msg), `文案不该像合规提示：${msg}`);
    assert.ok(msg.length <= 60, '文案要短，手机上一眼能读完');
  }
});

/* ============================================================
 * F3 埋点
 * ============================================================ */

test('F3: props 白名单过滤掉未声明的键', () => {
  const out = sanitizeProps({ gain: 8, level: 2, message: '我今天被老板骂了', photoUrl: '/x.jpg' });
  assert.equal(out.gain, 8);
  assert.equal(out.level, 2);
  assert.equal('message' in out, false, '自由文本绝不能进埋点');
  assert.equal('photoUrl' in out, false);
});

test('F3: props 拒绝复杂类型与超长字符串', () => {
  const out = sanitizeProps({
    action: 'feed',
    gain: Number.NaN,
    count: Number.POSITIVE_INFINITY,
    category: 'x'.repeat(200),
    level: { nested: true },
  });
  assert.equal(out.action, 'feed');
  assert.equal('gain' in out, false, 'NaN 不是有效数值');
  assert.equal('count' in out, false);
  assert.equal('category' in out, false, '超长字符串应被丢弃');
  assert.equal('level' in out, false, '对象应被丢弃');
});

test('F3: 汇总给出事件计数与按天分布', () => {
  const local = new LocalAnalytics();
  const day1 = new Date('2026-03-01T10:00:00Z').getTime();
  const day2 = new Date('2026-03-02T10:00:00Z').getTime();
  local.track({ name: 'interact.feed', userId: 'u1', at: day1 });
  local.track({ name: 'interact.feed', userId: 'u1', at: day1 });
  local.track({ name: 'travel.checkin', userId: 'u1', at: day2 });
  local.track({ name: 'interact.feed', userId: 'u2', at: day2 });

  const all = local.summary();
  assert.equal(all.total, 4);
  assert.equal(all.counts['interact.feed'], 3);
  assert.equal(all.daily['2026-03-01'], 2);
  assert.equal(all.daily['2026-03-02'], 2);

  const scoped = local.summary('u1');
  assert.equal(scoped.total, 3, '可按用户过滤');
});

test('F3: 环形缓冲限制内存增长', () => {
  const local = new LocalAnalytics();
  for (let i = 0; i < 5200; i += 1) {
    local.track({ name: 'chat.send', userId: 'u1', at: Date.now() });
  }
  assert.ok(local.list(10000).length <= 5000, '长期运行不应无限涨内存');
});

test('F3: track 永不抛异常（埋点不该让用户操作失败）', () => {
  const a = new Analytics();
  assert.doesNotThrow(() => a.track('chat.send', 'u1', undefined));
  // 故意传奇怪的值
  assert.doesNotThrow(() => a.track('chat.send', 'u1', { gain: { bad: true } } as never));
  assert.equal(a.realSinkConfigured, false);
});

test('F3: 导出可序列化，且不含未过滤字段', () => {
  const local = new LocalAnalytics();
  local.track({ name: 'travel.checkin', userId: 'u1', at: Date.now(), props: { destinationId: 'sanya', secret: 'x' } });
  const dump = local.export();
  const text = JSON.stringify(dump);
  assert.ok(!text.includes('secret'), '未声明的键不该出现在导出里');
  assert.ok(text.includes('sanya'));
  assert.equal(dump.count, 1);
});

/* ============================================================
 * F2 推送
 * ============================================================ */

test('F2: 本地通道记录通知，不假装真实投递', async () => {
  const local = new LocalPushProvider();
  const result = await local.send({
    userId: 'u1',
    title: '汤圆准备好了',
    body: '进去打个招呼吧',
    category: 'generation',
  });
  assert.equal(result.delivered, true);
  assert.equal(result.channel, 'local', '必须明确是本地通道');
  assert.equal(local.list('u1').length, 1);
  assert.equal(local.list('u2').length, 0, '按用户隔离');
});

test('F2: 未配置真实通道时 PushService 回落到本地并标注', async () => {
  const service = new PushService();
  assert.equal(service.realChannelConfigured, false);
  assert.equal(service.activeChannel, 'local');
  const result = await service.send({ userId: 'u1', title: 't', body: 'b', category: 'system' });
  assert.equal(result.channel, 'local');
});

test('F2: 真实通道失败时仍落到本地（用户至少能在应用内看到）', async () => {
  const failing = {
    channel: 'web-push' as const,
    configured: true,
    send: async () => ({ delivered: false, channel: 'web-push' as const, reason: 'failed' as const }),
  };
  const service = new PushService(failing);
  const result = await service.send({ userId: 'u1', title: 't', body: 'b', category: 'system' });
  assert.equal(result.delivered, false);
  assert.equal(service.local.list('u1').length, 1, '失败也要留一份本地记录');
});

test('F2: 通道抛异常不会影响主流程', async () => {
  const throwing = {
    channel: 'fcm' as const,
    configured: true,
    send: async () => {
      throw new Error('network down');
    },
  };
  const service = new PushService(throwing);
  await assert.doesNotReject(() => service.send({ userId: 'u1', title: 't', body: 'b', category: 'system' }));
});

test('F2: 召回文案是宠物口吻，不是考勤提醒', () => {
  for (const longing of [10, 40, 55]) {
    const text = longingPushText('汤圆', longing);
    assert.ok(!/你已.*天未登录|签到|打卡提醒/.test(text.body), `不该像考勤：${text.body}`);
    assert.ok(text.body.length <= 60);
  }
  // 不同想念值给出不同文案，避免每次都一样
  const a = longingPushText('汤圆', 10).body;
  const b = longingPushText('汤圆', 40).body;
  assert.notEqual(a, b);
});

test('F2: 生成完成文案区分正常与降级', () => {
  const ok = generationDonePushText('汤圆', false);
  const degraded = generationDonePushText('汤圆', true);
  assert.notEqual(ok.body, degraded.body);
  assert.match(degraded.body, /降级|本地形象|暂时不可用/, '降级必须如实告知');
});
