/**
 * 启动配置校验（审计 M4）。
 *
 * 原状：配置错误只在「用户第一次触发某个功能」时才暴露 ——
 * 例如 TRIPO_API_KEY 少一位，用户等了 20 秒孵化才发现失败。
 * 部署者应该在启动日志里立刻看到问题。
 *
 * 原则：
 *   - **致命问题**拒绝启动（用可预测密钥签名、驱动不可用）
 *   - **可疑配置**打警告但继续跑（key 格式不像、CORS 没配生产域名）
 *   - 绝不因为「某个可选能力没配」就拒绝启动 —— 那会让 Mock 模式失去意义
 */

export type ConfigIssueLevel = 'fatal' | 'warn' | 'info';

export interface ConfigIssue {
  level: ConfigIssueLevel;
  /** 出问题的环境变量名 */
  key: string;
  message: string;
  /** 怎么修 */
  fix?: string;
}

export interface ConfigSnapshot {
  env: string;
  dataDir: string;
  driverKind: string;
  persistenceDescription: string;
  sqliteFile: string;
  databaseUrl: string;
  sessionSecret: string;
  authMode: string;
  corsOrigins: string[];
  storageDriver: string;
  storageEndpoint: string;
  cdnBaseUrl: string;
  maxImageBytes: number;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  anthropicApiKey: string;
  tripoApiKey: string;
  meshyApiKey: string;
  anythingWorldApiKey: string;
  minimaxApiKey: string;
  minimaxGroupId: string;
  elevenLabsApiKey: string;
  asrApiKey: string;
  asrBaseUrl: string;
  imageComposerApiKey: string;
  imageComposerBaseUrl: string;
  paymentProvider: string;
  paymentApiKey: string;
  pushEndpoint: string;
  pushPublicKey: string;
  pushPrivateKey: string;
  analyticsEndpoint: string;
  analyticsWriteKey: string;
  rateLimitDisabled: boolean;
}

/** 密钥格式的形状检查（不做真实有效性验证，那要花钱） */
const KEY_PATTERNS: { key: string; label: string; re: RegExp; hint: string }[] = [
  { key: 'anthropicApiKey', label: 'ANTHROPIC_API_KEY', re: /^sk-ant-/, hint: 'Anthropic 的 key 以 sk-ant- 开头' },
  { key: 'tripoApiKey', label: 'TRIPO_API_KEY', re: /^.{16,}$/, hint: 'Tripo 的 key 通常超过 16 位' },
  { key: 'meshyApiKey', label: 'MESHY_API_KEY', re: /^msy_/, hint: 'Meshy 的 key 以 msy_ 开头' },
  { key: 'elevenLabsApiKey', label: 'ELEVENLABS_API_KEY', re: /^sk_/, hint: 'ElevenLabs 的 key 以 sk_ 开头' },
];

/** 明显的占位符，填了等于没填 */
const PLACEHOLDER_RE = /^(your[-_]?|xxx|changeme|todo|placeholder|sk-xxx|test)$/i;

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value) || /^(.)\1{7,}$/.test(value);
}

/**
 * 校验配置，返回所有问题（不抛异常，由调用方决定是否退出）。
 *
 * 之所以返回列表而不是直接抛：部署平台（Render/Fly）会把 stderr 里的
 * 每一行当作日志展示，一次性列全比逐个报错更省事。
 */
export function validateConfig(config: ConfigSnapshot): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const isProd = config.env === 'production';

  /* ---------- 致命：会话密钥 ---------- */

  if (!config.sessionSecret) {
    issues.push({
      level: isProd ? 'fatal' : 'warn',
      key: 'SESSION_SECRET',
      message: isProd
        ? '生产环境未配置 SESSION_SECRET，拒绝启动'
        : '未配置 SESSION_SECRET（开发环境会用临时密钥，重启后所有登录失效）',
      fix: 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    });
  } else if (config.sessionSecret.length < 32) {
    issues.push({
      level: 'fatal',
      key: 'SESSION_SECRET',
      message: `SESSION_SECRET 只有 ${config.sessionSecret.length} 个字符，至少需要 32 个`,
      fix: '重新生成一个 32 位以上的随机串',
    });
  } else if (looksLikePlaceholder(config.sessionSecret)) {
    issues.push({
      level: 'fatal',
      key: 'SESSION_SECRET',
      message: 'SESSION_SECRET 看起来是占位符，等于没有鉴权',
      fix: '换成真正的随机串',
    });
  }

  /* ---------- 致命：持久化 ---------- */

  if (isProd && config.driverKind === 'file') {
    issues.push({
      level: 'fatal',
      key: 'STORAGE_DRIVER',
      message:
        '生产环境使用 JSON 文件驱动：容器重建会丢失全部用户数据（宠物、好感度、记忆）',
      fix: '配置 DATABASE_URL=postgres://... 并 npm i pg，或改用 STORAGE_DRIVER=sqlite 并挂载数据卷',
    });
  }

  if (config.driverKind === 'sqlite' && isProd && config.dataDir.startsWith('/tmp')) {
    issues.push({
      level: 'warn',
      key: 'DATA_DIR',
      message: `SQLite 数据目录在 ${config.dataDir}（临时目录），容器重启会丢数据`,
      fix: '把 DATA_DIR 指到持久卷（如 /var/data），或改用 Postgres',
    });
  }

  /* ---------- 致命：认证模式 ---------- */

  if (isProd && config.authMode === 'optional') {
    issues.push({
      level: 'fatal',
      key: 'AUTH_MODE',
      message: '生产环境不允许 AUTH_MODE=optional（会允许匿名访问遗留账号）',
      fix: '设置为 required',
    });
  }

  /* ---------- 警告：CORS ---------- */

  if (isProd) {
    if (config.corsOrigins.includes('*')) {
      issues.push({
        level: 'fatal',
        key: 'CORS_ORIGIN',
        message: '生产环境不允许 CORS_ORIGIN=*（任意站点都能带凭证调用接口）',
        fix: '填写真实前端域名，多个用逗号分隔',
      });
    } else if (config.corsOrigins.some((o) => o.includes('localhost') || o.includes('127.0.0.1'))) {
      issues.push({
        level: 'warn',
        key: 'CORS_ORIGIN',
        message: 'CORS_ORIGIN 里还留着 localhost，生产环境应填真实域名',
        fix: '例如 https://ruatrip.example.com',
      });
    }
  }

  /* ---------- 警告：限流被关掉 ---------- */

  if (isProd && config.rateLimitDisabled) {
    issues.push({
      level: 'warn',
      key: 'RATE_LIMIT_DISABLED',
      message: '生产环境关闭了限流：按次计费的接口（对话、3D 生成）会失去保护',
      fix: '除非前面已有网关限流，否则清空这个变量',
    });
  }

  /* ---------- 警告：密钥格式 ---------- */

  for (const { key, label, re, hint } of KEY_PATTERNS) {
    const value = (config as unknown as Record<string, string>)[key];
    if (!value) continue;
    if (looksLikePlaceholder(value)) {
      issues.push({ level: 'warn', key: label, message: '看起来是占位符，实际调用会失败' });
    } else if (!re.test(value)) {
      issues.push({
        level: 'warn',
        key: label,
        message: '格式看起来不像该服务的密钥',
        fix: hint,
      });
    }
  }

  /* ---------- 警告：配对变量 ---------- */

  const pairs: { a: keyof ConfigSnapshot; b: keyof ConfigSnapshot; label: string }[] = [
    { a: 'minimaxApiKey', b: 'minimaxGroupId', label: 'MiniMax' },
    { a: 'asrApiKey', b: 'asrBaseUrl', label: '服务端 ASR' },
    { a: 'imageComposerApiKey', b: 'imageComposerBaseUrl', label: '图像合成' },
    { a: 'pushEndpoint', b: 'pushPublicKey', label: '推送（endpoint 与公钥）' },
    { a: 'analyticsEndpoint', b: 'analyticsWriteKey', label: '埋点上报' },
    { a: 'paymentProvider', b: 'paymentApiKey', label: '支付' },
  ];
  for (const { a, b, label } of pairs) {
    const va = String(config[a] ?? '');
    const vb = String(config[b] ?? '');
    if (va && !vb) {
      issues.push({ level: 'warn', key: String(b), message: `${label} 只配了一半（缺少 ${String(b)}），该能力不会生效` });
    }
  }
  if (config.pushPublicKey && !config.pushPrivateKey) {
    issues.push({ level: 'warn', key: 'PUSH_VAPID_PRIVATE_KEY', message: '推送只配了公钥，缺少私钥' });
  }

  /* ---------- 警告：大模型通道 ---------- */

  if (config.llmApiKey && !config.llmBaseUrl) {
    issues.push({
      level: 'warn',
      key: 'LLM_BASE_URL',
      message: '配了 LLM_API_KEY 但没有 LLM_BASE_URL，通用对话通道不会启用',
      fix: '例如 https://api.deepseek.com',
    });
  }
  if (config.llmBaseUrl && !config.llmApiKey) {
    issues.push({ level: 'warn', key: 'LLM_API_KEY', message: '配了 LLM_BASE_URL 但没有 LLM_API_KEY' });
  }
  if (config.llmBaseUrl && !config.llmModel) {
    issues.push({
      level: 'warn',
      key: 'LLM_MODEL',
      message: '没有指定 LLM_MODEL，会回落到默认模型名，可能不被你的供应商支持',
      fix: '例如 deepseek-flash / glm-4-flash / qwen-plus',
    });
  }

  /* ---------- 警告：对象存储 ---------- */

  const storageFields = [
    config.storageEndpoint,
    (config as unknown as Record<string, string>).storageBucket ?? '',
    (config as unknown as Record<string, string>).storageAccessKey ?? '',
    (config as unknown as Record<string, string>).storageSecretKey ?? '',
  ];
  const storageFilled = storageFields.filter(Boolean).length;
  if (storageFilled > 0 && storageFilled < 4) {
    issues.push({
      level: 'warn',
      key: 'STORAGE_ENDPOINT',
      message: `对象存储只配了 ${storageFilled}/4 个必填项，会回落到本地磁盘`,
      fix: '需要 STORAGE_ENDPOINT / STORAGE_BUCKET / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY',
    });
  }
  if (isProd && storageFilled === 0) {
    issues.push({
      level: 'warn',
      key: 'STORAGE_ENDPOINT',
      message: '未配置对象存储：上传的图片会落在容器本地磁盘，重新部署即丢失',
      fix: '接入 S3 兼容存储（R2 / COS / OSS），见 docs/API-INTEGRATION.md 第 8 节',
    });
  }
  if (storageFilled === 4 && !config.cdnBaseUrl) {
    issues.push({
      level: 'info',
      key: 'CDN_BASE_URL',
      message: '未配置 CDN_BASE_URL，图片会从对象存储的原始地址加载（较慢）',
    });
  }

  if (config.maxImageBytes > 8 * 1024 * 1024) {
    issues.push({
      level: 'warn',
      key: 'MAX_IMAGE_BYTES',
      message: `单张图片上限 ${(config.maxImageBytes / 1024 / 1024).toFixed(0)}MB 偏大，会显著增加存储与带宽成本`,
      fix: '建议 4MB（客户端已自动压缩到 1600px 长边）',
    });
  }

  return issues;
}

/** 是否有致命问题（调用方据此决定是否拒绝启动） */
export function hasFatal(issues: ConfigIssue[]): boolean {
  return issues.some((i) => i.level === 'fatal');
}

/** 渲染成启动日志用的多行文本 */
export function formatIssues(issues: ConfigIssue[]): string[] {
  const icon: Record<ConfigIssueLevel, string> = { fatal: '✗', warn: '!', info: '·' };
  return issues.map((issue) => {
    const fix = issue.fix ? `\n      → ${issue.fix}` : '';
    return `  ${icon[issue.level]} [${issue.key}] ${issue.message}${fix}`;
  });
}
