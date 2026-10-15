/**
 * 自动绑定骨骼与动画适配层（说明书 4.3）
 *
 * 现实约束：超出猫狗之后，自动绑定失败率明显上升。
 * 因此本层的策略是「能绑则绑，不能绑就套通用骨架」，保证体验不中断。
 */
import { config } from '../config.ts';
import { logAdapter, isConfigured, toIntegrationStatus, type ProviderMeta } from './types.ts';

export type SkeletonTemplate = 'quadruped' | 'biped' | 'avian';

export interface RigRequest {
  meshUrl: string;
  /** 来自物种库的兜底骨架 */
  fallbackRig: SkeletonTemplate;
  speciesFamily: string;
}

export interface RigResult {
  rigged: boolean;
  rigTemplate: string;
  /** 是否使用了兜底骨架 */
  usedFallback: boolean;
  animationLibrary: string[];
  provider: string;
  live: boolean;
}

export interface RigProvider {
  readonly meta: ProviderMeta;
  rig(req: RigRequest): Promise<RigResult>;
}

/** 通用动作集：待机/互动/情绪，前端动画状态机按 key 播放 */
export const DEFAULT_ANIMATION_LIBRARY = [
  'idle-breathe', 'idle-blink', 'idle-tail-wag',
  'eat-happy', 'eat-fast', 'bath-shake', 'bath-fluffy',
  'play-pounce', 'play-roll', 'play-chase',
  'talk-nod', 'talk-tilt', 'talk-paw',
  'mood-proud', 'mood-shy', 'mood-sleepy', 'mood-lonely',
  'reunion-run', 'reunion-hug',
];

/* ------------------------------------------------------------------ */
/* Anything World —— 专门面向非人形对象的自动绑定（关键推荐）              */
/* ------------------------------------------------------------------ */
class AnythingWorldProvider implements RigProvider {
  readonly meta: ProviderMeta = {
    capability: 'rigging',
    id: 'anything-world',
    label: 'Anything World（任意动物自动绑定 + 动物动画库）',
    envKeys: ['ANYTHING_WORLD_API_KEY'],
    docsUrl: 'https://docs.anything.world/',
    note: '关键推荐：专门面向非人形对象、覆盖大量动物种类，正好匹配「物种不限于猫狗」的需求。',
    get configured() {
      return Boolean(config.anythingWorld.apiKey);
    },
  };

  async rig(req: RigRequest): Promise<RigResult> {
    const res = await fetch(`${config.anythingWorld.baseUrl}/api/v2/rig`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.anythingWorld.apiKey}`,
      },
      body: JSON.stringify({ model_url: req.meshUrl, auto_rig: true, animations: DEFAULT_ANIMATION_LIBRARY }),
    });
    if (!res.ok) throw new Error(`anything-world ${res.status}`);
    const json = (await res.json()) as { rigged?: boolean; skeleton?: string; animations?: string[] };
    return {
      rigged: json.rigged ?? true,
      rigTemplate: json.skeleton ?? req.fallbackRig,
      usedFallback: false,
      animationLibrary: json.animations ?? DEFAULT_ANIMATION_LIBRARY,
      provider: 'anything-world',
      live: true,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Mock / 兜底骨架                                                      */
/* ------------------------------------------------------------------ */
class FallbackRigProvider implements RigProvider {
  readonly meta: ProviderMeta = {
    capability: 'rigging',
    id: 'universal-skeleton',
    label: '通用骨架模板（绑定兜底）',
    envKeys: [],
    docsUrl: '/docs/API-INTEGRATION.md#0-一分钟总览',
    note: '稀有物种绑定失败时自动套用通用四足/鸟类骨架，动作集降级为通用动作，体验不中断。',
    configured: true,
  };

  async rig(req: RigRequest): Promise<RigResult> {
    logAdapter('rig fallback', `${req.speciesFamily} → ${req.fallbackRig}`);
    return {
      rigged: true,
      rigTemplate: req.fallbackRig,
      usedFallback: true,
      animationLibrary: DEFAULT_ANIMATION_LIBRARY,
      provider: 'universal-skeleton',
      live: false,
    };
  }
}

/**
 * Mock 绑定：没有外部服务时，直接按物种套用对应骨架模板。
 * 这不算「兜底降级」——它是 Mock 模式下的正规路径，所以 usedFallback = false。
 */
class MockRigProvider implements RigProvider {
  readonly meta: ProviderMeta = {
    capability: 'rigging',
    id: 'mock',
    label: 'Mock 绑定（按物种套用骨架模板）',
    envKeys: [],
    docsUrl: '/docs/API-INTEGRATION.md#0-一分钟总览',
    note: 'Mock 模式下按物种族直接套用四足/鸟类骨架与通用动作集；接入 Anything World 后同一接口直接替换。',
    get configured() {
      // 只有装了 Anything World 才轮到兜底骨架；否则 Mock 绑定才是正规路径
      return !config.anythingWorld.apiKey;
    },
  };

  async rig(req: RigRequest): Promise<RigResult> {
    return {
      rigged: true,
      rigTemplate: req.fallbackRig,
      usedFallback: false,
      animationLibrary: DEFAULT_ANIMATION_LIBRARY,
      provider: 'mock',
      live: false,
    };
  }
}

const providers: RigProvider[] = [new AnythingWorldProvider(), new MockRigProvider(), new FallbackRigProvider()];
export const rigProviders = () => providers;
export function activeRigProvider(): RigProvider {
  return providers.find((p) => isConfigured(p.meta)) ?? providers[providers.length - 1]!;
}
export const rigIntegrationStatus = () => providers.map((p) => toIntegrationStatus(p.meta));
