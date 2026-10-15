/**
 * 请求体校验器测试（审计 M1）。
 *
 * 修复前路由里全是 `ctx.body as {...}` —— 类型断言不是校验，
 * 客户端传错类型会一路流到业务层变成难排查的 500。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ValidationError, validate, validateQuery, type Schema } from '../src/http/validate.ts';

test('M1: 必填字段缺失时报出字段名与可读原因', () => {
  const schema = { email: { type: 'string', label: '邮箱', required: true } } satisfies Schema;
  assert.throws(
    () => validate({}, schema),
    (e: unknown) =>
      e instanceof ValidationError && e.issues[0]?.field === 'email' && /缺少 邮箱/.test(e.issues[0].message),
  );
});

test('M1: 类型不符被拒（断言不会拦住 123 这种值）', () => {
  const schema = { petId: { type: 'string', label: 'petId', required: true } } satisfies Schema;
  assert.throws(() => validate({ petId: 123 }, schema), ValidationError);
  assert.throws(() => validate({ petId: true }, schema), ValidationError);
  assert.throws(() => validate({ petId: {} }, schema), ValidationError);
  assert.throws(() => validate({ petId: [] }, schema), ValidationError);
  assert.equal(validate({ petId: 'ok' }, schema).petId, 'ok');
});

test('M1: 非对象请求体一律拒绝（否则必填校验会被绕过）', () => {
  const schema = { petId: { type: 'string', required: true } } satisfies Schema;
  for (const bad of ['"a string"', [1, 2], 42, true]) {
    assert.throws(() => validate(bad, schema), ValidationError, `应拒绝：${JSON.stringify(bad)}`);
  }
  // null / undefined 视为空对象 → 命中的是「缺少字段」而不是「类型错」
  assert.throws(() => validate(null, schema), ValidationError);
  assert.throws(() => validate(undefined, schema), ValidationError);
});

test('M1: 长度限制与 trim', () => {
  const schema = { name: { type: 'string', label: '名字', min: 1, max: 12, required: true } } satisfies Schema;
  assert.equal(validate({ name: '  汤圆  ' }, schema).name, '汤圆', '应 trim');
  assert.throws(() => validate({ name: '' }, schema), ValidationError, '空字符串不满足 min');
  assert.throws(() => validate({ name: 'x'.repeat(13) }, schema), ValidationError);
});

test('M1: 枚举只接受白名单值', () => {
  const schema = { action: { type: 'enum', values: ['feed', 'bathe', 'play'] as const, label: '互动类型', required: true } } satisfies Schema;
  assert.equal(validate({ action: 'feed' }, schema).action, 'feed');
  assert.throws(
    () => validate({ action: 'drop-table' }, schema),
    (e: unknown) => e instanceof ValidationError && /只能是 feed \/ bathe \/ play/.test(e.issues[0]!.message),
  );
  assert.throws(() => validate({ action: 'FEED' }, schema), ValidationError, '大小写敏感');
});

test('M1: 数字范围与整数校验，兼容字符串数字', () => {
  const schema = {
    lat: { type: 'number', label: '纬度', min: -90, max: 90 },
    days: { type: 'number', label: '天数', min: 1, max: 14, integer: true },
  } satisfies Schema;
  assert.equal(validate({ lat: '31.2' }, schema).lat, 31.2, '表单字符串数字应被接受');
  assert.equal(validate({ lat: 0 }, schema).lat, 0);
  assert.throws(() => validate({ lat: 999 }, schema), ValidationError);
  assert.throws(() => validate({ lat: -91 }, schema), ValidationError);
  assert.throws(() => validate({ lat: 'abc' }, schema), ValidationError);
  assert.throws(() => validate({ lat: Number.NaN }, schema), ValidationError);
  assert.throws(() => validate({ days: 3.5 }, schema), ValidationError, '非整数应被拒');
});

test('M1: 布尔字段兼容表单写法', () => {
  const schema = { flag: { type: 'boolean' } } satisfies Schema;
  assert.equal(validate({ flag: true }, schema).flag, true);
  assert.equal(validate({ flag: 'true' }, schema).flag, true);
  assert.equal(validate({ flag: '1' }, schema).flag, true);
  assert.equal(validate({ flag: 'false' }, schema).flag, false);
  assert.equal(validate({ flag: '0' }, schema).flag, false);
  assert.throws(() => validate({ flag: 'maybe' }, schema), ValidationError);
});

test('M1: 字符串数组有项数与单项长度限制', () => {
  const schema = { tags: { type: 'stringArray', label: '标签', maxItems: 3, maxLength: 5 } } satisfies Schema;
  assert.deepEqual(validate({ tags: ['a', 'b'] }, schema).tags, ['a', 'b']);
  assert.deepEqual(validate({ tags: [' a ', ''] }, schema).tags, ['a'], 'trim 后丢弃空项');
  assert.throws(() => validate({ tags: ['a', 'b', 'c', 'd'] }, schema), ValidationError);
  assert.throws(() => validate({ tags: [1, 2] }, schema), ValidationError);
  assert.throws(() => validate({ tags: 'not-array' }, schema), ValidationError);
  assert.throws(() => validate({ tags: ['toolongvalue'] }, schema), ValidationError);
});

test('M1: 未知字段被丢弃 —— 这是权限提升的防线', () => {
  const schema = { nickname: { type: 'string', label: '昵称', max: 24 } } satisfies Schema;
  const out = validate({ nickname: '正常', tier: 'pro', petSlots: 99, ownerId: 'someone-else' }, schema);
  assert.deepEqual(Object.keys(out), ['nickname'], '未声明的字段不得进入结果');
  assert.equal((out as Record<string, unknown>).tier, undefined);
});

test('M1: 非必填未传时从结果里省略（而不是塞 undefined）', () => {
  const schema = {
    a: { type: 'string' },
    b: { type: 'string', required: true },
  } satisfies Schema;
  const out = validate({ b: 'x' }, schema);
  assert.equal('a' in out, false, '未传的非必填字段不该出现在结果里');
  assert.equal(out.b, 'x');
});

test('M1: nullableString 与 imageRef 接受 null', () => {
  const schema = {
    outfitId: { type: 'nullableString', label: '服饰', max: 10 },
    photoUrl: { type: 'imageRef', label: '照片' },
  } satisfies Schema;
  assert.equal(validate({ outfitId: null }, schema).outfitId, null);
  assert.equal(validate({ photoUrl: null }, schema).photoUrl, null);
  assert.equal(validate({ photoUrl: '/api/uploads/u/a.png' }, schema).photoUrl, '/api/uploads/u/a.png');
  assert.throws(() => validate({ outfitId: 123 }, schema), ValidationError);
  assert.throws(() => validate({ photoUrl: { url: 'x' } }, schema), ValidationError);
});

test('M1: 超大内嵌图在 schema 层就被拒（避免 8MB 走到底层）', () => {
  const schema = { photoUrl: { type: 'imageRef', label: '照片' } } satisfies Schema;
  const huge = `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`;
  assert.throws(
    () => validate({ photoUrl: huge }, schema),
    (e: unknown) => e instanceof ValidationError && /太大了/.test(e.issues[0]!.message),
  );
});

test('M1: 多个字段同时出错时一次性报全（减少来回试错）', () => {
  const schema = {
    email: { type: 'string', label: '邮箱', required: true },
    password: { type: 'string', label: '密码', min: 8, required: true },
  } satisfies Schema;
  try {
    validate({ password: '123' }, schema);
    assert.fail('应当抛出');
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.equal(e.issues.length, 2, '两个字段的问题都要报出来');
    assert.ok(e.message.includes('邮箱') && e.message.includes('密码'));
  }
});

test('M1: validateQuery 从 URL 读取并校验', () => {
  const schema = { petId: { type: 'string', label: 'petId', required: true, max: 64 } } satisfies Schema;
  assert.equal(validateQuery(new URL('http://x/api/pet?petId=abc'), schema).petId, 'abc');
  assert.throws(() => validateQuery(new URL('http://x/api/pet'), schema), ValidationError, '缺参数应报错');
});

test('M1: 错误对象带 issues，前端可逐字段标红', () => {
  const schema = { a: { type: 'string', label: 'A', required: true } } satisfies Schema;
  try {
    validate({}, schema);
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.equal(e.status, 400, '校验失败必须是 400 而不是 500');
    assert.deepEqual(e.issues[0], { field: 'a', message: '缺少 A' });
  }
});
