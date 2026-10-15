/**
 * 认证模块测试（审计 B2）。
 *
 * 覆盖密码哈希、强度校验、邮箱规范化、无状态会话签名，
 * 以及「生产环境用可预测密钥」这类会导致鉴权失效的配置错误。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_TTL_MS,
  assertPasswordStrength,
  createDefaultProfile,
  hashPassword,
  issueSession,
  newUserId,
  normalizeEmail,
  passwordIssues,
  publicProfile,
  resolveSessionSecret,
  verifyPassword,
  verifySession,
  type AccountRecord,
} from '../src/auth/index.ts';

const SECRET = 'a'.repeat(32);

/* ============================================================
 * 密码
 * ============================================================ */

test('B2: 密码哈希可验证，且每次加盐不同', async () => {
  const hashA = await hashPassword('ruatrip2026');
  const hashB = await hashPassword('ruatrip2026');

  assert.notEqual(hashA, hashB, '同一密码两次哈希必须不同（盐不同）');
  assert.ok(hashA.startsWith('scrypt$'), `格式不对：${hashA.slice(0, 20)}`);
  assert.equal(await verifyPassword('ruatrip2026', hashA), true);
  assert.equal(await verifyPassword('ruatrip2026', hashB), true);
});

test('B2: 错误密码一律拒绝', async () => {
  const hash = await hashPassword('ruatrip2026');
  for (const wrong of ['ruatrip2027', 'Ruatrip2026', 'ruatrip202', '', 'ruatrip2026 ']) {
    assert.equal(await verifyPassword(wrong, hash), false, `应拒绝：${JSON.stringify(wrong)}`);
  }
});

test('B2: 篡改哈希内容会被拒绝（改盐或改摘要）', async () => {
  const hash = await hashPassword('ruatrip2026');
  const [algo, n, r, p, salt, digest] = hash.split('$');

  // 改摘要：整体替换一个不同字节的 base64，确保长度不变
  const flipped = Buffer.from(digest!, 'base64');
  flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
  const tamperedDigest = [algo, n, r, p, salt, flipped.toString('base64')].join('$');
  assert.equal(await verifyPassword('ruatrip2026', tamperedDigest), false, '改摘要必须失败');

  // 改盐 → 派生结果不同
  const otherSalt = Buffer.from(salt!, 'base64');
  otherSalt[0] = (otherSalt[0]! ^ 0xff) & 0xff;
  const tamperedSalt = [algo, n, r, p, otherSalt.toString('base64'), digest].join('$');
  assert.equal(await verifyPassword('ruatrip2026', tamperedSalt), false, '改盐必须失败');

  // 改参数 → 派生结果不同
  const tamperedParams = [algo, '32768', r, p, salt, digest].join('$');
  assert.equal(await verifyPassword('ruatrip2026', tamperedParams), false, '改成本参数必须失败');
});

test('B2: 畸形哈希不会抛异常（避免被当成 500 探测）', async () => {
  for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5', 'scrypt$a$b$c$d$e', 'scrypt$$$$$']) {
    const result = await verifyPassword('anything', bad);
    assert.equal(result, false, `应安全返回 false：${bad}`);
  }
});

test('B2: 弱密码被拒绝', () => {
  for (const weak of ['123', '1234567', '12345678', 'abcdefgh', 'ABCDEFGH', '!@#$%^&*']) {
    assert.throws(() => assertPasswordStrength(weak), /WEAK_PASSWORD/, `应拒绝：${weak}`);
  }
  // 字母 + 数字/符号 且 >= 8 位 → 通过
  for (const ok of ['ruatrip2026', 'a1b2c3d4', 'pass-word', 'Passw0rd!']) {
    assert.doesNotThrow(() => assertPasswordStrength(ok), `不应拒绝：${ok}`);
  }
});

test('B2: 超长密码被拒绝（避免 DoS）', () => {
  assert.throws(() => assertPasswordStrength(`a1${'x'.repeat(500)}`), /WEAK_PASSWORD/);
});

test('B2: passwordIssues 与 assertPasswordStrength 判断一致', () => {
  assert.deepEqual(passwordIssues('ruatrip2026'), []);
  assert.ok(passwordIssues('123').length >= 2);
  for (const pw of ['123', '12345678', 'abcdefgh', 'ok-pass1']) {
    const issues = passwordIssues(pw);
    let threw = false;
    try {
      assertPasswordStrength(pw);
    } catch {
      threw = true;
    }
    assert.equal(threw, issues.length > 0, `两者判断不一致：${pw}`);
  }
});

/* ============================================================
 * 邮箱
 * ============================================================ */

test('B2: 邮箱规范化统一小写并去空格', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.equal(normalizeEmail('a@b.co'), 'a@b.co');
});

test('B2: 非法邮箱被拒绝', () => {
  for (const bad of ['', 'not-an-email', 'a@b', '@b.com', 'a@.com', 'a b@c.com', 'a@b..com', 123, null, undefined]) {
    assert.throws(() => normalizeEmail(bad), /INVALID_EMAIL/, `应拒绝：${String(bad)}`);
  }
});

/* ============================================================
 * 会话
 * ============================================================ */

test('B2: 签发的 token 可校验并携带用户与密码版本', () => {
  const token = issueSession({ userId: 'u-1', passwordVersion: 4 }, SECRET);
  const verdict = verifySession(token, SECRET);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.payload.userId, 'u-1');
    assert.equal(verdict.payload.pwv, 4, '密码版本用于改密码后吊销旧 token');
    assert.ok(verdict.payload.exp > Date.now());
  }
});

test('B2: 换密钥、篡改内容、篡改签名都会被拒', () => {
  const token = issueSession({ userId: 'u-1', passwordVersion: 0 }, SECRET);
  const [body, signature] = token.split('.');

  assert.equal(verifySession(token, 'b'.repeat(32)).ok, false, '换密钥必须失败');

  // 篡改 payload：换成另一个用户，必须因签名不符而失败
  const forgedBody = Buffer.from(JSON.stringify({ userId: 'u-2', pwv: 0, iat: Date.now(), exp: Date.now() + 1000 })).toString('base64url');
  assert.equal(verifySession(`${forgedBody}.${signature}`, SECRET).ok, false, '伪造 userId 必须失败');

  // 篡改签名
  const flipped = Buffer.from(signature!, 'base64url');
  flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
  assert.equal(verifySession(`${body}.${flipped.toString('base64url')}`, SECRET).ok, false);
});

test('B2: 畸形与过期 token 给出明确原因', () => {
  assert.deepEqual(verifySession('nodot', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifySession('', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifySession('.', SECRET), { ok: false, reason: 'malformed' });

  const expired = issueSession({ userId: 'u-1', passwordVersion: 0 }, SECRET, Date.now() - SESSION_TTL_MS - 1000);
  assert.deepEqual(verifySession(expired, SECRET), { ok: false, reason: 'expired' });
});

test('B2: 会话密钥策略 —— 生产缺密钥必须拒绝启动', () => {
  assert.throws(
    () => resolveSessionSecret({ secret: '', isProduction: true }),
    /SESSION_SECRET_MISSING/,
    '生产环境绝不能用可预测/随机密钥，否则多实例与重启后会话全失效',
  );
  assert.throws(
    () => resolveSessionSecret({ secret: 'too-short', isProduction: false }),
    /SESSION_SECRET_TOO_SHORT/,
  );

  // 开发环境未配置时自动生成，保证开箱即跑
  const dev = resolveSessionSecret({ secret: '', isProduction: false });
  assert.ok(dev.length >= 32);

  // 配置合规时原样使用
  assert.equal(resolveSessionSecret({ secret: SECRET, isProduction: true }), SECRET);
});

/* ============================================================
 * 账号记录
 * ============================================================ */

test('B2: 对外只暴露 profile，绝不带凭据', () => {
  const account: AccountRecord = {
    id: 'u-1',
    email: 'alice@example.com',
    passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    passwordVersion: 0,
    profile: createDefaultProfile({ id: 'u-1', nickname: '小满' }),
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  const exposed = publicProfile(account);
  const asJson = JSON.stringify(exposed);

  assert.ok(!asJson.includes('scrypt'), '不得暴露密码哈希');
  assert.ok(!asJson.includes('passwordHash'));
  assert.ok(!asJson.includes('alice@example.com'), '邮箱属于凭据信息，默认不对外暴露');
  assert.equal(exposed.nickname, '小满');
  assert.equal(exposed.id, 'u-1');
});

test('B2: 默认档案按订阅档位分配宠物位，并默认开启未成年人保护', () => {
  assert.equal(createDefaultProfile({ id: 'u1' }).petSlots, 1);
  assert.equal(createDefaultProfile({ id: 'u1', tier: 'plus' }).petSlots, 3);
  assert.equal(createDefaultProfile({ id: 'u1', tier: 'pro' }).petSlots, 6);
  assert.equal(createDefaultProfile({ id: 'u1' }).minorGuardEnabled, true, '默认开启更安全');
  assert.equal(createDefaultProfile({ id: 'u1', nickname: '   ' }).nickname, '毛绒屋主人', '空昵称回落默认');
});

test('B2: 用户 ID 唯一且有前缀', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newUserId()));
  assert.equal(ids.size, 200, 'ID 不得重复');
  for (const id of ids) assert.match(id, /^u-[a-z0-9]+-[a-f0-9]{8}$/);
});
