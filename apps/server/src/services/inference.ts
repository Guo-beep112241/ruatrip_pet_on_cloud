/**
 * 偏好问卷 → 多维偏好向量 → 形象参数（说明书 5.2 / 5.3）
 *
 * 三条冷启动原则：
 *   - 问卷即画像：提交即得到初始向量，不等行为数据
 *   - 预测补位：跳过的维度用相似画像人群的常见组合补全，绝不留空
 *   - 行为补全：后续打卡/换装/互动偏好持续修正向量（见 refineVector）
 */
import type {
  PreferenceAnswers,
  PreferenceDimensionId,
  PreferenceVector,
  ProfileInference,
} from '../../../../packages/shared/src/index.ts';
import { PREFERENCE_QUESTIONS } from '../../../../packages/shared/src/catalog.ts';

/** 相似画像人群的常见组合（预测补位基线） */
const COLD_START_DEFAULTS: Record<PreferenceDimensionId, string[]> = {
  species: ['ragdoll'],
  bodySize: ['small'],
  fur: ['fluffy'],
  palette: ['oat', 'cream', 'chestnut'],
  personality: ['clingy'],
  rhythm: ['balanced'],
  travel: ['city', 'seaside'],
  photoHabit: ['normal'],
};

const DIMENSIONS: PreferenceDimensionId[] = [
  'species', 'bodySize', 'fur', 'palette', 'personality', 'rhythm', 'travel', 'photoHabit',
];

const FUR_VALUES = ['fluffy', 'silky', 'short', 'curly'];
const SIZE_VALUES = ['tiny', 'small', 'medium', 'large'];
const RHYTHM_VALUES = ['clingy', 'balanced', 'independent'];
const PHOTO_VALUES = ['heavy', 'normal', 'light'];

function pick(values: string[], allowed: readonly string[], fallback: string): string {
  const hit = values.find((v) => allowed.includes(v));
  return hit ?? fallback;
}

/** 主入口：问卷答案 → 完整偏好向量（含补位标注） */
export function inferProfile(answers: PreferenceAnswers): ProfileInference {
  const inferred: PreferenceDimensionId[] = [];
  const resolved: Record<PreferenceDimensionId, string[]> = {} as Record<PreferenceDimensionId, string[]>;

  for (const dim of DIMENSIONS) {
    const given = (answers[dim] ?? []).filter(Boolean);
    if (given.length > 0) {
      resolved[dim] = given;
    } else {
      resolved[dim] = COLD_START_DEFAULTS[dim];
      inferred.push(dim);
    }
  }

  const answeredCount = DIMENSIONS.length - inferred.length;

  const vector: PreferenceVector = {
    species: resolved.species[0] ?? 'ragdoll',
    bodySize: pick(resolved.bodySize, SIZE_VALUES, 'small') as PreferenceVector['bodySize'],
    fur: pick(resolved.fur, FUR_VALUES, 'fluffy') as PreferenceVector['fur'],
    palette: resolved.palette.slice(0, 3),
    personality: resolved.personality.slice(0, 2),
    rhythm: pick(resolved.rhythm, RHYTHM_VALUES, 'balanced') as PreferenceVector['rhythm'],
    travelPreference: resolved.travel.slice(0, 3),
    photoHabit: pick(resolved.photoHabit, PHOTO_VALUES, 'normal') as PreferenceVector['photoHabit'],
    inferred,
  };

  return {
    vector,
    confidence: Number((answeredCount / DIMENSIONS.length).toFixed(2)),
    inferredDimensions: inferred,
  };
}

/** 行为补全：用真实行为持续修正向量（说明书 5.2） */
export function refineVector(
  vector: PreferenceVector,
  behavior: { kind: 'checkin'; scene: string } | { kind: 'outfit'; outfitId: string } | { kind: 'play'; toyId: string },
): PreferenceVector {
  if (behavior.kind === 'checkin') {
    const next = Array.from(new Set([behavior.scene, ...vector.travelPreference])).slice(0, 4);
    return { ...vector, travelPreference: next };
  }
  if (behavior.kind === 'play') {
    // 玩具偏好反推性格：球类 → 活泼；抱枕类 → 粘人
    const guess = behavior.toyId.includes('ball') ? 'chaotic' : 'clingy';
    const next = Array.from(new Set([guess, ...vector.personality])).slice(0, 3);
    return { ...vector, personality: next };
  }
  return vector;
}

/** 生成候选名字：要有「命中注定」的感觉，而不是随机 ID */
const NAME_BANK: Record<string, string[]> = {
  ragdoll: ['汤圆', '云朵', '阿糯', '绵绵'],
  corgi: ['短腿', '面包', '豆豆', '小薯'],
  shiba: ['柴柴', '阿呆', '团子', '不服'],
  bunny: ['豆沙', '耳朵', '软软', '雪团'],
  hamster: ['瓜子', '汤匙', '小球', '麻薯'],
  fox: ['阿狸', '小贼', '栗子', '尾巴'],
  fawn: ['小鹿', '斑斑', '林深', '慢慢'],
  capybara: ['泡芙', '淡定', '水水', '大福'],
  alpaca: ['毛毛', '云绵', '慢慢', '咖啡'],
  bird: ['啾啾', '小豆', '轻舟', '音符'],
  chimera: ['小怪', '独一无二', '拼拼', '奇迹'],
};

export function suggestNames(species: string): string[] {
  const base = NAME_BANK[species] ?? NAME_BANK.ragdoll!;
  return base.slice(0, 4);
}

/** 性格预览：让用户在生成前就看到它的说话样子（减少生成后的落差） */
export function personalityPreview(vector: PreferenceVector, card: {
  traits: string[]; speechRhythm: string; catchphrases: string[];
}): { traits: string[]; speechRhythm: string; catchphrases: string[] } {
  return { traits: card.traits, speechRhythm: card.speechRhythm, catchphrases: card.catchphrases };
}

export function questionCatalog() {
  return PREFERENCE_QUESTIONS;
}
