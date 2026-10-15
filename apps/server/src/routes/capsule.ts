/**
 * capsule 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { assertCapsuleOwned } from '../http/auth.ts';
import { nowIso } from '../services/growth.ts';
// TODO(M6): CAPSULE_DISCLAIMER 仍在 index.ts 内定义，需下沉
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerCapsuleRoutes(router: Router, svc: RouteServices): void {
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
/* -------- 时光胶囊（独立安静入口） -------- */
const CAPSULE_DISCLAIMER =
  '这里生成的是「基于照片的陪伴形象」，不是它本人。它会像它，但不会是它。慢慢来，不着急。';

  router.get('/api/capsule', (ctx) => {
  const auth = authOf(ctx.req);
  return { ok: true, data: { projects: repos.listCapsules(auth.userId) } };
});

  router.post('/api/capsule', (ctx) => {
  const user = currentUser(ctx.req);
  enforceDailyQuota('capsule', user.id);
  const body = check(ctx.body, SCHEMAS.capsule);
  const project = {
    id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: user.id,
    photoUrl: requireValidImageRef(body.photoUrl, 'photoUrl'),
    petName: body.petName?.trim() || '它',
    letterTo: body.letterTo ?? '',
    stage: 'uploaded' as const,
    progress: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repos.saveCapsule(project);
  // 异步推进：analyzing → restoring → done
  void advanceCapsule(project.id);
  return { ok: true, data: { project, disclaimer: CAPSULE_DISCLAIMER } };
});

  router.get('/api/capsule/:id', (ctx) => {
  const auth = authOf(ctx.req);
  // 归属校验：否则拿到别人的 capsuleId 就能看到别人上传的旧照
  assertCapsuleOwned(repos, auth.userId, ctx.params.id!);
  const project = repos.getCapsule(ctx.params.id!);
  if (!project) throw Object.assign(new Error('CAPSULE_NOT_FOUND'), { status: 404 });
  return { ok: true, data: { project, disclaimer: CAPSULE_DISCLAIMER } };
});

async function advanceCapsule(id: string): Promise<void> {
  const stages: { stage: 'analyzing' | 'restoring' | 'done'; progress: number; delay: number }[] = [
    { stage: 'analyzing', progress: 30, delay: 900 },
    { stage: 'restoring', progress: 68, delay: 2200 },
    { stage: 'done', progress: 100, delay: 4200 },
  ];
  for (const s of stages) {
    await new Promise((r) => setTimeout(r, s.delay));
    const current = repos.getCapsule(id);
    if (!current) return;
    repos.saveCapsule({
      ...current,
      stage: s.stage,
      progress: s.progress,
      restoredImageUrl: s.stage === 'done'
        ? `/api/asset/pet.svg?species=ragdoll&palette=oat,chestnut&name=${encodeURIComponent(current.petName)}`
        : current.restoredImageUrl,
      updatedAt: nowIso(),
    });
  }
}
}
