/**
 * 前端使用的类型别名。
 * 直接复用 packages/shared 的领域模型，保证前后端契约只有一个来源。
 */
export type * from '../../../../packages/shared/src/index.ts';
export type * from '../../../../packages/shared/src/api.ts';

export {
  AFFECTION_RULES,
  DAILY_AFFECTION_CAP,
  STREAK_MILESTONES,
  levelFromAffection,
  longingFromIdle,
} from '../../../../packages/shared/src/rules.ts';

export {
  DESTINATIONS,
  MOOD_COPY,
  PREFERENCE_QUESTIONS,
  SCENE_PRESETS,
  SHOP_ITEMS,
  SPECIES_CATALOG,
  SUBSCRIPTION_PLANS,
} from '../../../../packages/shared/src/catalog.ts';

export type { ScenePreset } from '../../../../packages/shared/src/catalog.ts';
