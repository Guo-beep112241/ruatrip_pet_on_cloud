/**
 * foster 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { nowIso } from '../services/growth.ts';
import { rememberEvent } from '../services/memory.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerFosterRoutes(router: Router, svc: RouteServices): void {
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
/* -------- 云代养 / 双宠同行（第三阶段：先把关系网络打通） -------- */
  router.get('/api/foster', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const requests = repos.listFosters(pet.id);
  const completed = requests.find((r) => r.status === 'completed');
  return {
    ok: true,
    data: {
      requests,
      incomingLine: completed ? `${pet.name}回来了，它说：「你的朋友对我挺好的，但我还是想睡你的床。」` : null,
    },
  };
});

  router.post('/api/foster', (ctx) => {
  const body = check(ctx.body, SCHEMAS.foster);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  const req = {
    id: `fos-${Date.now()}`,
    petId: pet.id,
    ownerId: pet.ownerId,
    friendName: body.friendName?.trim() || '好友',
    days: Math.max(1, Math.min(14, body.days ?? 3)),
    status: 'active' as const,
    friendInteractions: 0,
    createdAt: nowIso(),
  };
  repos.saveFoster(req);
  rememberEvent(repos, pet.id, `被${req.friendName}代养了 ${req.days} 天`, 6, ['foster']);
  return { ok: true, data: { request: req } };
});
}
