/**
 * 外部能力适配层统一契约。
 *
 * 说明书的「接口可替换」原则（第十章关键工程原则 5）在这里落地：
 * 每个能力都有一组 Provider 实现，registry 依据环境变量挑选。
 * 任何一个未配置时都会回落到 Mock Provider，页面功能不缺失，
 * 但会在 /api/integration 与前端「能力接入」面板中明确标注。
 */
import type { IntegrationStatus } from '../../../../packages/shared/src/index.ts';

export type Capability =
  | 'chat'
  | 'threed'
  | 'rigging'
  | 'tts'
  | 'asr'
  | 'image'
  | 'payment'
  | 'storage'
  | 'push'
  | 'analytics';

export interface ProviderMeta {
  capability: Capability;
  /** provider 标识，例如 anthropic / tripo / mock */
  id: string;
  label: string;
  /** 依赖的环境变量 key，用于前端提示「需要配置哪些 key」 */
  envKeys: string[];
  docsUrl: string;
  note: string;
  /**
   * 是否已配置。
   * 允许写成 getter，因为 config 是惰性读环境变量的：
   * 用普通布尔字段会在模块加载时被定格，改完 .env 就不生效了。
   */
  configured: boolean | (() => boolean);
}

/** 统一读法：兼容布尔值与 getter 两种写法 */
export function isConfigured(meta: ProviderMeta): boolean {
  return typeof meta.configured === 'function' ? meta.configured() : meta.configured;
}

export interface ProviderEntry<T> {
  meta: ProviderMeta;
  impl: T;
}

export function toIntegrationStatus(meta: ProviderMeta): IntegrationStatus {
  return {
    key: `${meta.capability}:${meta.id}`,
    label: meta.label,
    category: meta.capability,
    configured: isConfigured(meta),
    provider: meta.id,
    envKeys: meta.envKeys,
    docsUrl: meta.docsUrl,
    note: meta.note,
  };
}

/** 统一的 adapter 观测日志（便于用户在服务端控制台看到真实调用） */
export function logAdapter(message: string, detail?: unknown): void {
  const stamp = new Date().toISOString();
  if (detail === undefined) console.log(`[ruatrip:adapter] ${stamp} ${message}`);
  else console.log(`[ruatrip:adapter] ${stamp} ${message}`, typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400));
}
