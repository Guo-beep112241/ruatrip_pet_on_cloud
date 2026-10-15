/**
 * 服务端配置。
 *
 * 设计要点：所有取值都是**惰性 getter**，每次访问都重新读 process.env。
 * 这样有两个好处：
 *   1. 改完 .env 不必重启进程（开发时很省事）；
 *   2. 测试可以直接改 process.env 来验证不同供应商分支，不必反复重载模块。
 *
 * 前端永远拿不到任何密钥，只能拿到 IntegrationStatus 清单。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server/src -> 仓库根 */
export const REPO_ROOT = resolve(here, '../../..');

let envLoaded = false;

/** 极简 .env 读取（无第三方依赖）。已存在的真实环境变量优先，不会被覆盖。 */
export function loadDotEnv(force = false): void {
  if (envLoaded && !force) return;
  envLoaded = true;
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
/** 一组变量中取第一个非空值（用于通用变量 + 向后兼容别名） */
const first = (...keys: string[]): string => {
  for (const key of keys) {
    const value = str(key);
    if (value) return value;
  }
  return '';
};

export const config = {
  /** 每次访问都重新读，保证 .env 改动即时生效 */
  get env(): string {
    return str('NODE_ENV', 'development');
  },
  get port(): number {
    return num('PORT', 8787);
  },
  get dataDir(): string {
    return resolve(REPO_ROOT, str('DATA_DIR', './.data'));
  },
  get corsOrigins(): string[] {
    return str('CORS_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },

  /** 服务端持有的 AI/3D/语音能力凭证 */
  anthropic: {
    get apiKey() {
      return str('ANTHROPIC_API_KEY');
    },
    get baseUrl() {
      return str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com');
    },
    get model() {
      return str('CHAT_MODEL', 'claude-sonnet-4-5');
    },
  },

  /**
   * 通用「OpenAI 兼容」对话通道。
   *
   * 绝大多数国产模型都提供 OpenAI 兼容端点（DeepSeek / 智谱 / 通义 / Kimi / 硅基流动 / 自建 vLLM），
   * 所以这里只留一组通用变量。LLM_* 优先，OPENAI_* 作为向后兼容的别名。
   */
  llm: {
    get apiKey() {
      return first('LLM_API_KEY', 'OPENAI_API_KEY');
    },
    get baseUrl() {
      return first('LLM_BASE_URL', 'OPENAI_BASE_URL');
    },
    get model() {
      return first('LLM_MODEL', 'OPENAI_MODEL');
    },
  },

  tripo: {
    get apiKey() {
      return str('TRIPO_API_KEY');
    },
    /** 官方已迁到 v3，且域名换成 openapi.tripo3d.com */
    get baseUrl() {
      return str('TRIPO_BASE_URL', 'https://openapi.tripo3d.com/v3');
    },
  },
  meshy: {
    get apiKey() {
      return str('MESHY_API_KEY');
    },
    get baseUrl() {
      return str('MESHY_BASE_URL', 'https://api.meshy.ai/openapi/v2');
    },
  },
  anythingWorld: {
    get apiKey() {
      return str('ANYTHING_WORLD_API_KEY');
    },
    get baseUrl() {
      return str('ANYTHING_WORLD_BASE_URL', 'https://api.anything.world');
    },
  },
  minimax: {
    get apiKey() {
      return str('MINIMAX_API_KEY');
    },
    get groupId() {
      return str('MINIMAX_GROUP_ID');
    },
    get baseUrl() {
      return str('MINIMAX_BASE_URL', 'https://api.minimax.chat/v1');
    },
  },
  elevenlabs: {
    get apiKey() {
      return str('ELEVENLABS_API_KEY');
    },
    get baseUrl() {
      return str('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io/v1');
    },
  },
  asr: {
    get apiKey() {
      return str('ASR_API_KEY');
    },
    get baseUrl() {
      return str('ASR_BASE_URL');
    },
    get model() {
      return str('ASR_MODEL');
    },
  },
  imageComposer: {
    get apiKey() {
      return str('IMAGE_COMPOSER_API_KEY');
    },
    get baseUrl() {
      return str('IMAGE_COMPOSER_BASE_URL');
    },
  },
};

export type AppConfig = typeof config;

/** 便捷判断：没有配任何大模型 → 对话走本地预设池 + 模板拼装 */
export const hasLlm = (): boolean =>
  Boolean(config.anthropic.apiKey) || Boolean(config.llm.apiKey && config.llm.baseUrl);

export const has3dProvider = (): boolean =>
  Boolean(config.tripo.apiKey) || Boolean(config.meshy.apiKey);

export const hasRigging = (): boolean => Boolean(config.anythingWorld.apiKey);

export const hasTts = (): boolean => Boolean(config.minimax.apiKey) || Boolean(config.elevenlabs.apiKey);

export const hasAsr = (): boolean => Boolean(config.asr.apiKey && config.asr.baseUrl);

export const hasImageComposer = (): boolean => Boolean(config.imageComposer.apiKey && config.imageComposer.baseUrl);
