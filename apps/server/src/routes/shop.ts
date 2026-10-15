/**
 * shop 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { redeem, shopFor } from '../services/pet.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerShopRoutes(router: Router, svc: RouteServices): void {
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
/* -------- 商店（好感度兑换，禁止购买） -------- */
  router.get('/api/shop', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  return { ok: true, data: shopFor(repos, pet) };
});

  router.post('/api/shop/redeem', (ctx) => {
  const body = check(ctx.body, SCHEMAS.redeem);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  const result = redeem(repos, pet, body.itemId ?? '');
  return { ok: true, data: result };
});
}
