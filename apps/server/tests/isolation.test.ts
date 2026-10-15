/**
 * 认证与多用户隔离的集成测试（审计 B2）。
 *
 * 用真实 HTTP 请求跑在随机端口上：越权、匿名、伪造 token 这类行为
 * 只有在传输层验证才可信（直接调函数会绕过中间件）。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.SESSION_SECRET = 'test-secret-at-least-32-characters-long';
process.env.AUTH_MODE = 'required';
// 集成测试会连续发大量请求，必须关掉限流；
// 限流本身由 apps/server/tests/security.test.ts 单独覆盖。
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ruatrip-auth-it-'));

const { createApp } = await import('../src/index.ts');
const { __resetStoreForTests } = await import('../src/db/store.ts');
const { __resetSessionSecretForTests } = await import('../src/http/auth.ts');

let server: Server;
let base = '';
const dataDir = process.env.DATA_DIR;

before(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetStoreForTests();
  __resetSessionSecretForTests();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

interface Res {
  status: number;
  body: any;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, ...(payload ? { body: payload } : {}) });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 160) };
  }
  return { status: res.status, body: parsed };
}

async function register(email: string, nickname: string): Promise<string> {
  const res = await call('POST', '/api/auth/register', undefined, {
    email,
    password: 'ruatrip2026',
    nickname,
  });
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(res.body)}`);
  return res.body.data.token as string;
}

let victimToken = '';
let attackerToken = '';
let victimPetId = '';

test('B2: 注册后可拿到 token，响应不含任何凭据', async () => {
  const res = await call('POST', '/api/auth/register', undefined, {
    email: 'Victim@Example.com',
    password: 'ruatrip2026',
    nickname: '受害者',
  });
  assert.equal(res.status, 200);
  victimToken = res.body.data.token;

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('passwordHash'), '不得返回密码哈希');
  assert.ok(!serialized.toLowerCase().includes('victim@example.com'), '默认不返回邮箱');
  assert.equal(res.body.data.user.nickname, '受害者');
});

test('B2: 弱密码、重复邮箱、非法邮箱都被拒', async () => {
  const weak = await call('POST', '/api/auth/register', undefined, {
    email: 'weak@example.com',
    password: '123',
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, 'WEAK_PASSWORD');
  assert.ok(weak.body.error.detail, '应给出具体原因，前端才能提示');

  const dup = await call('POST', '/api/auth/register', undefined, {
    email: 'VICTIM@example.com',
    password: 'ruatrip2026',
  });
  assert.equal(dup.status, 409, '邮箱大小写不敏感');

  const bad = await call('POST', '/api/auth/register', undefined, {
    email: 'not-an-email',
    password: 'ruatrip2026',
  });
  assert.equal(bad.status, 400);
});

test('B2: 登录失败不区分「邮箱不存在」与「密码错误」', async () => {
  const wrongPw = await call('POST', '/api/auth/login', undefined, {
    email: 'victim@example.com',
    password: 'wrongpass1',
  });
  const noUser = await call('POST', '/api/auth/login', undefined, {
    email: 'nobody@example.com',
    password: 'wrongpass1',
  });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.deepEqual(wrongPw.body.error, noUser.body.error, '两者响应必须一致，否则可枚举邮箱');
});

test('B2: 匿名请求一律 401', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/bootstrap', undefined],
    ['GET', '/api/profile', undefined],
    ['GET', '/api/travel', undefined],
    ['POST', '/api/chat', { petId: 'x', text: 'hi' }],
    ['POST', '/api/interact', { petId: 'x', action: 'feed' }],
  ] as const) {
    const res = await call(method, path, undefined, body);
    assert.equal(res.status, 401, `${method} ${path} 应要求登录`);
    assert.equal(res.body.error.code, 'AUTH_REQUIRED');
  }
});

test('B2: 伪造/篡改 token 被拒', async () => {
  const [body] = victimToken.split('.');
  for (const bad of ['garbage', 'a.b', `${victimToken.slice(0, -4)}AAAA`, `${body}.AAAA`]) {
    const res = await call('GET', '/api/auth/me', bad);
    assert.equal(res.status, 401, `应拒绝：${bad.slice(0, 20)}`);
  }
});

test('B2: 受害者创建宠物并打卡', async () => {
  await call('POST', '/api/survey', victimToken, { answers: { species: ['ragdoll'] } });
  const created = await call('POST', '/api/pet', victimToken, { name: 'A的猫' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  victimPetId = created.body.data.pet.id;
  assert.ok(victimPetId);

  const me = await call('GET', '/api/bootstrap', victimToken);
  assert.equal(me.body.data.pet.name, 'A的猫');
});

test('B2: 攻击者不能读到受害者的宠物（全部读接口）', async () => {
  attackerToken = await register('attacker@example.com', '攻击者');

  for (const path of [
    `/api/pet?petId=${victimPetId}`,
    `/api/affection?petId=${victimPetId}`,
    `/api/travel?petId=${victimPetId}`,
    `/api/shop?petId=${victimPetId}`,
    `/api/chat?petId=${victimPetId}`,
    `/api/chat/memories?petId=${victimPetId}`,
    `/api/pet/mood?petId=${victimPetId}`,
    '/api/pet/generation/job-whatever',
  ]) {
    const res = await call('GET', path, attackerToken);
    assert.equal(res.status, 404, `${path} 必须拒绝（返回 404 而非 403，避免泄漏 id 是否存在）`);
  }
});

test('B2: 攻击者不能写受害者的宠物（全部写接口）', async () => {
  const cases: [string, string, unknown][] = [
    ['POST', '/api/interact', { petId: victimPetId, action: 'feed' }],
    ['POST', '/api/interact/pet', { petId: victimPetId, part: 'head' }],
    ['POST', '/api/travel/checkin', { petId: victimPetId, destinationId: 'chengdu' }],
    ['POST', '/api/chat', { petId: victimPetId, text: 'hi' }],
    ['POST', '/api/shop/redeem', { petId: victimPetId, itemId: 'outfit-scarf' }],
    ['PATCH', '/api/pet', { petId: victimPetId, name: 'HACKED' }],
    ['POST', '/api/journal', { petId: victimPetId }],
    ['POST', '/api/postcard', { petId: victimPetId }],
    ['POST', '/api/foster', { petId: victimPetId, friendName: 'x' }],
  ];
  for (const [method, path, body] of cases) {
    const res = await call(method, path, attackerToken, body);
    assert.ok([400, 404].includes(res.status), `${method} ${path} 必须拒绝，实际 ${res.status}`);
  }
});

test('B2: 攻击者不能看受害者的时光胶囊', async () => {
  const res = await call('GET', '/api/capsule/any-id', attackerToken);
  assert.equal(res.status, 404);
});

test('B2: 受害者数据未被篡改，且攻击者空间独立', async () => {
  const victim = await call('GET', '/api/bootstrap', victimToken);
  assert.equal(victim.body.data.pet.name, 'A的猫', '宠物名不得被改');

  const attacker = await call('GET', '/api/bootstrap', attackerToken);
  assert.equal(attacker.body.data.pet, null, '攻击者应看不到任何宠物');
});

test('B2: 改密码后旧 token 立即失效（会话吊销）', async () => {
  const changed = await call('POST', '/api/auth/password', attackerToken, {
    currentPassword: 'ruatrip2026',
    newPassword: 'newpass2026',
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const freshToken = changed.body.data.token as string;

  const oldToken = await call('GET', '/api/auth/me', attackerToken);
  assert.equal(oldToken.status, 401, '旧 token 必须失效');
  assert.equal(oldToken.body.error.code, 'SESSION_REVOKED');

  const newToken = await call('GET', '/api/auth/me', freshToken);
  assert.equal(newToken.status, 200, '新 token 应可用');

  // 改回原密码，避免影响后续用例
  await call('POST', '/api/auth/password', freshToken, {
    currentPassword: 'newpass2026',
    newPassword: 'ruatrip2026',
  });
});

test('B2: 注销账号需要确认串与密码，并清空数据', async () => {
  const token = await register('delete-me@example.com', '待删');
  await call('POST', '/api/survey', token, { answers: { species: ['corgi'] } });
  await call('POST', '/api/pet', token, { name: '要被删掉的猫' });

  const wrongConfirm = await call('DELETE', '/api/auth/account', token, { confirm: 'nope' });
  assert.equal(wrongConfirm.status, 400);
  assert.equal(wrongConfirm.body.error.code, 'CONFIRM_REQUIRED');

  const wrongPw = await call('DELETE', '/api/auth/account', token, {
    confirm: 'DELETE',
    password: 'wrongpass1',
  });
  assert.equal(wrongPw.status, 401);

  const ok = await call('DELETE', '/api/auth/account', token, {
    confirm: 'DELETE',
    password: 'ruatrip2026',
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.deleted, true);

  const afterDelete = await call('GET', '/api/auth/me', token);
  assert.equal(afterDelete.status, 401, '注销后 token 不得可用');

  // 邮箱应可再次注册（说明账号真的被清掉了）
  const reRegister = await call('POST', '/api/auth/register', undefined, {
    email: 'delete-me@example.com',
    password: 'ruatrip2026',
  });
  assert.equal(reRegister.status, 200);
});

test('F6: 宠物位配额生效（免费档只能 1 只）', async () => {
  const token = await register('slots@example.com', '配额测试');
  await call('POST', '/api/survey', token, { answers: { species: ['corgi'] } });

  const first = await call('POST', '/api/pet', token, { name: '第一只' });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await call('POST', '/api/pet', token, { name: '第二只' });
  assert.equal(second.status, 403, '免费档第 2 只必须被拒');
  assert.equal(second.body.error.code, 'PET_SLOT_LIMIT');
  assert.match(second.body.error.detail ?? '', /Plus/, '应告诉用户怎么解决（订阅）');
});

test('F6: 消费限额对订阅生效，且降级受宠物数约束', async () => {
  const token = await register('spend@example.com', '限额测试');
  await call('POST', '/api/survey', token, { answers: { species: ['ragdoll'] } });

  // 默认开启未成年人保护：单笔 398 的年度 Pro 必须被拒
  const tooBig = await call('POST', '/api/subscribe', token, { tier: 'pro', cycle: 'yearly' });
  assert.equal(tooBig.status, 403);
  assert.equal(tooBig.body.error.code, 'MINOR_SINGLE_PURCHASE_LIMIT');

  // 单笔 25 的 Plus 月付允许（模拟开通）
  const ok = await call('POST', '/api/subscribe', token, { tier: 'plus', cycle: 'monthly' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.simulated, true, '未接支付时必须明确标注模拟');
  assert.equal(ok.body.data.user.tier, 'plus');

  // 建 2 只（Plus 允许 3 只），然后尝试降到 free 应被拒
  await call('POST', '/api/pet', token, { name: '甲' });
  await call('POST', '/api/pet', token, { name: '乙' });
  const downgrade = await call('POST', '/api/subscribe', token, { tier: 'free', cycle: 'monthly' });
  assert.equal(downgrade.status, 409);
  assert.equal(downgrade.body.error.code, 'TIER_DOWNGRADE_BLOCKED');
});

test('F6: profile 暴露计费状态，且生效限额与校验一致', async () => {
  const token = await register('billing@example.com', '计费展示');
  const res = await call('GET', '/api/profile', token);
  const billing = res.body.data.billing;

  assert.equal(billing.minorGuardEnabled, true);
  assert.equal(billing.effectiveLimit, 200, '未超硬上限时等于用户设置值');
  assert.equal(billing.singlePurchaseCap, 50, '未成年人有单笔上限');
  assert.equal(billing.paymentConfigured, false, '未接支付');
  assert.ok(res.body.data.planLimits.petSlots.free === 1);
});

test('B2: /api/auth/status 不泄漏账号信息，只给必要布尔量', async () => {
  const res = await call('GET', '/api/auth/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.hasAccounts, true);
  assert.equal(res.body.data.requiresSetup, false);
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('@'), '不应返回任何邮箱');
});
