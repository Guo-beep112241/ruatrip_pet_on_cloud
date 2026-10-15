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
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server/src -> 仓库根 */
export const REPO_ROOT = resolve(here, '../../..');

/**
 * 哪些变量是进程真实环境给的（不是 .env 文件来的）。
 * 这些必须始终优先，.env 不允许覆盖它们。
 */
const fromRealEnv = new Set(Object.keys(process.env));

/** 上一轮由 .env 文件注入的 key，用于处理「删掉即失效」 */
let previouslyFromFiles = new Set<string>();

/** .env 候选路径；测试可覆盖 envFilePath 来隔离真实文件 */
export const envFiles = [resolve(REPO_ROOT, '.env'), resolve(REPO_ROOT, '.env.local')];
export const envFilePath = envFiles[0]!;

let loadedSignature = '';
let lastObservedSignature = '';

/**
 * 文件指纹：**基于内容**而不是时间戳。
 * 用 mtime 会在「同一毫秒内连续写两次」时漏判（文件系统时间戳精度有限），
 * 内容哈希没有这个盲区，代价是每次读配置多一次几 KB 的文件读取——可以接受。
 */
function envSignature(): string {
  const hash = createHash('sha1');
  for (const file of envFiles) {
    if (!existsSync(file)) {
      hash.update(`${file}:absent\n`);
      continue;
    }
    hash.update(`${file}:`);
    hash.update(readFileSync(file));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * 逐个解析 .env 文件并写进 process.env。
 * 真实环境变量优先；.env 里被注释掉或删掉的 key 会被撤销，保证「删掉即失效」。
 */
function applyEnvFiles(): void {
  const fromFiles = new Map<string, string>();
  for (const file of envFiles) {
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
      if (key) fromFiles.set(key, value);
    }
  }

  for (const [key, value] of fromFiles) {
    if (fromRealEnv.has(key)) continue; // 真实环境优先
    process.env[key] = value;
  }
  // 上一轮由文件注入、这一轮已不存在的 key → 撤销
  for (const key of previouslyFromFiles) {
    if (!fromFiles.has(key) && !fromRealEnv.has(key)) delete process.env[key];
  }
  previouslyFromFiles = new Set(fromFiles.keys());
}

/**
 * 加载 .env。每次调用都会检查文件指纹，**只有变化时才重新解析**，
 * 所以可以安全地在每次读配置时调用（stat 的成本远低于 readFile）。
 */
export function loadDotEnv(force = false): void {
  lastObservedSignature = envSignature();
  if (!force && lastObservedSignature === loadedSignature) return;
  applyEnvFiles();
  loadedSignature = envSignature();
}

loadDotEnv();

const str = (key: string, fallback = ''): string => {
  loadDotEnv(); // .env 若被改动，这里会自动重新读取
  return process.env[key]?.trim() || fallback;
};
const num = (key: string, fallback: number): number => {
  loadDotEnv();
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

  /**
   * 认证（审计 B2）。
   *
   * SESSION_SECRET 未配置时：开发环境自动生成（重启后旧 token 失效，可接受），
   * 生产环境**拒绝启动** —— 用可预测密钥签名等于没有鉴权。
   */
  get sessionSecret(): string {
    return str('SESSION_SECRET');
  },
  /**
   * 认证开关：
   *   required —— 未登录一律 401。**生产环境必须用它**（默认值）
   *   optional —— 仅当库里存在「遗留占位账号」（email 以 @legacy.local 结尾，
   *               由旧版单用户数据迁移而来）时，才允许匿名请求落到它，
   *               用于平滑迁移老部署。任何通过正常注册创建的账号都不允许匿名访问。
   *
   * 注意：默认是 required。早期版本默认 optional 且「只有一个账号就放行」，
   * 会导致「刚注册第一个用户的真实部署」被匿名访问——这是个安全漏洞，已修掉。
   */
  get authMode(): 'required' | 'optional' {
    const raw = str('AUTH_MODE', '').toLowerCase();
    return raw === 'optional' ? 'optional' : 'required';
  },

  /**
   * 持久化（审计 B1）。
   *
   * driver=auto 时的判定顺序：
   *   DATABASE_URL 是 postgres:// → Postgres
   *   DATABASE_URL 是 file:      → SQLite（用其路径）
   *   都没有                      → SQLite（默认，Node 22.5+ 内置）
   *   Node < 22.5                 → 回落 JSON 文件
   */
  persistence: {
    get driver(): 'auto' | 'file' | 'sqlite' | 'postgres' {
      const raw = str('STORAGE_DRIVER', 'auto').toLowerCase();
      return (['auto', 'file', 'sqlite', 'postgres'].includes(raw) ? raw : 'auto') as
        | 'auto'
        | 'file'
        | 'sqlite'
        | 'postgres';
    },
    get databaseUrl(): string {
      return str('DATABASE_URL');
    },
    /**
     * SQLite 文件路径，优先级：
     *   1. DATABASE_URL=file:xxx
     *   2. SQLITE_FILE
     *   3. <DATA_DIR>/ruatrip.db
     *
     * 第 3 条很关键：早期实现写死了 `REPO_ROOT/.data/ruatrip.db`，
     * 导致设置 DATA_DIR 被忽略 —— 测试会污染真实数据库，
     * 生产上把数据放到挂载盘也不生效。
     */
    get sqliteFile(): string {
      const url = this.databaseUrl;
      if (url.startsWith('file:')) {
        const p = url.slice(5);
        return p.startsWith('/') ? p : resolve(REPO_ROOT, p);
      }
      const explicit = str('SQLITE_FILE');
      if (explicit) return resolve(REPO_ROOT, explicit);
      return resolve(config.dataDir, 'ruatrip.db');
    },
    get pgSsl(): boolean {
      const raw = str('PG_SSL');
      if (raw === '') return true;
      return raw === 'true' || raw === '1';
    },
  },

  /**
   * 对象存储（审计 B3）。
   *
   * 四个 S3 必填项齐全时自动使用 S3 兼容驱动，否则回落到本地磁盘。
   * Cloudflare R2 / 腾讯云 COS / 阿里云 OSS / MinIO / AWS S3 都是 S3 协议。
   */
  storage: {
    get endpoint() {
      return str('STORAGE_ENDPOINT');
    },
    get bucket() {
      return str('STORAGE_BUCKET');
    },
    get accessKeyId() {
      return str('STORAGE_ACCESS_KEY');
    },
    get secretAccessKey() {
      return str('STORAGE_SECRET_KEY');
    },
    get region() {
      return str('STORAGE_REGION', 'auto');
    },
    /** CDN 或公开访问前缀，例如 https://cdn.example.com */
    get publicBaseUrl() {
      return str('CDN_BASE_URL');
    },
    get forcePathStyle() {
      const raw = str('STORAGE_FORCE_PATH_STYLE');
      if (raw === '') return undefined;
      return raw === 'true' || raw === '1';
    },
    /** 本地驱动对外暴露的 URL 前缀（反向代理要把这个路径转到服务端） */
    get publicPrefix() {
      return str('STORAGE_PUBLIC_PREFIX', '/uploads');
    },
    get maxImageBytes() {
      return num('MAX_IMAGE_BYTES', 4 * 1024 * 1024);
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

/** 对象存储是否配了 S3（否则用本地磁盘） */
export const hasObjectStorage = (): boolean =>
  Boolean(
    config.storage.endpoint &&
      config.storage.bucket &&
      config.storage.accessKeyId &&
      config.storage.secretAccessKey,
  );
