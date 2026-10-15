/**
 * chat 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { assertConversationOwned } from '../http/auth.ts';
import { activeTtsProvider } from '../services/adapters-bridge.ts';
import { conversationHistory, openingMessage, sendMessage } from '../services/chat.ts';
import { capacityFor } from '../services/memory.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerChatRoutes(router: Router, svc: RouteServices): void {
  const {
    SESSION_SECRET,
    activePet,
    analytics,
    authOf,
    care,
    currentUser,
    enforceDailyQuota,
    imageRefPrefixes,
    migration,
    persistenceChoice,
    push,
    repos,
    requirePet,
    requireValidImageRef,
    storage,
    store,
    touchCounters,
  } = svc;
/* -------- 真心话小屋 -------- */
  router.get('/api/chat', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const { conversation, messages } = conversationHistory(repos, pet);
  if (!messages.length) {
    const opening = openingMessage(repos, pet, conversation.id);
    repos.addMessage(opening);
    return {
      ok: true,
      data: { conversation, messages: [opening], personality: pet.personality, memories: repos.listMemories(pet.id) },
    };
  }
  return {
    ok: true,
    data: { conversation, messages, personality: pet.personality, memories: repos.listMemories(pet.id) },
  };
});

  router.post('/api/chat', async (ctx) => {
  // 先校验参数再查归属：否则「text 太长」会被报成「宠物不存在」，
  // 用户拿到的是误导性提示。
  const body = check(ctx.body, SCHEMAS.chat);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  enforceDailyQuota('chat', pet.ownerId);
  // 归属校验：否则可以往别人的会话里插消息
  if (body.conversationId) assertConversationOwned(repos, auth.userId, body.conversationId);
  const result = await sendMessage(repos, pet, {
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    // 长度已由 SCHEMAS.chat 校验（<=500），这里不再截断
    text: body.text,
    layer: (body.layer as never) ?? 'auto',
    viaVoice: Boolean(body.viaVoice),
  });

  // 埋点（F3）：记录分层与是否走了模型，用于验证「对话分层省成本」这个设计
  analytics.track(result.modelUsed ? 'chat.model_used' : 'chat.free_layer', auth.userId, {
    layer: result.petMessage.layer,
    modelUsed: result.modelUsed,
    degraded: result.degraded,
    gain: result.affectionGain,
  });
  if (result.safety.blocked) {
    analytics.track('chat.safety_blocked', auth.userId, { category: result.safety.category ?? 'unknown' });

    /**
     * 悲伤信号（F4）：连续提及离世/告别类话题时累计。
     * 只存计数，不存内容 —— 这样即使数据库泄漏也不会暴露用户说了什么。
     */
    if (result.safety.category === 'self-harm') {
      const key = `grief:${auth.userId}`;
      const next = repos.getMeta<number>(key, 0) + 1;
      repos.setMeta(key, next);
      if (next >= 3) {
        analytics.track('care.support_resources', auth.userId, { count: next });
      }
    }
  }

  return { ok: true, data: result };
});

  router.get('/api/chat/memories', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const user = currentUser(ctx.req);
  return {
    ok: true,
    data: { memories: repos.listMemories(pet.id), capacity: capacityFor(user.tier) },
  };
});

  router.post('/api/tts', async (ctx) => {
  const body = (ctx.body ?? {}) as { petId?: string; text?: string };
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  enforceDailyQuota('tts', pet.ownerId);
  const provider = activeTtsProvider();
  const result = await provider.synthesize({
    text: (body.text ?? '').slice(0, 300),
    voiceProfile: pet.personality.voiceProfile,
    emotion: pet.mood,
  });
  return { ok: true, data: result };
});
}
