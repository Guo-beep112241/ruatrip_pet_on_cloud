/**
 * survey 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { PREFERENCE_QUESTIONS } from '../../../../packages/shared/src/catalog.ts';
import { inferProfile, suggestNames } from '../services/inference.ts';
import type { PreferenceAnswers } from '../../../../packages/shared/src/index.ts';
import { buildPersonalityCard, buildQuirks, speciesById } from '../services/persona.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerSurveyRoutes(router: Router, svc: RouteServices): void {
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
/* -------- 偏好问卷 -------- */
  router.get('/api/survey', () => ({
  ok: true,
  data: { questions: PREFERENCE_QUESTIONS, savedAnswers: repos.getAnswers() },
}));

  router.post('/api/survey', (ctx) => {
  const body = check(ctx.body, SCHEMAS.survey);
  // 问卷答案是多维度的对象（{species:[...]}），这里只做顶层校验，
  // 维度合法性由 services/inference.ts 的白名单保证。
  const answers = body.answers;
  repos.saveAnswers(answers as PreferenceAnswers);
  /**
   * answerMap 的静态类型是 unknown：validate 无法对「运行时才知道的维度名」做索引类型。
   * 这里显式窄化 —— 维度白名单由 services/inference.ts 在运行时保证
   * （未知维度会被忽略，缺失维度用相似画像补全）。
   */
  const inference = inferProfile(answers as PreferenceAnswers);
  const species = speciesById(inference.vector.species);
  const card = buildPersonalityCard(species.id, inference.vector);
  return {
    ok: true,
    data: {
      inference,
      suggestedNames: suggestNames(species.id),
      suggestedQuirks: buildQuirks(species.id, inference.vector),
      petDraft: {
        species: species.id,
        speciesEmoji: species.emoji,
        personalityPreview: {
          traits: card.traits,
          speechRhythm: card.speechRhythm,
          catchphrases: card.catchphrases,
        },
        palette: inference.vector.palette,
        fur: inference.vector.fur,
        bodySize: inference.vector.bodySize,
      },
    },
  };
});
}
