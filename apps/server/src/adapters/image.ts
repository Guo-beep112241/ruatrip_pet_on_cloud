/**
 * 图像合成适配层（说明书 4.x 旅行照片合成 / 7.2-③ AR 同框 / 7.3 明信片工坊）
 *
 * 核心要求：角色锁定（character lock）—— 同一只宠物在不同合成图里外观必须一致，
 * 所以请求里必须带上 assetMaster.masterId 与母版贴图，禁止让服务重新画一只。
 *
 * ⚠️ 需要接入 API 的地方：见 docs/API-INTEGRATION.md §6
 */
import { config } from '../config.ts';
import { logAdapter, toIntegrationStatus, type ProviderMeta } from './types.ts';

export interface ComposeRequest {
  /** 实景照片（可为空 → 纯生成） */
  scenePhotoUrl?: string | null;
  /** 宠物资产母版 id：角色锁定的关键 */
  masterId: string;
  /** 母版参考图（baseColor 贴图或降级渲染图） */
  masterReferenceUrl: string;
  speciesLabel: string;
  petName: string;
  /** 场景与光影，换场景时光影方向必须跟着变 */
  scene: { id: string; name: string; lightAngle: number; ambient: string };
  /** 合成意图 */
  intent: 'checkin-photo' | 'ar-group-photo' | 'postcard';
  extraPrompt?: string;
}

export interface ComposeResult {
  /** 合成图地址（URL 或 data: URL） */
  imageUrl: string;
  provider: string;
  live: boolean;
  /** 是否因为未配置服务而使用本地排版兜底 */
  degraded: boolean;
}

export interface ImageProvider {
  readonly meta: ProviderMeta;
  compose(req: ComposeRequest): Promise<ComposeResult>;
}

/* ------------------------------------------------------------------ */
/* 真实图像合成服务（通用 REST 契约，可对接即梦/通义万相/自建 SD 服务）      */
/* ------------------------------------------------------------------ */
class LiveImageProvider implements ImageProvider {
  readonly meta: ProviderMeta = {
    capability: 'image',
    id: 'custom-image-composer',
    label: '图像合成服务（旅行同框 / 明信片出图）',
    envKeys: ['IMAGE_COMPOSER_API_KEY', 'IMAGE_COMPOSER_BASE_URL'],
    docsUrl: '/docs/API-INTEGRATION.md#6-图像合成',
    note: '通用契约：传入实景照 + 母版参考图 + 光影参数，返回合成图。角色锁定要求带 masterId。',
    configured: Boolean(config.imageComposer.apiKey && config.imageComposer.baseUrl),
  };

  async compose(req: ComposeRequest): Promise<ComposeResult> {
    const res = await fetch(`${config.imageComposer.baseUrl}/compose`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.imageComposer.apiKey}`,
      },
      body: JSON.stringify({
        scene_photo_url: req.scenePhotoUrl,
        character_reference_url: req.masterReferenceUrl,
        character_lock_id: req.masterId,
        intent: req.intent,
        prompt: [
          `Place the same ${req.speciesLabel} named ${req.petName} into this scene.`,
          `Scene: ${req.scene.name}. Light direction ${req.scene.lightAngle}°, ambient ${req.scene.ambient}.`,
          'Match the scene light direction on the subject; keep fur color, pattern and body proportion identical to the reference.',
          req.extraPrompt ?? '',
        ].join(' '),
      }),
    });
    if (!res.ok) throw new Error(`image composer ${res.status}`);
    const json = (await res.json()) as { image_url?: string };
    if (!json.image_url) throw new Error('image composer: empty image_url');
    return { imageUrl: json.image_url, provider: 'custom-image-composer', live: true, degraded: false };
  }
}

/* ------------------------------------------------------------------ */
/* 本地兜底：用确定性 SVG 合成「宠物出镜照」                              */
/* ------------------------------------------------------------------ */
const SCENE_COLORS: Record<string, [string, string, string]> = {
  city: ['#F3E3CE', '#D9A87C', '#7A5A46'],
  seaside: ['#E6F2F6', '#9CC3CF', '#39596B'],
  mountain: ['#EFF4EC', '#B4C9A1', '#4E6650'],
  'foreign-alley': ['#F4E5DA', '#D9A08A', '#6B3F3A'],
  snow: ['#EDF1F5', '#B9C7D4', '#46586B'],
  desert: ['#F7EDDA', '#E0BE8A', '#7A5C36'],
};

class LocalComposeFallback implements ImageProvider {
  readonly meta: ProviderMeta = {
    capability: 'image',
    id: 'local-svg-composer',
    label: '本地排版合成兜底（SVG，无需 Key）',
    envKeys: [],
    docsUrl: '/docs/API-INTEGRATION.md',
    note: '未接入图像服务时，用 SVG 按场景光影生成「宠物出镜照」占位；构图与文案真实，像素不真实。',
    configured: true,
  };

  async compose(req: ComposeRequest): Promise<ComposeResult> {
    const [c1, c2, c3] = SCENE_COLORS[req.scene.id] ?? SCENE_COLORS.city!;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/><stop offset="55%" stop-color="${c2}"/><stop offset="100%" stop-color="${c3}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.32" cy="0.24" r="0.75">
      <stop offset="0%" stop-color="${req.scene.ambient}"/><stop offset="100%" stop-color="transparent"/>
    </radialGradient>
  </defs>
  <rect width="800" height="600" fill="url(#bg)"/>
  <rect width="800" height="600" fill="url(#glow)"/>
  <circle cx="240" cy="470" r="150" fill="rgba(255,255,255,0.30)"/>
  <text x="240" y="500" font-size="120" text-anchor="middle">${escapeXml(speciesEmoji(req.speciesLabel))}</text>
  <text x="400" y="120" font-family="sans-serif" font-size="30" text-anchor="middle" fill="${c3}" opacity="0.85">${escapeXml(req.petName)} · ${escapeXml(req.scene.name)}</text>
  <text x="400" y="560" font-family="sans-serif" font-size="20" text-anchor="middle" fill="${c3}" opacity="0.65">RuaTrip 本地降级合成 · master ${escapeXml(req.masterId.slice(0, 12))}</text>
</svg>`;
    logAdapter('image fallback → local svg');
    return {
      imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      provider: 'local-svg-composer',
      live: false,
      degraded: true,
    };
  }
}

function speciesEmoji(label: string): string {
  const map: Record<string, string> = {
    布偶猫: '🐱', 柯基: '🐶', 柴犬: '🐕', 垂耳兔: '🐰', 仓鼠: '🐹', 小狐狸: '🦊',
    小鹿: '🦌', 水豚: '🦫', 羊驼: '🦙', 小鸟: '🐦', 混合想象物种: '✨',
  };
  return map[label] ?? '🐾';
}

function escapeXml(input: string): string {
  return input.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string,
  );
}

const providers: ImageProvider[] = [new LiveImageProvider(), new LocalComposeFallback()];
export const imageProviders = () => providers;
export function activeImageProvider(): ImageProvider {
  return providers.find((p) => p.meta.configured) ?? providers[providers.length - 1]!;
}
export const imageIntegrationStatus = () => providers.map((p) => toIntegrationStatus(p.meta));
