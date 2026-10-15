/**
 * 接入面板一致性测试。
 *
 * 这类测试不常见，但本项目需要它：
 * 「我的 → 能力接入」面板是用户决定「该填哪些 key」的唯一入口，
 * 一旦面板给出的变量名与代码实际读取的不一致，用户填了也不生效，
 * 而他会以为是服务商的问题 —— 这种错误极难自查。
 *
 * 曾经真实发生过：推送面板写 PUSH_SERVER_KEY，代码读的是 PUSH_VAPID_PRIVATE_KEY；
 * 支付/存储/推送/埋点四项已经实现，面板却写死「尚未在代码里实现」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { integrationReport } from '../src/adapters/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const configSource = readFileSync(join(here, '../src/config.ts'), 'utf8');

/** 从 config.ts 源码里提取所有被 str('X') / num('X') 读取的环境变量名 */
function envKeysReadByConfig(): Set<string> {
  const keys = new Set<string>();
  // str/num/bool/list 是直接读取；first 用于「主变量 + 向后兼容别名」
  for (const m of configSource.matchAll(/\b(?:str|num|bool|list|first)\('([A-Z][A-Z0-9_]+)'/g)) {
    keys.add(m[1]!);
  }
  return keys;
}

test('接入面板声明的每个环境变量都真的被 config.ts 读取', () => {
  const read = envKeysReadByConfig();
  assert.ok(read.size > 20, `应提取到足够多的变量，实际 ${read.size}`);

  const missing: string[] = [];
  for (const item of integrationReport().items) {
    for (const key of item.envKeys) {
      if (!read.has(key)) missing.push(`${item.key} → ${key}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `以下变量在面板里展示、但 config.ts 从不读取（用户填了不生效）：\n  ${missing.join('\n  ')}`,
  );
});

test('尚未实现的通道不得再出现在面板里（避免谎报）', () => {
  const items = integrationReport().items;
  const keys = items.map((i) => i.key);
  // 这四项在完成上线前审计后都已实现，必须出现在面板
  for (const expected of ['payment:payment', 'storage:object-storage', 'push:push-notification', 'analytics:analytics']) {
    assert.ok(keys.includes(expected), `${expected} 应出现在接入面板`);
  }
});

test('每个通道都有文档链接与说明，且 mock 通道标注了「无需 Key」', () => {
  for (const item of integrationReport().items) {
    assert.ok(item.docsUrl.length > 0, `${item.key} 缺少 docsUrl`);
    assert.ok(item.label.length > 0, `${item.key} 缺少 label`);
    assert.ok(item.note.length > 0, `${item.key} 缺少 note`);
    if (item.provider === 'mock' || item.provider.includes('browser') || item.provider.includes('local')) {
      assert.ok(
        item.envKeys.length === 0,
        `${item.key} 是降级通道，不该要求用户配 key（实际：${item.envKeys.join(',')}）`,
      );
    }
  }
});

test('指向本地手册的 docsUrl 锚点必须真实存在', () => {
  const integrationDoc = readFileSync(join(here, '../../../docs/API-INTEGRATION.md'), 'utf8');

  /** 按 GitHub 的锚点规则生成：转小写、去标点、空格转连字符 */
  const anchors = new Set<string>();
  for (const m of integrationDoc.matchAll(/^#{2,4} (.+)$/gm)) {
    const slug = m[1]!
      .trim()
      .toLowerCase()
      .replace(/[（）【】「」《》、，。：；！？·|/\\]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');
    anchors.add(slug);
  }
  assert.ok(anchors.size > 10, `应解析到足够多的标题锚点，实际 ${anchors.size}`);

  const broken: string[] = [];
  for (const item of integrationReport().items) {
    if (!item.docsUrl.startsWith('/docs/API-INTEGRATION.md')) continue;
    const anchor = item.docsUrl.split('#')[1];
    if (!anchor) {
      broken.push(`${item.key} 缺少锚点`);
      continue;
    }
    if (!anchors.has(anchor)) broken.push(`${item.key} → #${anchor}（文档里没有这个标题）`);
  }
  assert.deepEqual(broken, [], `以下文档链接指向不存在的锚点，点击会跳到页面顶部：\n  ${broken.join('\n  ')}`);
});

test('mock 模式判定依赖真实通道数量，降级通道不计入', () => {
  const report = integrationReport();
  assert.ok(['mock-all', 'partial', 'live-all'].includes(report.mode));
  assert.ok(report.summary.length > 0);
  // 未配置任何真实通道时必须是 mock-all（本地降级通道不算接入）
  const liveCount = report.items.filter(
    (i) => i.configured && !['mock', 'local-svg-composer', 'browser-web-speech', 'universal-skeleton'].includes(i.provider),
  ).length;
  if (liveCount === 0) {
    assert.equal(report.mode, 'mock-all');
    assert.match(report.summary, /Mock/);
  }
});
