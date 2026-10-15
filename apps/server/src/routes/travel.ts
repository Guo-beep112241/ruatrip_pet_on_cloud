/**
 * travel 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { DESTINATIONS } from '../../../../packages/shared/src/catalog.ts';
import { generateJournal, generatePostcard } from '../services/content.ts';
import { badgesFor, destinationById, ensureWishlist, performCheckin, storyProgress } from '../services/travel.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerTravelRoutes(router: Router, svc: RouteServices): void {
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
/* -------- 旅行模块 -------- */
  router.get('/api/travel', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  const wishlist = ensureWishlist(repos, pet);
  return {
    ok: true,
    data: {
      destinations: DESTINATIONS,
      wishlist,
      checkins: repos.listCheckins(pet.id),
      badges: badgesFor(repos, pet),
      journals: repos.listJournals(pet.id),
      postcards: repos.listPostcards(pet.id),
      storyProgress: storyProgress(repos, pet),
    },
  };
});

  router.post('/api/travel/checkin', async (ctx) => {
  const body = check(ctx.body, SCHEMAS.checkin);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  enforceDailyQuota('checkin', pet.ownerId);
  if (!destinationById(body.destinationId ?? '')) throw Object.assign(new Error('DESTINATION_NOT_FOUND'), { status: 404 });
  const wasRevisit = repos.listCheckins(pet.id).some((c) => c.destinationId === body.destinationId);
  const outcome = await performCheckin(repos, pet, {
    destinationId: body.destinationId!,
    photoUrl: requireValidImageRef(body.photoUrl, 'photoUrl') || null,
    ...(body.lat !== undefined ? { lat: body.lat } : {}),
    ...(body.lng !== undefined ? { lng: body.lng } : {}),
    ...(body.note ? { note: body.note } : {}),
  });
  analytics.track('travel.checkin', auth.userId, {
    destinationId: body.destinationId,
    gain: outcome.gain,
    isRevisit: wasRevisit,
    cityCount: new Set(repos.listCheckins(outcome.pet.id).map((c) => c.destinationId)).size,
  });
  if (wasRevisit) analytics.track('travel.revisit', auth.userId, { destinationId: body.destinationId });
  analytics.track('journal.generate', auth.userId, { template: outcome.journal.template });
  analytics.track('postcard.generate', auth.userId, { template: outcome.postcard.template });
  if (outcome.blindBox) analytics.track('wishlist.unlock', auth.userId, { itemId: outcome.blindBox.name });

  return { ok: true, data: outcome };
});

  router.get('/api/journal', (ctx) => {
  const auth = authOf(ctx.req);
  const pet = requirePet(ctx.query.get('petId') ?? repos.getActivePet(auth.userId)?.id, auth.userId);
  return { ok: true, data: { entries: repos.listJournals(pet.id).slice().reverse() } };
});

  router.post('/api/journal', (ctx) => {
  const body = check(ctx.body, SCHEMAS.journal);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  // 用「属于这只宠物」而不是全局 id 查找，天然完成归属校验
  const checkin = body.checkinId ? repos.listCheckins(pet.id).find((c) => c.id === body.checkinId) : null;
  const destination =
    (checkin ? destinationById(checkin.destinationId) : null) ??
    DESTINATIONS.find((d) => d.name === body.destinationName) ??
    DESTINATIONS[0]!;
  const entry = generateJournal({
    pet,
    destination,
    checkinId: checkin?.id ?? null,
    ...(body.template ? { template: body.template as never } : {}),
    ...(checkin?.composedPhotoUrl ? { composedPhotoUrl: checkin.composedPhotoUrl } : {}),
    ...(checkin?.revisitMemory ? { revisitMemory: checkin.revisitMemory } : {}),
    ...(body.extraNote ? { extraNote: body.extraNote } : {}),
  });
  repos.addJournal(entry);
  return { ok: true, data: { entry } };
});

  router.post('/api/postcard', (ctx) => {
  const body = check(ctx.body, SCHEMAS.postcard);
  const auth = authOf(ctx.req);
  const pet = requirePet(body.petId, auth.userId);
  // 同上：限定在这只宠物的打卡记录里查找
  const checkin = body.checkinId ? repos.listCheckins(pet.id).find((c) => c.id === body.checkinId) : null;
  const destination = (checkin ? destinationById(checkin.destinationId) : null) ?? DESTINATIONS[0]!;
  const card = generatePostcard({
    pet,
    destination,
    checkinId: checkin?.id ?? null,
    ...(body.to ? { to: body.to } : {}),
    ...(body.template ? { template: body.template as never } : {}),
  });
  repos.addPostcard(card);
  return { ok: true, data: { postcard: card } };
});
}
