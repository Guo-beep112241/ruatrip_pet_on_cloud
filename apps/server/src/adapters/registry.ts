/**
 * 外部能力注册表：汇总所有需要「介入 API」的位置，供前端「我的 → 能力接入」展示。
 */
import type { IntegrationStatus } from '../../../../packages/shared/src/index.ts';
import { chatIntegrationStatus } from './chat.ts';
import { meshIntegrationStatus } from './mesh.ts';
import { rigIntegrationStatus } from './rigging.ts';
import { asrIntegrationStatus, ttsIntegrationStatus } from './tts.ts';
import { imageIntegrationStatus } from './image.ts';
import { toIntegrationStatus, type ProviderMeta } from './types.ts';

/** 尚未在代码里实现、但产品上线必须接的通道（说明书 十一 商业化 / 2.5 风险） */
export const PENDING_CHANNELS: ProviderMeta[] = [
  {
    capability: 'payment',
    id: 'payment',
    label: '支付与订阅（App Store / 微信支付 / 支付宝）',
    envKeys: ['PAYMENT_PROVIDER', 'PAYMENT_MERCHANT_ID', 'PAYMENT_API_KEY'],
    docsUrl: '/docs/API-INTEGRATION.md#7-支付与订阅',
    note: '当前订阅是「模拟开通」，只写状态不扣款。上线前必须接真实支付并补未成年人消费限额。',
    configured: false,
  },
  {
    capability: 'storage',
    id: 'object-storage',
    label: '对象存储 + CDN（3D 资产母版分发）',
    envKeys: ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY', 'CDN_BASE_URL'],
    docsUrl: '/docs/API-INTEGRATION.md#8-对象存储与-cdn',
    note: '用户上传照片、母版 GLB、PBR 贴图、合成图都需要持久化与版本化分发；当前只存 data URL。',
    configured: false,
  },
  {
    capability: 'push',
    id: 'push-notification',
    label: '推送通知（想念值提醒 / 生成完成通知）',
    envKeys: ['PUSH_PROVIDER', 'PUSH_SERVER_KEY'],
    docsUrl: '/docs/API-INTEGRATION.md#9-推送通知',
    note: '「宠物想你了」的召回与异步生成完成通知依赖推送；Web 端可先用 Notification API。',
    configured: false,
  },
  {
    capability: 'analytics',
    id: 'analytics',
    label: '行为埋点与留存分析',
    envKeys: ['ANALYTICS_WRITE_KEY'],
    docsUrl: '/docs/API-INTEGRATION.md#10-埋点',
    note: '说明书 2.5 风险 3 要求用首版埋点验证好感度曲线与留存挂钩。',
    configured: false,
  },
];

export function integrationReport(): {
  items: IntegrationStatus[];
  mode: 'mock-all' | 'partial' | 'live-all';
  summary: string;
} {
  const groups = [
    chatIntegrationStatus(),
    meshIntegrationStatus(),
    rigIntegrationStatus(),
    ttsIntegrationStatus(),
    asrIntegrationStatus(),
    imageIntegrationStatus(),
    PENDING_CHANNELS.map(toIntegrationStatus),
  ];
  const items = groups.flat();
  const live = items.filter((i) => i.configured && i.provider !== 'mock' && i.provider !== 'local-svg-composer'
    && i.provider !== 'browser-web-speech' && i.provider !== 'universal-skeleton');
  const mode = live.length === 0 ? 'mock-all' : live.length >= 3 ? 'live-all' : 'partial';
  const summary =
    mode === 'mock-all'
      ? '当前全部能力运行在 Mock 模式：网站功能完整可用，3D 形象、语音、照片合成为本地降级实现。'
      : mode === 'partial'
        ? `已接入 ${live.length} 个真实通道：${live.map((l) => l.label).join('、')}。其余仍为 Mock。`
        : '真实通道基本齐全，可进行生产环境验证。';
  return { items, mode, summary };
}

export { toIntegrationStatus };
