/**
 * 结构化日志与错误码映射测试（审计 O3）。
 *
 * 这两块都属于「平时不起眼、出事时决定能不能快速定位」的基础设施，
 * 所以重点测「会不会泄漏敏感信息」与「错误分级是否正确」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Logger, redact, sanitizeClientReport, createLogger } from '../src/http/logger.ts';
import { KNOWN_ERROR_CODES, statusForErrorCode } from '../src/http/errors.ts';

/* ============================================================
 * 脱敏
 * ============================================================ */

test('O3: 密钥类字段被脱敏', () => {
  const out = redact({
    LLM_API_KEY: 'sk-real-key',
    password: 'ruatrip2026',
    authorization: 'Bearer abc',
    sessionSecret: 'topsecret',
    privateKey: 'xxx',
    accessKeyId: 'AKIA',
  }) as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    assert.equal(out[key], '[redacted]', `${key} 应被脱敏`);
  }
});

test('O3: 用户内容类字段被脱敏（对话与照片不进日志）', () => {
  const out = redact({
    text: '我今天被老板骂了',
    content: '宠物回复',
    prompt: '系统提示词',
    photoUrl: 'data:image/png;base64,AAAA',
    image: 'binary',
    nested: { text: '嵌套的对话' },
  }) as Record<string, unknown>;
  assert.equal(out.text, '[redacted]');
  assert.equal(out.content, '[redacted]');
  assert.equal(out.prompt, '[redacted]');
  assert.equal(out.photoUrl, '[redacted]');
  assert.equal(out.image, '[redacted]');
  assert.deepEqual(out.nested, { text: '[redacted]' }, '嵌套层也要脱敏');
});

test('O3: 非敏感字段保留，但长字符串被截断', () => {
  const out = redact({ gain: 8, level: 2, ok: true, note: 'x'.repeat(500) }) as Record<string, unknown>;
  assert.equal(out.gain, 8);
  assert.equal(out.level, 2);
  assert.equal(out.ok, true);
  assert.ok(String(out.note).length < 300, '长字符串应被截断');
  assert.match(String(out.note), /\[\+300\]/);
});

test('O3: 数组长度受限，避免日志被灌爆', () => {
  const out = redact({ list: Array.from({ length: 100 }, (_, i) => i) }) as Record<string, unknown>;
  assert.equal((out.list as unknown[]).length, 20);
});

test('O3: 循环引用不会导致栈溢出', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  assert.doesNotThrow(() => redact(a));
});

/* ============================================================
 * Logger 行为
 * ============================================================ */

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  console.warn = (...a: unknown[]) => lines.push(a.join(' '));
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
  return lines;
}

test('O3: 生产环境输出可解析的 JSON Lines', () => {
  const log = createLogger('production');
  const lines = capture(() => log.info('test event', { gain: 5, requestId: 'abc123' }));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'test event');
  assert.equal(parsed.gain, 5);
  assert.equal(parsed.requestId, 'abc123');
  assert.ok(typeof parsed.time === 'string', '必须带时间戳');
});

test('O3: 生产环境不出 debug，开发环境出', () => {
  assert.equal(capture(() => createLogger('production').debug('x')).length, 0);
  assert.equal(capture(() => createLogger('development').debug('x')).length, 1);
});

test('O3: 开发环境是人类可读格式，不是 JSON', () => {
  const lines = capture(() => createLogger('development').warn('注意', { path: '/api/x' }));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.startsWith('{'), '开发环境不该输出 JSON');
  assert.match(lines[0]!, /注意/);
  assert.match(lines[0]!, /path=\/api\/x/);
});

test('O3: child 绑定固定字段（例如 requestId）', () => {
  const lines = capture(() => {
    const child = new Logger({ pretty: false }).child({ requestId: 'req-1' });
    child.info('scoped');
  });
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.requestId, 'req-1');
});

/* ============================================================
 * 前端上报校验
 * ============================================================ */

test('O3: 合法上报被接受并限长', () => {
  const report = sanitizeClientReport({
    errorMessage: 'Cannot read properties of undefined',
    trail: ['open cabin', 'tap feed'],
    url: '/cabin',
    userAgent: 'Mozilla/5.0',
    at: 1_700_000_000_000,
  });
  assert.ok(report);
  assert.equal(report.errorMessage, 'Cannot read properties of undefined');
  assert.deepEqual(report.trail, ['open cabin', 'tap feed']);
});

test('O3: 上报字段被限长（不信任客户端）', () => {
  const report = sanitizeClientReport({
    errorMessage: 'x'.repeat(2000),
    trail: Array.from({ length: 50 }, (_, i) => `step-${i}`),
    url: 'y'.repeat(1000),
  });
  assert.ok(report);
  assert.equal(report.errorMessage.length, 500);
  assert.equal(report.trail?.length, 20);
  assert.equal(report.url?.length, 300);
});

test('O3: 缺崩溃信息的上报被拒（避免被当垃圾桶）', () => {
  assert.equal(sanitizeClientReport(null), null);
  assert.equal(sanitizeClientReport('string'), null);
  assert.equal(sanitizeClientReport({}), null);
  assert.equal(sanitizeClientReport({ errorMessage: '' }), null);
  assert.equal(sanitizeClientReport({ errorMessage: '   ' }), null);
});

test('O3: trail 里的非字符串被过滤掉', () => {
  const report = sanitizeClientReport({ errorMessage: 'boom', trail: ['ok', 1, null, { a: 1 }, 'ok2'] });
  assert.deepEqual(report?.trail, ['ok', 'ok2']);
});

/* ============================================================
 * 错误码 → 状态码
 * ============================================================ */

test('O3: 业务错误映射为 4xx 而不是 500', () => {
  const cases: [string, number][] = [
    ['NOT_ENOUGH_AFFECTION', 400],
    ['PET_SLOT_LIMIT', 403],
    ['MINOR_SINGLE_PURCHASE_LIMIT', 403],
    ['SPEND_LIMIT_EXCEEDED', 403],
    ['PET_NOT_FOUND', 404],
    ['DESTINATION_NOT_FOUND', 404],
    ['EMAIL_TAKEN', 409],
    ['DAILY_QUOTA_EXCEEDED', 429],
    ['LIMIT_REACHED', 429],
    ['AUTH_REQUIRED', 401],
    ['VALIDATION_FAILED', 400],
  ];
  for (const [code, expected] of cases) {
    assert.equal(statusForErrorCode(code), expected, `${code} 应为 ${expected}`);
  }
});

test('O3: 显式 status 优先于映射表', () => {
  assert.equal(statusForErrorCode('PET_NOT_FOUND', 410), 410);
});

test('O3: 上游依赖故障映射为 502（不是用户的错）', () => {
  assert.equal(statusForErrorCode('LLM_AUTH_FAILED'), 502);
  assert.equal(statusForErrorCode('PG_NOT_INSTALLED'), 502);
});

test('O3: 未知错误码回落 500（会被记录以便补登记）', () => {
  assert.equal(statusForErrorCode('SOMETHING_NEW'), 500);
  assert.equal(KNOWN_ERROR_CODES.has('SOMETHING_NEW'), false);
});

test('O3: 已知错误码不会退化成 500', () => {
  for (const code of KNOWN_ERROR_CODES) {
    assert.notEqual(statusForErrorCode(code), 500, `${code} 不该映射到 500`);
  }
});
