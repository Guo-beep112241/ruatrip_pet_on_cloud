/**
 * 安全模块回归测试。
 *
 * 每个用例都对应审计里的一条真实缺陷（docs/PRE-LAUNCH-AUDIT.md）：
 *   S1 SVG 注入、S2 CORS 通配、S3 敏感路径探测、S4 安全响应头、S5 限流
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeXmlViaRender, renderPetSvg, safePalette, safeSpecies } from '../src/services/petArt.ts';
import { applyCors, contentSecurityPolicy } from '../src/http/security.ts';
import { DailyQuota, LocalRateLimitStore, clientKey, ruleFor } from '../src/http/rateLimit.ts';

/* ============================================================
 * S1 —— SVG 注入
 * ============================================================ */

test('S1: species 参数只接受白名单值，注入 payload 一律回落默认', () => {
  for (const evil of [
    '</text><script>alert(1)</script>',
    'ragdoll"><script>x</script>',
    '../etc/passwd',
    'RAGDOLL', // 大小写也不放过
    '',
    null,
    undefined,
  ]) {
    const result = safeSpecies(evil as string);
    assert.ok(
      ['ragdoll', 'corgi', 'shiba', 'bunny', 'hamster', 'fox', 'fawn', 'capybara', 'alpaca', 'bird', 'chimera']
        .includes(result),
      `非白名单值未被拦截：${String(evil)} → ${result}`,
    );
  }
  assert.equal(safeSpecies('capybara'), 'capybara', '合法值必须原样保留');
});

test('S1: palette 过滤非法颜色 key，并补足最少两色', () => {
  assert.deepEqual(safePalette(['oat', 'coral']), ['oat', 'coral']);
  assert.deepEqual(safePalette(['<script>', 'oat']), ['oat', 'chestnut']);
  assert.deepEqual(safePalette([]), ['oat', 'chestnut']);
  assert.deepEqual(safePalette(null), ['oat', 'chestnut']);
  // 渲染层只用两个主色（c1/c2），所以过滤后最多保留 2 个，多余的丢弃
  assert.equal(safePalette(['a', 'b', 'c', 'd', 'e']).length, 2, '未知 key 全被丢弃后补足两个默认色');
  assert.deepEqual(safePalette(['oat']), ['oat', 'chestnut'], '单个合法值要补齐第二个');
  assert.deepEqual(safePalette(['oat', 'coral', 'sage']).slice(0, 2), ['oat', 'coral']);
});

test('S1: 渲染结果里绝不含可执行的 script/事件属性', () => {
  const svg = renderPetSvg({
    species: '</text><script>alert(1)</script>',
    palette: ['"><script>alert(2)</script>'],
    name: '"><script>alert(3)</script>',
  });
  assert.ok(!svg.includes('<script'), '不得出现 script 标签');
  assert.ok(!/on\w+\s*=/i.test(svg), '不得出现事件处理属性');
  assert.ok(svg.startsWith('<svg'), '仍应输出合法 SVG');
  assert.ok(svg.includes('</svg>'));

  // 注意：payload 的「文本」仍会出现在 aria-label 里，但必须是实体转义后的形态，
  // 所以这里断言的是「不可执行」而不是「字符串不存在」。
  assert.ok(svg.includes('&lt;script&gt;'), '尖括号必须被实体化成不可解析的形态');
  assert.ok(!/<script[\s>]/i.test(svg), '不存在可作为标签解析的 script');
  // 关键：引号已转义，payload 无法闭合属性
  const label = /aria-label="([^"]*)"/.exec(svg)?.[1] ?? '';
  assert.ok(!label.includes('"'), '属性值内不得出现裸引号');
});

test('S1: 名字被转义且截断，不会撑爆响应', () => {
  const svg = renderPetSvg({ species: 'ragdoll', palette: ['oat'], name: 'A'.repeat(5000) });
  const label = /aria-label="([^"]*)"/.exec(svg)?.[1] ?? '';
  assert.ok(label.length <= 24, `名字未截断：${label.length}`);
  assert.ok(svg.length < 12_000, `响应体异常膨胀：${svg.length}`);

  const quoted = renderPetSvg({ species: 'ragdoll', palette: ['oat'], name: '" onload="alert(1)' });
  assert.ok(!/onload=/.test(quoted) || !quoted.includes('onload="alert'), '引号必须被转义');
});

test('escapeXmlViaRender: 关键字符都被实体化', () => {
  const out = escapeXmlViaRender(`<>&"'`);
  assert.equal(out, '&lt;&gt;&amp;&quot;&apos;');
});

/* ============================================================
 * S2 —— CORS
 * ============================================================ */

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    writeHead(_status: number) { /* noop */ },
    end() { /* noop */ },
  };
}

test('S2: 白名单内来源回显 origin 并允许凭证', () => {
  const res = fakeRes();
  applyCors(res, 'https://ruatrip.com', ['https://ruatrip.com'], 'GET');
  assert.equal(res.headers['access-control-allow-origin'], 'https://ruatrip.com');
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
});

test('S2: 白名单外来源不设任何 ACAO 头（旧实现会回落成 *）', () => {
  const res = fakeRes();
  applyCors(res, 'https://evil.example.com', ['https://ruatrip.com'], 'GET');
  assert.equal(res.headers['access-control-allow-origin'], undefined, '绝不能回显或通配');
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
});

test('S2: 配了 * 时通配，但不允许 credentials（规范要求）', () => {
  const res = fakeRes();
  applyCors(res, 'https://anything.example.com', ['*'], 'GET');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['access-control-allow-credentials'], undefined, '* 不能与 credentials 共存');
});

test('S2: 预检请求被直接结束，且带 Vary: Origin 防止缓存串号', () => {
  const res = fakeRes();
  const out = applyCors(res, 'https://ruatrip.com', ['https://ruatrip.com'], 'OPTIONS');
  assert.equal(out.preflightHandled, true);
  assert.match(res.headers.vary ?? '', /Origin/i);
});

/* ============================================================
 * S4 —— 安全响应头
 * ============================================================ */

test('S4: 前端 CSP 不含 unsafe-eval，且允许必要的 data: 与字体源', () => {
  const csp = contentSecurityPolicy(['https://api.ruatrip.com']);
  assert.ok(!csp.includes('unsafe-eval'), 'CSP 不应放开 unsafe-eval');
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes('img-src') && csp.includes('data:'), '合成图/降级 SVG 是 data URL，必须允许');
  assert.ok(csp.includes('fonts.gstatic.com'), 'Quicksand 字体来自 Google Fonts');
  assert.ok(csp.includes('https://api.ruatrip.com'), '前后端分离部署时要能连后端');
  assert.ok(csp.includes("frame-ancestors 'none'"), '防点击劫持');
  assert.ok(csp.includes("object-src 'none'"));
});

/* ============================================================
 * S5 —— 限流与成本闸门
 * ============================================================ */

test('S5: 滑动窗口在额度内放行，超出后拒绝并给出重试时间', () => {
  const store = new LocalRateLimitStore();
  const rule = { windowMs: 1000, max: 3 };
  const now = 1_000_000;

  for (let i = 0; i < 3; i += 1) {
    const r = store.hit('k', rule, now + i);
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = store.hit('k', rule, now + 3);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);

  // 窗口滑过后恢复
  assert.equal(store.hit('k', rule, now + 1100).allowed, true);
});

test('S5: 不同 key 互不影响（多用户不互相踩）', () => {
  const store = new LocalRateLimitStore();
  const rule = { windowMs: 1000, max: 1 };
  assert.equal(store.hit('userA', rule, 0).allowed, true);
  assert.equal(store.hit('userB', rule, 0).allowed, true, 'B 不应被 A 的额度影响');
  assert.equal(store.hit('userA', rule, 1).allowed, false);
});

test('S5: 昂贵接口的额度明显严于普通读接口', () => {
  const chat = ruleFor('api:chat');
  const read = ruleFor('api:read');
  const petCreate = ruleFor('api:pet:create');
  assert.ok(chat.max < read.max, '对话额度必须比普通读更严');
  assert.ok(petCreate.windowMs >= 60 * 60_000, '3D 生成要按小时限，避免一小时刷几十次');
  assert.ok(petCreate.max <= 5);
});

test('S5: 未知分桶回落到读额度，不会意外放行', () => {
  assert.deepEqual(ruleFor('api:not-exist'), ruleFor('api:read'));
});

test('S5: clientKey 优先用 userId，其次取 X-Forwarded-For 的第一跳', () => {
  assert.equal(clientKey({ headers: {} }, 'user-1'), 'u:user-1');
  assert.equal(
    clientKey({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }, null),
    'ip:1.2.3.4',
    '取第一跳（真实客户端），不是最后一跳（可能是代理）',
  );
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }, null), 'ip:9.9.9.9');
  assert.equal(clientKey({ headers: {} }, null), 'ip:unknown');
});

test('S5: 每日闸门在跨天后自动重置', () => {
  const quota = new DailyQuota({ chat: 2 });
  const day1 = new Date('2026-01-01T10:00:00Z');
  assert.equal(quota.consume('u1', 'chat', day1).allowed, true);
  assert.equal(quota.consume('u1', 'chat', day1).allowed, true);
  const third = quota.consume('u1', 'chat', day1);
  assert.equal(third.allowed, false, '超过每日额度必须拒绝');
  assert.equal(third.used, 2);

  const day2 = new Date('2026-01-02T00:01:00Z');
  assert.equal(quota.consume('u1', 'chat', day2).allowed, true, '新的一天应重置');
});

test('S5: 每日闸门按用户隔离', () => {
  const quota = new DailyQuota({ chat: 1 });
  const now = new Date('2026-01-01T10:00:00Z');
  assert.equal(quota.consume('u1', 'chat', now).allowed, true);
  assert.equal(quota.consume('u1', 'chat', now).allowed, false);
  assert.equal(quota.consume('u2', 'chat', now).allowed, true, 'u2 有自己的额度');
});

test('S5: 未声明的能力默认不限量（不会误伤）', () => {
  const quota = new DailyQuota({ chat: 1 });
  const now = new Date('2026-01-01T10:00:00Z');
  for (let i = 0; i < 50; i += 1) {
    assert.equal(quota.consume('u1', 'unknown-kind', now).allowed, true);
  }
});
