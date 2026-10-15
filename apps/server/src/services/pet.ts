/**
 * 宠物生成编排（说明书 4.1 端到端链路 / 3.2-2 生成全异步）
 *
 * 状态机：queued → generating_mesh → texturing → rigging → ready（或 fallback_used）
 * 生成必须一次性：产出写入「资产母版」，后续所有场景都从母版派生。
 */
import type {
  GenerationJob,
  GenerationStage,
  Pet,
  PetAssetMaster,
  PreferenceAnswers,
} from '../../../../packages/shared/src/index.ts';
import { SHOP_ITEMS, SPECIES_CATALOG } from '../../../../packages/shared/src/catalog.ts';
import type { Repositories } from '../repositories/index.ts';
import { activeMeshProvider, buildMeshPrompt } from '../adapters/mesh.ts';
import { activeRigProvider } from '../adapters/rigging.ts';
import { inferProfile, suggestNames } from './inference.ts';
import { buildPersonalityCard, buildQuirks, speciesById, speciesLabel } from './persona.ts';
import { nowIso } from './growth.ts';
import { ensureWishlist } from './travel.ts';

/** 孵化文案：让等待本身成为体验的一部分（说明书 3.2-2） */
export const INCUBATING_LINES = [
  '正在把毛绒的触感揉进模型里……',
  '在调它耳朵的角度，差一点点就不像它了。',
  '给它上色，燕麦白底、暖栗棕的花纹。',
  '绑定骨架中——它试着动了一下爪子。',
  '教它呼吸。待机的时候要有轻微起伏。',
  '还在教它眨眼。这是「活着」的关键感知。',
  '快好了。它已经在里面等你。',
];

const STAGE_PLAN: { stage: GenerationStage; until: number; line: string }[] = [
  { stage: 'queued', until: 0.06, line: '排队中：正在为它准备一块干净的工作台。' },
  { stage: 'generating_mesh', until: 0.5, line: '正在把毛绒的触感揉进模型里……' },
  { stage: 'texturing', until: 0.74, line: '给它上色，按你挑的色卡铺花纹。' },
  { stage: 'rigging', until: 0.96, line: '绑定骨架中——它试着动了一下爪子。' },
  { stage: 'ready', until: 1.01, line: '它准备好了。' },
];

/** 移动端性能：按偏好分级限制面数（说明书 4.7） */
function triangleBudget(bodySize: string, tier: string): number {
  const base = bodySize === 'large' ? 12000 : bodySize === 'medium' ? 9000 : 6000;
  const factor = tier === 'free' ? 0.7 : tier === 'plus' ? 0.85 : 1;
  return Math.round(base * factor);
}

/** 降级渲染资产：没有真实 3D 服务时，前端用它渲染 2D 形象 */
function fallbackRenderUrl(speciesId: string, palette: string[], petName: string): string {
  const species = speciesById(speciesId);
  const params = new URLSearchParams({ species: species.id, palette: palette.join(','), name: petName });
  return `/api/asset/pet.svg?${params.toString()}`;
}

export function createPetFromAnswers(
  repos: Repositories,
  input: { answers: PreferenceAnswers; name: string; callName?: string; userId: string; tier: string },
): { pet: Pet; job: GenerationJob } {
  const { vector } = inferProfile(input.answers);
  const species = speciesById(vector.species);
  const card = buildPersonalityCard(species.id, vector);
  const quirks = buildQuirks(species.id, vector);
  const masterId = `master-${species.id}-${Math.random().toString(36).slice(2, 10)}`;
  const petId = `pet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const displayName = input.name.trim() || suggestNames(species.id)[0]!;
  const asset: PetAssetMaster = {
    masterId,
    // 真实 meshUrl 在生成完成后写入；这里先留空表示尚未产出
    meshUrl: '',
    fallbackRenderUrl: fallbackRenderUrl(species.id, vector.palette, displayName),
    pbrTextures: {},
    rigged: false,
    rigTemplate: species.fallbackRig,
    triangleCount: triangleBudget(vector.bodySize, input.tier),
    version: '1.0.0',
    provider: activeMeshProvider().meta.id,
    createdAt: nowIso(),
  };

  const pet: Pet = {
    id: petId,
    ownerId: input.userId,
    name: displayName,
    callName: input.callName?.trim() || displayName,
    species: species.id,
    vector,
    personality: card,
    asset,
    affection: 0,
    level: 1,
    levelProgress: 0,
    longing: 100,
    quirks,
    stage: 'egg',
    unlockedOutfits: [],
    unlockedScenes: ['home-warm'],
    equippedOutfit: null,
    activeScene: 'home-warm',
    mood: 'happy',
    createdAt: nowIso(),
    lastInteractionAt: nowIso(),
    lastVisitAt: nowIso(),
  };
  repos.savePet(pet);

  const job: GenerationJob = {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    petId,
    stage: 'queued',
    progress: 0,
    provider: asset.provider,
    incubatingLine: INCUBATING_LINES[0]!,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repos.saveJob(job);

  // 异步推进生成（不阻塞请求，前端轮询进度）
  void runGeneration(repos, job.id, pet.id, buildMeshPrompt({
    speciesLabel: speciesLabel(species.id),
    bodySize: vector.bodySize,
    fur: vector.fur,
    palette: vector.palette,
    personality: vector.personality,
  }));

  // 首日体验：立刻给它一张心愿单（说明书 3.1-1）
  ensureWishlist(repos, pet);

  return { pet, job };
}

/** 生成流水线：真实 provider 走提交+轮询，Mock 走时间线模拟 */
async function runGeneration(repos: Repositories, jobId: string, petId: string, prompt: string): Promise<void> {
  const mesh = activeMeshProvider();
  const started = Date.now();
  const totalMs = mesh.meta.id === 'mock' ? 9000 : 90_000;
  let taskId: string | null = null;
  let externalPolled = false;

  const step = async (): Promise<void> => {
    const job = repos.getJob(jobId);
    const pet = repos.getPet(petId);
    if (!job || !pet) return;

    // 1) 提交外部生成任务（只做一次）
    if (!taskId && mesh.meta.id !== 'mock') {
      try {
        const submitted = await mesh.submit({
          speciesPrompt: speciesLabel(pet.species),
          fullPrompt: prompt,
          targetTriangles: pet.asset.triangleCount,
          palette: pet.vector.palette,
          fur: pet.vector.fur,
        });
        taskId = submitted.taskId;
        job.provider = submitted.provider;
        repos.saveJob(job);
      } catch (error) {
        // 提交失败 → 直接用本地降级资产，绝不让用户卡住
        finishWithFallback(repos, job, pet, `生成服务不可用：${String(error).slice(0, 80)}`);
        return;
      }
    }

    let ratio = Math.min(1, (Date.now() - started) / totalMs);
    if (taskId && !externalPolled) {
      try {
        const poll = await mesh.poll(taskId);
        externalPolled = poll.status === 'success' || poll.status === 'failed';
        ratio = Math.max(ratio, poll.progress / 100);
        if (poll.status === 'failed') {
          finishWithFallback(repos, job, pet, poll.error ?? '外部生成失败');
          return;
        }
        if (poll.status === 'success') {
          await finishWithMesh(repos, job, pet, {
            meshUrl: poll.meshUrl ?? '',
            pbr: poll.pbr,
            triangleCount: poll.triangleCount ?? pet.asset.triangleCount,
          });
          return;
        }
      } catch {
        // 轮询异常不致命，继续用时间线推进
      }
    }

    const plan = STAGE_PLAN.find((s) => ratio <= s.until) ?? STAGE_PLAN[STAGE_PLAN.length - 1]!;
    const stageIndex = STAGE_PLAN.findIndex((s) => s.stage === plan.stage);
    job.stage = plan.stage;
    job.progress = Math.min(100, Math.round((stageIndex + ratio) / STAGE_PLAN.length * 100));
    job.incubatingLine = INCUBATING_LINES[Math.min(stageIndex, INCUBATING_LINES.length - 1)]!;
    job.updatedAt = nowIso();
    repos.saveJob(job);

    if (ratio >= 1) {
      if (taskId) {
        // 外部任务尚未完成但时间线到了 → 用当前结果收尾，避免无限等待
        await finishWithMesh(repos, job, pet, { meshUrl: '', pbr: undefined, triangleCount: pet.asset.triangleCount });
      } else {
        await finishWithMock(repos, job, pet);
      }
      return;
    }
    setTimeout(() => void step(), mesh.meta.id === 'mock' ? 700 : 3500);
  };

  await step();
}

async function finishWithMock(repos: Repositories, job: GenerationJob, pet: Pet): Promise<void> {
  const rig = await activeRigProvider().rig({
    meshUrl: pet.asset.fallbackRenderUrl,
    fallbackRig: speciesById(pet.species).fallbackRig,
    speciesFamily: speciesById(pet.species).family,
  });
  const nextPet: Pet = {
    ...pet,
    stage: 'young',
    asset: {
      ...pet.asset,
      meshUrl: pet.asset.fallbackRenderUrl,
      rigged: true,
      rigTemplate: rig.rigTemplate,
      version: '1.0.0',
    },
  };
  repos.savePet(nextPet);
  const nextJob: GenerationJob = {
    ...job,
    stage: rig.usedFallback ? 'fallback_used' : 'ready',
    progress: 100,
    incubatingLine: '它准备好了。去打个招呼吧。',
    rigFallbackUsed: rig.usedFallback ? rig.rigTemplate : undefined,
    updatedAt: nowIso(),
  };
  repos.saveJob(nextJob);
}

async function finishWithMesh(
  repos: Repositories,
  job: GenerationJob,
  pet: Pet,
  result: { meshUrl: string; pbr?: { baseColor?: string; normal?: string; roughness?: string }; triangleCount: number },
): Promise<void> {
  const species = speciesById(pet.species);
  const rig = await activeRigProvider().rig({
    meshUrl: result.meshUrl || pet.asset.fallbackRenderUrl,
    fallbackRig: species.fallbackRig,
    speciesFamily: species.family,
  });
  repos.savePet({
    ...pet,
    stage: 'young',
    asset: {
      ...pet.asset,
      meshUrl: result.meshUrl || pet.asset.fallbackRenderUrl,
      pbrTextures: result.pbr ?? pet.asset.pbrTextures,
      rigged: rig.rigged,
      rigTemplate: rig.rigTemplate,
      triangleCount: result.triangleCount,
      version: '1.0.1',
    },
  });
  repos.saveJob({
    ...job,
    stage: rig.usedFallback ? 'fallback_used' : 'ready',
    progress: 100,
    incubatingLine: '它准备好了。去打个招呼吧。',
    rigFallbackUsed: rig.usedFallback ? rig.rigTemplate : undefined,
    updatedAt: nowIso(),
  });
}

function finishWithFallback(repos: Repositories, job: GenerationJob, pet: Pet, reason: string): void {
  repos.savePet({
    ...pet,
    stage: 'young',
    asset: {
      ...pet.asset,
      meshUrl: pet.asset.fallbackRenderUrl,
      rigged: true,
      rigTemplate: speciesById(pet.species).fallbackRig,
    },
  });
  repos.saveJob({
    ...job,
    stage: 'fallback_used',
    progress: 100,
    incubatingLine: '3D 服务暂时不可用，先用本地形象陪你。',
    rigFallbackUsed: `fallback: ${reason}`,
    updatedAt: nowIso(),
  });
}

/* ------------------------------------------------------------------ */
/* 商店与兑换（说明书 6.1 消耗方式；好感度不可购买）                       */
/* ------------------------------------------------------------------ */
export function shopFor(repos: Repositories, pet: Pet): { items: typeof SHOP_ITEMS; affection: number; owned: string[] } {
  const owned = [...pet.unlockedOutfits, ...pet.unlockedScenes];
  return { items: SHOP_ITEMS, affection: pet.affection, owned };
}

export function redeem(
  repos: Repositories,
  pet: Pet,
  itemId: string,
): { pet: Pet; item: (typeof SHOP_ITEMS)[number]; spent: number; message: string } {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) throw new Error('ITEM_NOT_FOUND');
  if (pet.affection < item.price) throw new Error('NOT_ENOUGH_AFFECTION');

  const nextPet: Pet = {
    ...pet,
    affection: pet.affection - item.price,
    unlockedOutfits: item.kind === 'outfit' ? [...new Set([...pet.unlockedOutfits, item.id])] : pet.unlockedOutfits,
    unlockedScenes: item.kind === 'scene' ? [...new Set([...pet.unlockedScenes, item.id])] : pet.unlockedScenes,
    equippedOutfit: item.kind === 'outfit' ? item.id : pet.equippedOutfit,
    activeScene: item.kind === 'scene' ? item.id : pet.activeScene,
  };
  repos.savePet(nextPet);
  repos.addInteraction({
    id: `aff-${Date.now()}-redeem`,
    petId: pet.id,
    action: 'streak' as never,
    gain: -item.price,
    cappedGain: 0,
    createdAt: nowIso(),
    note: `兑换 ${item.name}`,
  });
  return { pet: nextPet, item, spent: item.price, message: `用 ${item.price} 点好感度换到了「${item.name}」。` };
}

export { SPECIES_CATALOG };
