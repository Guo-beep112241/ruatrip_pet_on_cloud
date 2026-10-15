/**
 * 外部能力注册表：汇总所有需要「介入 API」的位置，供前端「我的 → 能力接入」展示。
 */
import type { IntegrationStatus } from '../../../../packages/shared/src/index.ts';
import { chatIntegrationStatus, getLastLlmError } from './chat.ts';
import { meshIntegrationStatus } from './mesh.ts';
import { rigIntegrationStatus } from './rigging.ts';
import { asrIntegrationStatus, ttsIntegrationStatus } from './tts.ts';
import { imageIntegrationStatus } from './image.ts';
import { toIntegrationStatus, type ProviderMeta } from './types.ts';
import { config, hasObjectStorage } from '../config.ts';

/**
 * 已实现但需要配置才能启用的通道。
 *
 * ⚠️ 这个列表曾经叫 PENDING_CHANNELS 并写死 `configured: false` + 错误的变量名
 * （例如推送写成 PUSH_SERVER_KEY，而代码实际读 PUSH_VAPID_*）。
 * 结果是「我的 → 能力接入」面板对用户说谎：功能明明已经实现，
 * 面板却说「尚未实现」，还给出填了也不生效的变量名。
 *
 * 现在每一项都用**惰性 getter** 真实反映配置状态，
 * 变量名与 config.ts 读取的完全一致（有测试锁定，见 integration-registry.test.ts）。
 */
export const CONFIGURABLE_CHANNELS: ProviderMeta[] = [
  {
    capability: 'payment',
    id: 'payment',
    label: '支付与订阅（App Store / 微信支付 / 支付宝）',
    envKeys: ['PAYMENT_PROVIDER', 'PAYMENT_MERCHANT_ID', 'PAYMENT_API_KEY'],
    docsUrl: '/docs/API-INTEGRATION.md#7-支付与订阅',
    note: '消费限额与宠物位配额已生效（未成年人单笔 ¥50、月上限硬封顶 ¥500）。配好支付后订阅不再是「模拟开通」，扣款由支付通道完成，限额逻辑不变。',
    // 只有配了 api key 才算接入；未配时订阅走模拟但**仍然受限额约束**
    configured: () => Boolean(config.payment.providerKey),
  },
  {
    capability: 'storage',
    id: 'object-storage',
    label: '对象存储 + CDN（照片与资产母版分发）',
    envKeys: [
      'STORAGE_DRIVER',
      'STORAGE_ENDPOINT',
      'STORAGE_BUCKET',
      'STORAGE_ACCESS_KEY',
      'STORAGE_SECRET_KEY',
      'CDN_BASE_URL',
      'STORAGE_FORCE_PATH_STYLE',
    ],
    docsUrl: '/docs/API-INTEGRATION.md#8-对象存储与-cdn',
    note: '默认已切到本地磁盘存储（照片不再以 data URL 存进 JSON，实测同样操作的数据体积从 13.5MB 降到 316 字节）。配上 S3 兼容存储（R2 / COS / OSS / MinIO）后容器重建不丢图。',
    configured: () => hasObjectStorage(),
  },
  {
    capability: 'push',
    id: 'push-notification',
    label: '推送通知（想念值召回 / 生成完成通知）',
    envKeys: ['PUSH_ENDPOINT', 'PUSH_VAPID_PUBLIC_KEY', 'PUSH_VAPID_PRIVATE_KEY'],
    docsUrl: '/docs/API-INTEGRATION.md#9-推送通知',
    note: '触发点与文案已就位。未配置时使用应用内通知列表（用户离开应用收不到提醒，接口会如实返回 channel: local，不会假装投递成功）。微信内置浏览器完全不支持 Web Push。',
    configured: () =>
      Boolean(config.push.endpoint && config.push.publicKey && config.push.privateKey),
  },
  {
    capability: 'analytics',
    id: 'analytics',
    label: '行为埋点与留存分析',
    envKeys: ['ANALYTICS_ENDPOINT', 'ANALYTICS_WRITE_KEY'],
    docsUrl: '/docs/API-INTEGRATION.md#10-行为埋点',
    note: '已埋 30+ 个关键事件（漏斗、核心循环、对话分层、商业化、关怀）。未配置时事件留在进程内，可用 GET /api/analytics/export 导出。只上报行为计数，不含对话内容与照片。',
    configured: () => Boolean(config.analytics.endpoint && config.analytics.writeKey),
  },
];
export function integrationReport(): {
  items: IntegrationStatus[];
  mode: 'mock-all' | 'partial' | 'live-all';
  summary: string;
  lastError: string | null;
} {
  const groups = [
    chatIntegrationStatus(),
    meshIntegrationStatus(),
    rigIntegrationStatus(),
    ttsIntegrationStatus(),
    asrIntegrationStatus(),
    imageIntegrationStatus(),
    CONFIGURABLE_CHANNELS.map(toIntegrationStatus),
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
  return { items, mode, summary, lastError: getLastLlmError() };
}

export { toIntegrationStatus };
