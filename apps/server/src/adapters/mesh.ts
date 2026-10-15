/**
 * 3D 形象生成适配层（说明书 4.2）
 *
 * 真实接入优先级：Tripo → Meshy → Mock。
 * 关键工程约束（必须在接入时守住）：
 *   1. 生成是一次性的，产出写入「资产母版」，之后所有场景复用，禁止重新生成；
 *   2. 生成是全异步的，本层只返回 taskId，进度由轮询 /api/pet/generation/:jobId 获取；
 *   3. 面数上限、贴图压缩、格式转换由 prompt/参数控制（说明书 4.7）。
 *
 * ⚠️ 需要接入 API 的地方：见 docs/API-INTEGRATION.md §2
 */
import { config } from '../config.ts';
import { logAdapter, isConfigured, toIntegrationStatus, type ProviderMeta } from './types.ts';

export interface MeshRequest {
  /** 物种提示词 */
  speciesPrompt: string;
  /** 由偏好向量拼出的完整 prompt */
  fullPrompt: string;
  /** 用户上传的参考图（图生 3D / 已逝宠物复原时使用） */
  referenceImageUrl?: string;
  /** 目标面数上限（移动端性能） */
  targetTriangles: number;
  /** 配色偏好 */
  palette: string[];
  fur: string;
}

export interface MeshSubmitResult {
  /** 外部服务任务 id；Mock 时为本地 job id */
  taskId: string;
  provider: string;
  live: boolean;
}
export interface MeshPollResult {
  status: 'pending' | 'running' | 'success' | 'failed';
  /** 0~100 */
  progress: number;
  meshUrl?: string;
  pbr?: { baseColor?: string; normal?: string; roughness?: string };
  triangleCount?: number;
  error?: string;
}

export interface MeshProvider {
  readonly meta: ProviderMeta;
  submit(req: MeshRequest): Promise<MeshSubmitResult>;
  poll(taskId: string): Promise<MeshPollResult>;
}

/* ------------------------------------------------------------------ */
/* Tripo AI                                                            */
/* ------------------------------------------------------------------ */
class TripoProvider implements MeshProvider {
  readonly meta: ProviderMeta = {
    capability: 'threed',
    id: 'tripo',
    label: 'Tripo AI（主力 3D 生成 + 内置绑定）',
    envKeys: ['TRIPO_API_KEY'],
    docsUrl: 'https://platform.tripo3d.ai/docs/introduction',
    note: '一次调用可走完「文/图生 3D → 贴图 → 自动绑定」，接口完整、单次成本低，适合 MVP 主力链路。',
    get configured() {
      return Boolean(config.tripo.apiKey);
    },
  };

  async submit(req: MeshRequest): Promise<MeshSubmitResult> {
    const body: Record<string, unknown> = {
      type: req.referenceImageUrl ? 'image_to_model' : 'text_to_model',
      model_version: 'v2.5-20250123',
      face_limit: req.targetTriangles,
      texture: true,
      pbr: true,
      text_to_model: req.referenceImageUrl ? undefined : { prompt: req.fullPrompt },
      image_to_model: req.referenceImageUrl ? { file: { url: req.referenceImageUrl } } : undefined,
    };
    const res = await fetch(`${config.tripo.baseUrl}/task`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.tripo.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`tripo submit ${res.status} ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { code: number; data?: { task_id?: string } };
    const taskId = json.data?.task_id;
    if (!taskId) throw new Error('tripo submit: no task_id');
    logAdapter('tripo submit ok', taskId);
    return { taskId, provider: 'tripo', live: true };
  }

  async poll(taskId: string): Promise<MeshPollResult> {
    const res = await fetch(`${config.tripo.baseUrl}/task/${taskId}`, {
      headers: { authorization: `Bearer ${config.tripo.apiKey}` },
    });
    if (!res.ok) throw new Error(`tripo poll ${res.status}`);
    const json = (await res.json()) as {
      data?: {
        status?: string;
        progress?: number;
        output?: { pbr_model?: string; model?: string; base_model?: string };
      };
    };
    const status = json.data?.status ?? 'running';
    const map: Record<string, MeshPollResult['status']> = {
      queued: 'pending',
      running: 'running',
      success: 'success',
      failed: 'failed',
      cancelled: 'failed',
      banned: 'failed',
      expired: 'failed',
    };
    return {
      status: map[status] ?? 'running',
      progress: Math.round((json.data?.progress ?? 0)),
      meshUrl: json.data?.output?.pbr_model ?? json.data?.output?.model ?? undefined,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Meshy AI                                                            */
/* ------------------------------------------------------------------ */
class MeshyProvider implements MeshProvider {
  readonly meta: ProviderMeta = {
    capability: 'threed',
    id: 'meshy',
    label: 'Meshy AI（备选 / 量产通道）',
    envKeys: ['MESHY_API_KEY'],
    docsUrl: 'https://docs.meshy.ai/en/api/text-to-3d',
    note: '工程成熟度高、有企业级合规认证，适合规模化调用；作为 Tripo 的双供应商备份，规避单点风险。',
    get configured() {
      return Boolean(config.meshy.apiKey);
    },
  };

  async submit(req: MeshRequest): Promise<MeshSubmitResult> {
    const endpoint = req.referenceImageUrl ? 'image-to-3d' : 'text-to-3d';
    const body: Record<string, unknown> = req.referenceImageUrl
      ? { image_url: req.referenceImageUrl, enable_pbr: true, should_texture: true }
      : {
          mode: 'preview',
          prompt: req.fullPrompt,
          art_style: 'realistic',
          should_remesh: true,
          topology: 'triangle',
          target_polycount: req.targetTriangles,
        };
    const res = await fetch(`${config.meshy.baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.meshy.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`meshy submit ${res.status} ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { result?: string };
    if (!json.result) throw new Error('meshy submit: no result id');
    logAdapter('meshy submit ok', json.result);
    return { taskId: json.result, provider: 'meshy', live: true };
  }

  async poll(taskId: string): Promise<MeshPollResult> {
    const res = await fetch(`${config.meshy.baseUrl}/text-to-3d/${taskId}`, {
      headers: { authorization: `Bearer ${config.meshy.apiKey}` },
    });
    if (!res.ok) throw new Error(`meshy poll ${res.status}`);
    const json = (await res.json()) as {
      status?: string;
      progress?: number;
      model_urls?: { glb?: string };
      texture_urls?: { base_color?: string; normal?: string; roughness?: string }[];
    };
    const map: Record<string, MeshPollResult['status']> = {
      PENDING: 'pending',
      IN_PROGRESS: 'running',
      SUCCEEDED: 'success',
      FAILED: 'failed',
      CANCELED: 'failed',
      EXPIRED: 'failed',
    };
    const tex = json.texture_urls?.[0];
    return {
      status: map[json.status ?? ''] ?? 'running',
      progress: Math.round(json.progress ?? 0),
      meshUrl: json.model_urls?.glb,
      pbr: tex ? { baseColor: tex.base_color, normal: tex.normal, roughness: tex.roughness } : undefined,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Mock：本地占位资产                                                   */
/* ------------------------------------------------------------------ */
class MockMeshProvider implements MeshProvider {
  readonly meta: ProviderMeta = {
    capability: 'threed',
    id: 'mock',
    label: 'Mock 3D 生成（本地占位资产，无需 Key）',
    envKeys: [],
    docsUrl: '/docs/API-INTEGRATION.md#0-一分钟总览',
    note: '不产生真实几何，只登记资产母版元数据并渲染 2D 降级形象；接入 Tripo/Meshy 后同一接口直接替换。',
    configured: true,
  };

  async submit(req: MeshRequest): Promise<MeshSubmitResult> {
    // 真实接入时这里应该是外部 taskId；Mock 下用本地可预测 id
    const taskId = `mock-mesh-${Buffer.from(req.fullPrompt).toString('base64url').slice(0, 12)}`;
    logAdapter('mock mesh submit', taskId);
    return { taskId, provider: 'mock', live: false };
  }

  async poll(): Promise<MeshPollResult> {
    // Mock 的进度由 service 层伪造，这里直接返回成功
    return { status: 'success', progress: 100, triangleCount: 4200 };
  }
}

const providers: MeshProvider[] = [new TripoProvider(), new MeshyProvider(), new MockMeshProvider()];

export function meshProviders(): MeshProvider[] {
  return providers;
}
export function activeMeshProvider(): MeshProvider {
  return providers.find((p) => isConfigured(p.meta)) ?? providers[providers.length - 1]!;
}
export const meshIntegrationStatus = () => providers.map((p) => toIntegrationStatus(p.meta));

/**
 * 由偏好向量拼装生成提示词（说明书 5.3 映射表）。
 * 这段是纯业务逻辑，不依赖任何外部服务。
 */
export function buildMeshPrompt(input: {
  speciesLabel: string;
  bodySize: string;
  fur: string;
  palette: string[];
  personality: string[];
}): string {
  const furWord: Record<string, string> = {
    fluffy: 'thick fluffy plush fur',
    silky: 'silky smooth coat',
    short: 'short coarse fur',
    curly: 'soft curly fleece',
  };
  const sizeWord: Record<string, string> = {
    tiny: 'palm-sized, can fit in a coat pocket',
    small: 'small, one-hand carry',
    medium: 'medium, can be hugged while sleeping',
    large: 'large, can run alongside a person',
  };
  const mood: Record<string, string> = {
    clingy: 'affectionate expression',
    aloof: 'calm aloof expression',
    chaotic: 'wide-eyed mischievous energy',
    mature: 'gentle knowing look',
    tsundere: 'slightly pouting, secretly pleased',
    shy: 'shy downcast eyes, ears half back',
  };
  return [
    `A photorealistic 3D pet character: ${input.speciesLabel}.`,
    `${sizeWord[input.bodySize] ?? 'small companion animal'}.`,
    `Fur: ${furWord[input.fur] ?? 'soft fur'}.`,
    `Color palette: ${input.palette.length ? input.palette.join(', ') : 'oat white, warm chestnut, coral accent'}; soft paper-textured fur shading.`,
    `Personality reading: ${input.personality.map((p) => mood[p] ?? p).join('; ') || 'warm and gentle'}.`,
    'Style: warm afternoon indoor lighting, soft diffuse shadows, no harsh specular highlights, plush-toy softness, PBR textures, clean topology, rig-friendly T-pose.',
    'Optimized for mobile real-time rendering: low polycount, single material atlas, no transparency hair cards.',
  ].join(' ');
}
