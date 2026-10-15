/**
 * 旅行模块服务（说明书 7.2 / 7.3）
 *
 * 覆盖：心愿单、城市剧情副本、AR/合成合影、旅行盲盒、宠物视角明信片、
 *       城市限定物种皮肤、旅行时光机、出行前播报。
 */
import type {
  Badge,
  Checkin,
  Destination,
  JournalEntry,
  Pet,
  Postcard,
  WishlistItem,
} from '../../../../packages/shared/src/index.ts';
import { DESTINATIONS } from '../../../../packages/shared/src/catalog.ts';
import type { Repositories } from '../repositories/index.ts';
import { activeImageProvider } from '../adapters/image.ts';
import { imageIntegrationStatus } from '../adapters/image.ts';
import { speciesById, speciesLabel } from './persona.ts';
import {
  fakeWeather,
  generateJournal,
  generatePostcard,
  revisitLine,
  travelAlert,
  wishQuote,
} from './content.ts';
import { applyGain, nowIso, refreshPetState } from './growth.ts';
import { rememberEvent } from './memory.ts';

export const destinationById = (id: string): Destination | null =>
  DESTINATIONS.find((d) => d.id === id) ?? null;

export const requirementForFullStory = 3;

/** 心愿单：宠物主动提出想去的地方（说明书 7.2-①） */
export function ensureWishlist(repos: Repositories, pet: Pet): WishlistItem[] {
  const existing = repos.listWishlist(pet.id);
  if (existing.length >= 3) return existing;

  // 按偏好向量挑目的地：旅行偏好优先
  const preferred = DESTINATIONS.filter((d) => pet.vector.travelPreference.includes(d.scene));
  const pool = (preferred.length ? preferred : DESTINATIONS).filter(
    (d) => !existing.some((w) => w.destinationId === d.id),
  );
  const created: WishlistItem[] = [];
  for (const dest of pool.slice(0, 3 - existing.length)) {
    created.push({
      id: `wish-${Date.now()}-${dest.id}`,
      petId: pet.id,
      destinationId: dest.id,
      destinationName: dest.name,
      petQuote: wishQuote(pet, dest),
      reward: dest.exclusiveSkin
        ? `解锁「${dest.exclusiveSkin.name}」${dest.exclusiveSkin.emoji}`
        : '解锁专属剧情章节',
      status: 'wishing',
      createdAt: nowIso(),
    });
  }
  for (const item of created) repos.addWishlist(item);
  return [...existing, ...created];
}

/** 徽章墙：每个目的地一枚 */
export function badgesFor(repos: Repositories, pet: Pet): Badge[] {
  const checkins = repos.listCheckins(pet.id);
  const visited = new Map(checkins.map((c) => [c.destinationId, c.visitedAt]));
  return DESTINATIONS.map((d) => {
    const at = visited.get(d.id);
    return {
      id: `badge-${d.id}`,
      petId: pet.id,
      destinationId: d.id,
      name: d.name,
      emoji: d.emoji,
      unlocked: Boolean(at),
      unlockedAt: at,
    };
  });
}

export interface CheckinOutcome {
  checkin: Checkin;
  pet: Pet;
  gain: number;
  storyChapter: { index: number; title: string; content: string } | null;
  badge: Badge | null;
  unlockedSkin: Destination['exclusiveSkin'] | null;
  blindBox: { name: string; emoji: string; rarity: string } | null;
  revisitMemory: string | null;
  journal: JournalEntry;
  postcard: Postcard;
  travelAlert: string;
}

export async function performCheckin(
  repos: Repositories,
  petInput: Pet,
  input: { destinationId: string; photoUrl?: string | null; lat?: number; lng?: number; note?: string },
): Promise<CheckinOutcome> {
  const destination = destinationById(input.destinationId);
  if (!destination) throw new Error('DESTINATION_NOT_FOUND');

  const pet = refreshPetState(repos, petInput);
  const previous = repos.listCheckins(pet.id).filter((c) => c.destinationId === destination.id);
  const isRevisit = previous.length > 0;

  // 1. 图像合成：角色锁定（带 masterId，禁止重新画一只）
  const composer = activeImageProvider();
  let composedPhotoUrl = input.photoUrl ?? '';
  let imageDegraded = false;
  try {
    const composed = await composer.compose({
      scenePhotoUrl: input.photoUrl ?? null,
      masterId: pet.asset.masterId,
      masterReferenceUrl: pet.asset.pbrTextures.baseColor ?? pet.asset.fallbackRenderUrl,
      speciesLabel: speciesLabel(pet.species),
      petName: pet.name,
      scene: {
        id: destination.scene,
        name: destination.name,
        lightAngle: sceneLightAngle(destination.scene),
        ambient: sceneAmbient(destination.scene),
      },
      intent: 'checkin-photo',
      extraPrompt: input.note,
    });
    composedPhotoUrl = composed.imageUrl;
    imageDegraded = composed.degraded;
  } catch {
    composedPhotoUrl = pet.asset.fallbackRenderUrl;
    imageDegraded = true;
  }

  // 2. 旅行盲盒（说明书 7.2-⑥）
  const seed = hashString(`${pet.id}-${destination.id}-${previous.length}`);
  const souvenir = destination.souvenirPool[Math.floor(seed * destination.souvenirPool.length) % destination.souvenirPool.length]!;

  // 3. 时光机：再次到访的回忆（说明书 7.2-⑨）
  let revisitMemory: string | null = null;
  if (isRevisit) {
    const last = previous[previous.length - 1]!;
    const daysAgo = Math.max(1, Math.round((Date.now() - new Date(last.visitedAt).getTime()) / 86_400_000));
    revisitMemory = revisitLine(pet, destination, last.visitedAt, daysAgo);
  }

  // 4. 剧情章节：到访次数即章节进度
  const chapterIndex = Math.min(previous.length + 1, destination.storyChapters.length);
  const storyChapter = isRevisit
    ? (destination.storyChapters[chapterIndex - 1] ?? null)
    : (destination.storyChapters[0] ?? null);

  // 5. 天气播报（说明书 7.2-⑩）
  const weather = fakeWeather(destination.id, seed);

  // 6. 写手账 + 明信片
  const journal = generateJournal({
    pet,
    destination,
    checkinId: null,
    composedPhotoUrl,
    revisitMemory,
    extraNote: input.note,
    weather,
  });
  const postcard = generatePostcard({ pet, destination, checkinId: null });

  const checkin: Checkin = {
    id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    petId: pet.id,
    userId: pet.ownerId,
    destinationId: destination.id,
    destinationName: destination.name,
    photoUrl: input.photoUrl ?? null,
    composedPhotoUrl,
    petCaption: postcard.text,
    unlockedSkinId: isRevisit ? null : (destination.exclusiveSkin?.id ?? null),
    souvenirId: souvenir.id,
    blindBox: { name: souvenir.name, emoji: souvenir.emoji, rarity: souvenir.rarity },
    revisitMemory,
    visitedAt: nowIso(),
    lat: input.lat,
    lng: input.lng,
  };
  repos.addCheckin(checkin);
  journal.checkinId = checkin.id;
  postcard.checkinId = checkin.id;
  repos.addJournal(journal);
  repos.addPostcard(postcard);

  // 7. 好感度：每地点一次（说明书 6.1）
  const firstEverVisit = previous.length === 0;
  let nextPet = pet;
  let gain = 0;
  if (firstEverVisit) {
    const applied = applyGain(repos, pet, 'checkin', `打卡 ${destination.name}`);
    nextPet = applied.pet;
    gain = applied.gain;
  }

  // 8. 心愿单解锁
  const wish = repos.listWishlist(pet.id).find((w) => w.destinationId === destination.id && w.status === 'wishing');
  if (wish) {
    repos.updateWishlist(wish.id, { status: 'unlocked', unlockedAt: nowIso() });
    nextPet = {
      ...nextPet,
      ...(destination.exclusiveSkin && !nextPet.unlockedOutfits.includes(destination.exclusiveSkin.id)
        ? { unlockedOutfits: [...nextPet.unlockedOutfits, destination.exclusiveSkin.id] }
        : {}),
      activeScene: nextPet.activeScene,
    };
    repos.savePet(nextPet);
  }

  // 9. 记忆锚点：这次旅行要能被主动提起
  rememberEvent(repos, pet.id, `去过${destination.name}：${storyChapter?.title ?? destination.storyTitle}`, 8, ['checkin', destination.scene]);

  const badge: Badge = {
    id: `badge-${destination.id}`,
    petId: pet.id,
    destinationId: destination.id,
    name: destination.name,
    emoji: destination.emoji,
    unlocked: true,
    unlockedAt: checkin.visitedAt,
  };
  repos.saveBadge(badge);

  return {
    checkin,
    pet: nextPet,
    gain,
    storyChapter,
    badge,
    unlockedSkin: firstEverVisit ? (destination.exclusiveSkin ?? null) : null,
    blindBox: checkin.blindBox ?? null,
    revisitMemory,
    journal,
    postcard,
    travelAlert: travelAlert(pet, destination, weather),
  };
}

/** 城市剧情副本进度（说明书 7.2-②） */
export function storyProgress(repos: Repositories, pet: Pet): {
  unlockedCities: number;
  requiredCities: number;
  storyUnlocked: boolean;
  title: string;
} {
  const cities = new Set(repos.listCheckins(pet.id).map((c) => c.destinationId));
  return {
    unlockedCities: cities.size,
    requiredCities: requirementForFullStory,
    storyUnlocked: cities.size >= requirementForFullStory,
    title: '《一只宠物的第一次远行》',
  };
}

/** 城市限定皮肤解锁检查（说明书 7.2-⑧） */
export function skinUnlockCandidates(repos: Repositories, pet: Pet): string[] {
  const visited = new Set(repos.listCheckins(pet.id).map((c) => c.destinationId));
  return DESTINATIONS.filter((d) => visited.has(d.id) && d.exclusiveSkin).map((d) => d.exclusiveSkin!.id);
}

export const imageDegradedCapability = () =>
  imageIntegrationStatus().find((s) => s.configured && s.provider === 'local-svg-composer') ?? null;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % 1000) / 1000;
}

const SCENE_LIGHT: Record<string, number> = {
  mountain: 70, seaside: 170, city: 135, 'foreign-alley': 200, snow: 210, desert: 60,
};
const SCENE_AMBIENT: Record<string, string> = {
  mountain: 'rgba(190,225,170,0.45)',
  seaside: 'rgba(200,235,245,0.5)',
  city: 'rgba(255,214,170,0.5)',
  'foreign-alley': 'rgba(255,180,120,0.42)',
  snow: 'rgba(180,205,230,0.5)',
  desert: 'rgba(255,220,160,0.55)',
};
export const sceneLightAngle = (scene: string): number => SCENE_LIGHT[scene] ?? 135;
export const sceneAmbient = (scene: string): string => SCENE_AMBIENT[scene] ?? 'rgba(255,214,170,0.5)';

export { speciesById };
