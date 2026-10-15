/**
 * 端到端冒烟测试（审计 O1）。
 *
 * 覆盖说明书第八节的「首次使用主路径」：
 *   注册 → 问卷 → 孵化 → 互动 → 对话 → 打卡 → 手账 → 订阅
 *
 * 与其它测试的分工：
 *   - 单元测试验证规则（好感度数值、内容安全、掩码/校验）
 *   - 隔离测试验证越权防线
 *   - **本测试验证「用户真能走完一条完整链路」**
 *     —— 它能抓到「每个接口单独都对，但串起来走不通」这类问题
 *     （例如新注册用户没有问卷答案导致生成失败）
 *
 * 用真实 HTTP + 真实落盘，跑在临时数据目录上。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.SESSION_SECRET = 'e2e-secret-at-least-32-characters-long';
process.env.AUTH_MODE = 'required';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ruatrip-e2e-'));

const { createApp } = await import('../src/index.ts');
const { __resetStoreForTests } = await import('../src/db/store.ts');
const { __resetSessionSecretForTests } = await import('../src/http/auth.ts');

let server: Server;
let base = '';
const dataDir = process.env.DATA_DIR;
let token = '';
let petId = '';

before(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetStoreForTests();
  __resetSessionSecretForTests();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown, useToken = true): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (useToken && token) headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, ...(payload ? { body: payload } : {}) });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data: parsed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('E2E 1: 注册并拿到会话', async () => {
  const res = await api('POST', '/api/auth/register', {
    email: 'e2e@example.com',
    password: 'ruatrip2026',
    nickname: '端到端',
  }, false);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  token = res.data.data.token;
  assert.ok(token);
});

test('E2E 2: 问卷提交后得到偏好画像与候选名字', async () => {
  const res = await api('POST', '/api/survey', {
    answers: {
      species: ['capybara'],
      bodySize: ['medium'],
      fur: ['fluffy'],
      palette: ['oat', 'chestnut', 'coral'],
      personality: ['mature', 'tsundere'],
      rhythm: ['balanced'],
      travel: ['mountain', 'seaside'],
      photoHabit: ['heavy'],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const inference = res.data.data.inference;
  assert.equal(inference.confidence, 1, '全部作答时置信度应为 1');
  assert.equal(inference.inferredDimensions.length, 0, '不应有被补全的维度');
  assert.equal(res.data.data.petDraft.species, 'capybara');
  assert.ok(res.data.data.suggestedNames.length > 0);
  assert.ok(res.data.data.suggestedQuirks.length > 0, '宠物必须有缺点');
});

test('E2E 3: 跳过部分题目时用相似画像补全', async () => {
  const res = await api('POST', '/api/survey', { answers: { species: ['shiba'] } });
  assert.equal(res.status, 200);
  const inference = res.data.data.inference;
  assert.ok(inference.confidence < 1);
  assert.ok(inference.inferredDimensions.length > 0, '未作答的维度必须被补全，而不是留空');
});

test('E2E 4: 创建宠物并等到孵化完成', async () => {
  const created = await api('POST', '/api/pet', { name: '泡芙', callName: '泡芙' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  petId = created.data.data.pet.id;
  const jobId = created.data.data.job.id;

  // 轮询直到 ready / fallback_used（Mock 模式下约 9 秒）
  let stage = 'queued';
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const res = await api('GET', `/api/pet/generation/${jobId}`);
    assert.equal(res.status, 200);
    stage = res.data.data.job.stage;
    if (stage === 'ready' || stage === 'fallback_used') break;
  }
  assert.ok(['ready', 'fallback_used'].includes(stage), `孵化未完成，最后阶段 ${stage}`);

  const boot = await api('GET', '/api/bootstrap');
  assert.equal(boot.data.data.pet.id, petId);
  assert.equal(boot.data.data.pet.asset.rigged, true, '孵化完成后必须有骨骼');
});

test('E2E 5: 四项互动都能加好感度，且超限会被拦', async () => {
  const feed = await api('POST', '/api/interact', { petId, action: 'feed' });
  assert.equal(feed.status, 200, JSON.stringify(feed.data));
  assert.ok(feed.data.data.gain > 0, '喂饭应加好感度');
  assert.ok(feed.data.data.reaction.length > 0, '必须有即时反馈文案');

  const bathe = await api('POST', '/api/interact', { petId, action: 'bathe' });
  assert.equal(bathe.status, 200);

  // 陪玩每日 3 次
  for (let i = 0; i < 3; i += 1) {
    const play = await api('POST', '/api/interact', { petId, action: 'play', toyId: `toy-${i}` });
    assert.equal(play.status, 200, `第 ${i + 1} 次陪玩应成功`);
  }
  const fourth = await api('POST', '/api/interact', { petId, action: 'play', toyId: 'toy-x' });
  assert.equal(fourth.status, 429, '第 4 次陪玩必须被拦');

  // 抚摸不加好感度但要有反馈
  const touch = await api('POST', '/api/interact/pet', { petId, part: 'tail' });
  assert.equal(touch.status, 200);
  assert.ok(touch.data.data.reaction.length > 0);
});

test('E2E 6: 对话四层与安全过滤都工作', async () => {
  const greeting = await api('POST', '/api/chat', { petId, text: '你好' });
  assert.equal(greeting.status, 200, JSON.stringify(greeting.data));
  assert.ok(greeting.data.data.petMessage.content.length > 0);

  const free = await api('POST', '/api/chat', { petId, text: '今天有点累' });
  assert.equal(free.status, 200);
  assert.ok(free.data.data.petMessage.content.length > 0);

  // 前置过滤：自我认知类追问必须被挡回，且不调模型
  const probe = await api('POST', '/api/chat', { petId, text: '你是不是AI' });
  assert.equal(probe.status, 200);
  assert.equal(probe.data.data.safety.blocked, true);
  assert.equal(probe.data.data.modelUsed, false, '被拦截的输入不该调用模型（省成本）');

  // 高风险表达必须附现实支持渠道
  const risk = await api('POST', '/api/chat', { petId, text: '我不想活了' });
  assert.equal(risk.status, 200);
  assert.equal(risk.data.data.safety.showSupportResources, true);

  // 记忆：聊够了应该产生记忆
  const memories = await api('GET', `/api/chat/memories?petId=${petId}`);
  assert.equal(memories.status, 200);
  assert.ok(memories.data.data.memories.length > 0, '对话后应产生记忆');
});

test('E2E 7: 打卡生成手账、明信片与徽章', async () => {
  const res = await api('POST', '/api/travel/checkin', { petId, destinationId: 'sanya', note: '海边风很大' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const d = res.data.data;
  assert.ok(d.gain > 0, '首次打卡应加好感度');
  assert.ok(d.journal.title.length > 0, '必须自动生成手账');
  assert.ok(d.journal.body.length > 50, '手账正文不能是空壳');
  assert.ok(d.postcard.text.length > 0, '必须生成宠物视角明信片');
  assert.ok(d.badge?.unlocked, '必须解锁徽章');
  assert.ok(d.storyChapter, '必须解锁剧情章节');
  assert.ok(d.checkin.composedPhotoUrl, '必须有宠物出镜合成图');
});

test('E2E 8: 再次打卡触发时光机回忆，但不重复给好感度', async () => {
  const res = await api('POST', '/api/travel/checkin', { petId, destinationId: 'sanya' });
  assert.equal(res.status, 200);
  assert.equal(res.data.data.gain, 0, '同一地点只算一次好感度');
  assert.ok(res.data.data.revisitMemory, '再次到访必须给出上次的回忆');
});

test('E2E 9: 手账时间轴与明信片列表可读', async () => {
  const travel = await api('GET', `/api/travel?petId=${petId}`);
  assert.equal(travel.status, 200);
  assert.equal(travel.data.data.checkins.length, 2);
  assert.equal(travel.data.data.journals.length, 2);
  assert.ok(travel.data.data.badges.some((b: any) => b.unlocked));
  assert.ok(travel.data.data.wishlist.length > 0, '新宠物应自动获得心愿单');
});

test('E2E 10: 好感度总览与等级进度一致', async () => {
  const res = await api('GET', `/api/affection?petId=${petId}`);
  assert.equal(res.status, 200);
  const d = res.data.data;
  assert.ok(d.pet.affection > 0);
  assert.ok(d.todayGain > 0 && d.todayGain <= d.dailyCap, `今日收益 ${d.todayGain} 应在 0..${d.dailyCap}`);
  assert.ok(d.pet.levelProgress >= 0 && d.pet.levelProgress <= 1);
  assert.ok(d.recent.length > 0, '应有互动日志');
});

test('E2E 11: 商店兑换只扣好感度（不可购买）', async () => {
  const shop = await api('GET', `/api/shop?petId=${petId}`);
  assert.equal(shop.status, 200);
  assert.ok(shop.data.data.items.length > 0);
  for (const item of shop.data.data.items) {
    assert.equal(item.affectionOnly, true, '所有商品必须只能用好感度兑换');
    assert.ok(!('priceCny' in item) && !('currency' in item), '商品不得带现实货币字段');
  }

  // 好感度不足时应被明确拒绝
  const poor = shop.data.data.items.find((i: any) => i.price > shop.data.data.affection);
  if (poor) {
    const res = await api('POST', '/api/shop/redeem', { petId, itemId: poor.id });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /好感度/);
  }
});

test('E2E 12: 云代养与时光胶囊流程可用', async () => {
  const foster = await api('POST', '/api/foster', { petId, friendName: '小满', days: 3 });
  assert.equal(foster.status, 200, JSON.stringify(foster.data));
  const list = await api('GET', `/api/foster?petId=${petId}`);
  assert.equal(list.data.data.requests.length, 1);

  const capsule = await api('POST', '/api/capsule', {
    photoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    petName: '豆豆',
    letterTo: '我很想你',
  });
  assert.equal(capsule.status, 200, JSON.stringify(capsule.data));
  assert.ok(capsule.data.data.disclaimer.includes('不是它本人'), '必须做预期管理');
});

test('E2E 13: 订阅受消费限额约束（未成年人保护默认开启）', async () => {
  const tooExpensive = await api('POST', '/api/subscribe', { tier: 'pro', cycle: 'yearly' });
  assert.equal(tooExpensive.status, 403);
  assert.equal(tooExpensive.data.error.code, 'MINOR_SINGLE_PURCHASE_LIMIT');

  const ok = await api('POST', '/api/subscribe', { tier: 'plus', cycle: 'monthly' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.data.simulated, true, '未接支付必须标注模拟');
});

test('E2E 14: 通知与埋点在整条链路后都有内容', async () => {
  const notif = await api('GET', '/api/notifications');
  assert.equal(notif.status, 200);
  assert.ok(notif.data.data.items.length > 0, '孵化完成应产生一条通知');
  assert.equal(notif.data.data.channel, 'local', '未配真实通道时应明确是本地');

  const summary = await api('GET', '/api/analytics/summary');
  assert.equal(summary.status, 200);
  const counts = summary.data.data.counts;
  for (const event of ['pet.create', 'interact.feed', 'travel.checkin', 'journal.generate', 'chat.safety_blocked']) {
    assert.ok(counts[event] > 0, `缺少埋点事件：${event}`);
  }
  // 隐私：导出里不能出现对话内容
  const dump = await api('GET', '/api/analytics/export');
  const text = JSON.stringify(dump.data.data);
  assert.ok(!text.includes('今天有点累'), '埋点不得包含用户对话内容');
  assert.ok(!text.includes('我不想活了'));
});

test('E2E 15: 账号注销会清空全部关联数据', async () => {
  const del = await api('DELETE', '/api/auth/account', { password: 'ruatrip2026', confirm: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(del.data.data.deleted, true);
  assert.ok(del.data.data.removedPets >= 1, '应报告清理了几只宠物');

  // 旧 token 失效
  const me = await api('GET', '/api/auth/me');
  assert.equal(me.status, 401);

  // 邮箱可再次注册（说明数据真的清掉了）
  const again = await api('POST', '/api/auth/register', {
    email: 'e2e@example.com',
    password: 'ruatrip2026',
  }, false);
  assert.equal(again.status, 200);
});
