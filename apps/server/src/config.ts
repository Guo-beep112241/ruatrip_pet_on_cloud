/**
 * 服务端配置：集中读取环境变量，并对外暴露「哪些外部能力已配置」。
 * 前端永远拿不到任何密钥，只能拿到 IntegrationStatus 清单。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');

/** 极简 .env 读取（无第三方依赖） */
function loadDotEnv(): void {
  const candidates = [resolve(REPO_ROOT, '.env'), resolve(REPO_ROOT, '.env.local')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadDotEnv();

const str = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;
const num = (key: string, fallback: number): number => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 8787),
  dataDir: resolve(REPO_ROOT, str('DATA_DIR', './.data')),
  corsOrigins: str('CORS_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** 服务端持有的 AI/3D/语音能力凭证 */
  anthropic: {
    apiKey: str('ANTHROPIC_API_KEY'),
    baseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    model: str('CHAT_MODEL', 'claude-sonnet-4-5'),
  },
  openaiCompat: {
    apiKey: str('OPENAI_API_KEY'),
    baseUrl: str('OPENAI_BASE_URL'),
    model: str('OPENAI_MODEL'),
  },
  tripo: {
    apiKey: str('TRIPO_API_KEY'),
    baseUrl: str('TRIPO_BASE_URL', 'https://api.tripo3d.ai/v2/openapi'),
  },
  meshy: {
    apiKey: str('MESHY_API_KEY'),
    baseUrl: str('MESHY_BASE_URL', 'https://api.meshy.ai/openapi/v2'),
  },
  anythingWorld: {
    apiKey: str('ANYTHING_WORLD_API_KEY'),
    baseUrl: str('ANYTHING_WORLD_BASE_URL', 'https://api.anything.world'),
  },
  minimax: {
    apiKey: str('MINIMAX_API_KEY'),
    groupId: str('MINIMAX_GROUP_ID'),
    baseUrl: str('MINIMAX_BASE_URL', 'https://api.minimax.chat/v1'),
  },
  elevenlabs: {
    apiKey: str('ELEVENLABS_API_KEY'),
    baseUrl: str('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io/v1'),
  },
  asr: {
    apiKey: str('ASR_API_KEY'),
    baseUrl: str('ASR_BASE_URL'),
    model: str('ASR_MODEL'),
  },
  imageComposer: {
    apiKey: str('IMAGE_COMPOSER_API_KEY'),
    baseUrl: str('IMAGE_COMPOSER_BASE_URL'),
  },
} as const;

export type AppConfig = typeof config;

/** 便捷判断：没有配任何大模型 → 对话走本地预设池 + 模板拼装 */
export const hasLlm = (): boolean =>
  Boolean(config.anthropic.apiKey) || Boolean(config.openaiCompat.apiKey && config.openaiCompat.baseUrl);

export const has3dProvider = (): boolean =>
  Boolean(config.tripo.apiKey) || Boolean(config.meshy.apiKey);

export const hasRigging = (): boolean => Boolean(config.anythingWorld.apiKey);

export const hasTts = (): boolean => Boolean(config.minimax.apiKey) || Boolean(config.elevenlabs.apiKey);

export const hasAsr = (): boolean => Boolean(config.asr.apiKey && config.asr.baseUrl);

export const hasImageComposer = (): boolean => Boolean(config.imageComposer.apiKey && config.imageComposer.baseUrl);
