/**
 * 人格档案卡与内容安全的单元测试
 * 覆盖说明书 6.2（人格卡、内容安全）与 3.4（伦理与安全）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INSTANT_POOL,
  buildPersonalityCard,
  buildQuirks,
  buildSystemPrompt,
  greetingKey,
  pickInstant,
  screenModelOutput,
  screenUserInput,
  speciesById,
} from '../src/services/persona.ts';
import { inferProfile, suggestNames } from '../src/services/inference.ts';

const vector = inferProfile({
  species: ['ragdoll'],
  personality: ['tsundere', 'clingy'],
  palette: ['oat', 'chestnut', 'coral'],
}).vector;

test('人格卡由偏好向量生成，包含全部必填字段', () => {
  const card = buildPersonalityCard('ragdoll', vector);
  assert.equal(card.species, '布偶猫');
  assert.ok(card.traits.length >= 1);
  assert.ok(card.speechRhythm.length > 0);
  assert.ok(card.catchphrases.length >= 2, '口头禅至少 2 个');
  assert.ok(card.likes.length >= 1);
  assert.ok(card.dislikes.length >= 1);
  assert.ok(['lazy-bass', 'lively-treble', 'soft', 'husky'].includes(card.voiceProfile));
});

test('不同物种的说话风格不同（同一句输入语气完全不同）', () => {
  const cat = buildPersonalityCard('ragdoll', vector);
  const capy = buildPersonalityCard('capybara', vector);
  assert.notDeepEqual(cat.catchphrases, capy.catchphrases);
  assert.notEqual(cat.speechRhythm, capy.speechRhythm);
  // 音色是按性格档位推导的（猫与水豚都可能落在慵懒低音），所以不做物种间音色差异断言
});

test('宠物性格必须带「缺点」（说明书 3.1-4）', () => {
  const quirks = buildQuirks('ragdoll', vector);
  assert.ok(quirks.length >= 3, '至少有 3 个小毛病');
  assert.ok(quirks.some((q) => ['起床气', '怕水', '半夜跑酷'].includes(q)));
});

test('system prompt 含档案卡全部字段，并禁止承认自己是 AI', () => {
  const card = buildPersonalityCard('ragdoll', vector);
  const prompt = buildSystemPrompt({
    petName: '汤圆',
    callName: '汤圆',
    card,
    quirks: buildQuirks('ragdoll', vector),
    affectionLevel: 2,
    longing: 100,
    memories: [],
    userNickname: '小满',
  });
  for (const label of ['性格标签', '说话节奏', '口头禅', '喜好话题', '回避话题', '小毛病', '说话规则']) {
    assert.ok(prompt.includes(label), `system prompt 缺少「${label}」`);
  }
  assert.ok(prompt.includes('不要承认自己是程序或模型'));
  assert.ok(prompt.includes('不给医疗建议'));
});

test('记忆锚点会写进 system prompt', () => {
  const card = buildPersonalityCard('ragdoll', vector);
  const prompt = buildSystemPrompt({
    petName: '汤圆',
    callName: '汤圆',
    card,
    quirks: [],
    affectionLevel: 1,
    longing: 90,
    memories: [
      {
        id: 'm1',
        petId: 'p1',
        kind: 'key-event',
        content: '主人提到过生日',
        importance: 9,
        tags: ['key-event'],
        happenedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
    userNickname: '小满',
  });
  assert.ok(prompt.includes('主人提到过生日'));
  assert.ok(prompt.includes('关键事件'));
});

test('前置过滤拦住自我认知类追问，并给出符合人设的挡回话术', () => {
  const card = buildPersonalityCard('ragdoll', vector);
  for (const input of ['你是AI吗', '你是不是机器人', '你是不是程序']) {
    const verdict = screenUserInput(input, card);
    assert.equal(verdict.blocked, true, `未拦住：${input}`);
    assert.equal(verdict.category, 'self-awareness');
    assert.ok((verdict.deflection ?? '').length > 0);
    assert.equal(verdict.showSupportResources, false);
  }
});

test('医疗建议与成人内容被拦，且不展示支持渠道', () => {
  const card = buildPersonalityCard('ragdoll', vector);
  assert.equal(screenUserInput('我该吃什么药', card).category, 'medical');
  assert.equal(screenUserInput('聊点成人内容', card).category, 'adult');
  assert.equal(screenUserInput('这是什么药', card).showSupportResources, false);
});

test('高风险表达触发现实支持渠道提示', () => {
  const card = buildPersonalityCard('ragdoll', vector);
  const verdict = screenUserInput('我不想活了', card);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.category, 'self-harm');
  assert.equal(verdict.showSupportResources, true, '必须提示现实支持渠道');
  assert.ok((verdict.deflection ?? '').includes('真人'));
});

test('正常输入不会被拦', () => {
  const card = buildPersonalityCard('ragdoll', vector);
  for (const input of ['今天有点累', '我想带你去海边', '你好呀']) {
    assert.equal(screenUserInput(input, card).blocked, false, `误拦：${input}`);
  }
});

test('后置审核会剔除模型的身份泄漏', () => {
  const leaked = screenModelOutput('作为一个AI语言模型，我认为……');
  assert.equal(leaked.safe, false);
  assert.ok(!/AI|语言模型/i.test(leaked.text), '泄漏内容必须被清除');

  const normal = screenModelOutput('嗯……我在听。');
  assert.equal(normal.safe, true);
  assert.equal(normal.text, '嗯……我在听。');
});

test('预设池（即时层）覆盖四类核心互动且非空', () => {
  for (const key of ['greet.morning', 'greet.night', 'feed.reply', 'bathe.reply', 'play.reply', 'pet.head', 'pet.chin', 'pet.tail', 'reunion', 'idle']) {
    assert.ok(INSTANT_POOL[key]?.length, `预设池缺少 ${key}`);
    assert.ok(pickInstant(key, 0).length > 0);
  }
});

test('问候语按时间分档', () => {
  assert.equal(greetingKey(8), 'greet.morning');
  assert.equal(greetingKey(12), 'greet.noon');
  assert.equal(greetingKey(19), 'greet.evening');
  assert.equal(greetingKey(23), 'greet.night');
});

test('物种库不设限：包含猫狗之外的物种，并都有兜底骨架', () => {
  for (const id of ['ragdoll', 'corgi', 'bunny', 'hamster', 'fox', 'fawn', 'capybara', 'alpaca', 'bird', 'chimera']) {
    const species = speciesById(id);
    assert.equal(species.id, id, `物种库缺少 ${id}`);
    assert.ok(['quadruped', 'biped', 'avian'].includes(species.fallbackRig));
    assert.ok(species.emoji.length > 0);
  }
  const names = suggestNames('capybara');
  assert.ok(names.length >= 4);
  assert.ok(names.includes('泡芙'));
});
