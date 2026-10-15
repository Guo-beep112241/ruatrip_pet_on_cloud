/**
 * 真心话小屋服务（说明书 6.2）
 *
 * 四层对话能力：
 *   instant —— 问候/喂食反馈/抚摸，本地预设池，零延迟零成本
 *   scene   —— 结合当前时间、天气、打卡地点的模板填充
 *   free    —— 自由输入，走大模型 + 人格卡 system prompt
 *   memory  —— 引用历史对话与共同经历（主动提及）
 */
import type {
  ChatLayer,
  ChatMessage,
  Conversation,
  MemoryEntry,
  Pet,
} from '../../../../packages/shared/src/index.ts';
import type { Repositories } from '../repositories/index.ts';
import { completeChat } from '../adapters/chat.ts';
import {
  buildSystemPrompt,
  greetingKey,
  pickInstant,
  sceneLine,
  screenModelOutput,
  screenUserInput,
} from './persona.ts';
import { capacityFor, recallFor, rememberConversation } from './memory.ts';
import { applyGain, nowIso } from './growth.ts';

const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export function ensureConversation(repos: Repositories, pet: Pet): Conversation {
  const existing = repos.listConversations(pet.id);
  if (existing.length) return existing[existing.length - 1]!;
  const conv: Conversation = {
    id: uid('conv'),
    petId: pet.id,
    userId: pet.ownerId,
    title: `与${pet.name}的第一次真心话`,
    messageCount: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repos.saveConversation(conv);
  return conv;
}

/** 打开小屋时的欢迎语：优先场景层，其次即时层 */
export function openingMessage(repos: Repositories, pet: Pet, conversationId: string): ChatMessage {
  const hour = new Date().getHours();
  const memory = recallFor(repos, pet.id, ['checkin', 'conversation']);
  const text = memory && pet.longing < 70
    ? `（它看了你一眼）……我还记得。${memory.content.slice(0, 40)}`
    : memory
      ? `${pickInstant(greetingKey(hour))}对了，${memory.content.slice(0, 32)}——我一直记着。`
      : pickInstant(greetingKey(hour));

  const msg: ChatMessage = {
    id: uid('msg'),
    conversationId,
    role: 'pet',
    content: text,
    layer: memory ? 'memory' : 'instant',
    fromModel: false,
    expression: 'talk-tilt',
    audioUrl: null,
    createdAt: nowIso(),
  };
  return msg;
}

export interface SendResult {
  conversation: Conversation;
  userMessage: ChatMessage;
  petMessage: ChatMessage;
  safety: { blocked: boolean; category?: string; showSupportResources: boolean };
  affectionGain: number;
  modelUsed: boolean;
  degraded: boolean;
  memories: MemoryEntry[];
}

export async function sendMessage(
  repos: Repositories,
  pet: Pet,
  input: { conversationId?: string; text: string; layer?: ChatLayer | 'auto'; viaVoice?: boolean },
): Promise<SendResult> {
  const conv = input.conversationId
    ? (repos.getConversation(input.conversationId) ?? ensureConversation(repos, pet))
    : ensureConversation(repos, pet);

  const userMessage: ChatMessage = {
    id: uid('msg'),
    conversationId: conv.id,
    role: 'user',
    content: input.text,
    layer: 'free',
    fromModel: false,
    createdAt: nowIso(),
  };
  repos.addMessage(userMessage);

  const memories = repos.listMemories(pet.id);
  const verdict = screenUserInput(input.text, pet.personality);

  // 前置过滤命中：用符合人设的方式温柔带过，不走模型
  if (verdict.blocked) {
    const petMessage: ChatMessage = {
      id: uid('msg'),
      conversationId: conv.id,
      role: 'pet',
      content: verdict.deflection ?? '嗯……我们聊点别的吧。',
      layer: 'instant',
      fromModel: false,
      expression: verdict.showSupportResources ? 'mood-lonely' : 'talk-tilt',
      createdAt: nowIso(),
    };
    repos.addMessage(petMessage);
    const updated = touch(repos, conv, petMessage);
    return {
      conversation: updated,
      userMessage,
      petMessage,
      safety: {
        blocked: true,
        ...(verdict.category ? { category: verdict.category } : {}),
        showSupportResources: verdict.showSupportResources,
      },
      affectionGain: 0,
      modelUsed: false,
      degraded: false,
      memories,
    };
  }

  // 分层判定：auto 时按内容长短与是否含问句决定是否上模型
  const layer: ChatLayer = input.layer && input.layer !== 'auto'
    ? input.layer
    : input.text.trim().length <= 6 && /^(你好|在吗|嗨|hi|早|晚安|摸摸|抱抱)$/i.test(input.text.trim())
      ? 'instant'
      : 'free';

  let petText: string;
  let fromModel = false;
  let degraded = false;
  let expression = 'talk-nod';

  if (layer === 'instant') {
    petText = pickInstant(pickInstantKey(input.text));
  } else if (layer === 'scene') {
    petText = sceneLine({ hour: new Date().getHours(), petName: pet.name, place: '外面', weather: undefined });
  } else {
    const system = buildSystemPrompt({
      petName: pet.name,
      callName: pet.callName,
      card: pet.personality,
      quirks: pet.quirks,
      affectionLevel: pet.level,
      longing: pet.longing,
      memories,
      scene: { timeOfDay: timeOfDayLabel(), place: undefined },
      userNickname: '主人',
    });
    const history = repos
      .listMessages(conv.id)
      .filter((m) => m.id !== userMessage.id)
      .slice(-10)
      .map((m) => ({ role: m.role === 'pet' ? ('assistant' as const) : ('user' as const), content: m.content }));
    const historyWithUser = [...history, { role: 'user' as const, content: input.text }];

    const completion = await completeChat({ system, turns: historyWithUser, maxTokens: 300 });
    const screened = screenModelOutput(completion.text);
    petText = screened.text;
    fromModel = completion.live;
    degraded = !completion.live;
    expression = 'talk-paw';
  }

  const petMessage: ChatMessage = {
    id: uid('msg'),
    conversationId: conv.id,
    role: 'pet',
    content: petText,
    layer: fromModel ? 'free' : layer,
    fromModel,
    expression,
    audioUrl: null,
    createdAt: nowIso(),
  };
  repos.addMessage(petMessage);
  const updated = touch(repos, conv, petMessage);

  // 记忆：每 6 条消息做一次摘要提炼
  const capacity = capacityFor(repos.getUser()?.tier ?? 'free');
  const all = repos.listMessages(conv.id);
  // 第 2 条消息后就做第一次摘要，之后每 6 条一次：
  // 这样「被记住」的体验在第一天就成立，而不是等到攒够对话量。
  if (all.length === 2 || all.length % 6 === 0) {
    rememberConversation(repos, pet.id, all.slice(-8), capacity);
  }

  // 好感度：对话属于「低收益但鼓励」的类别，且到上限后不再增加（不阻止对话）
  const applied = applyGain(repos, pet, 'chat', '真心话对话');

  return {
    conversation: updated,
    userMessage,
    petMessage,
    safety: { blocked: false, showSupportResources: false },
    affectionGain: applied.gain,
    modelUsed: fromModel,
    degraded,
    memories: repos.listMemories(pet.id),
  };
}

function pickInstantKey(text: string): string {
  const t = text.trim();
  if (/吃|饭|饿|喂/.test(t)) return 'feed.reply';
  if (/睡|晚安|困/.test(t)) return 'greet.night';
  if (/你好|在吗|嗨|早/.test(t)) return 'greet.morning';
  if (/玩|球/.test(t)) return 'play.reply';
  if (/摸|抱|rua|撸/i.test(t)) return 'pet.head';
  return 'idle';
}

function timeOfDayLabel(): string {
  const h = new Date().getHours();
  if (h < 6) return '凌晨';
  if (h < 11) return '早上';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '深夜';
}

function touch(repos: Repositories, conv: Conversation, msg: ChatMessage): Conversation {
  const next: Conversation = {
    ...conv,
    messageCount: repos.listMessages(conv.id).length,
    updatedAt: msg.createdAt,
  };
  repos.saveConversation(next);
  return next;
}

export function conversationHistory(repos: Repositories, pet: Pet): { conversation: Conversation; messages: ChatMessage[] } {
  const conv = ensureConversation(repos, pet);
  return { conversation: conv, messages: repos.listMessages(conv.id) };
}
