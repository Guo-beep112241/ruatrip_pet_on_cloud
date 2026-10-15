/**
 * 错误码 → HTTP 状态码映射（审计 O3 的一部分）。
 *
 * 背景：services 层抛业务错误时只写错误码（例如 `new Error('NOT_ENOUGH_AFFECTION')`），
 * 没带 status 的会被错误处理当成 500。这有两个害处：
 *   1. 用户看到「服务器错误」，而实际是「好感度不够」这种可理解的业务提示
 *   2. 500 会进错误日志与监控告警，把业务规则误报成系统故障
 *
 * 所以在这里集中声明「每个错误码对应什么状态」，而不是让每处抛错都记得写 status。
 * 新增错误码时在这里补一行即可（未声明的会回落 500 并打日志，便于发现遗漏）。
 */

/** 业务错误：请求本身有问题，用户能自己修正 */
const BAD_REQUEST = new Set([
  'NOT_ENOUGH_AFFECTION',   // 好感度不够（只能靠相处获得，见说明书 11 价值观红线）
  'ITEM_NOT_FOUND',         // 兑换物不存在
  'OUTFIT_LOCKED',          // 服饰未解锁
  'SCENE_LOCKED',           // 场景未解锁
  'WEAK_PASSWORD',          // 密码强度不足
  'INVALID_EMAIL',          // 邮箱格式不对
  'INVALID_JSON',           // 请求体不是合法 JSON
  'INVALID_MULTIPART',      // multipart 格式错
  'INVALID_STORAGE_KEY',    // 存储键非法
  'NO_FILE',                // 没收到文件
  'PAYLOAD_TOO_LARGE',      // 请求体太大
  'PET_ID_REQUIRED',        // 缺少 petId
  'CONFIRM_REQUIRED',       // 缺少确认串
  'UNKNOWN_PLAN',           // 订阅档位不存在
  'INVALID_IMAGE_REF',      // 图片引用不受信任
  'VALIDATION_FAILED',      // 请求体校验失败（见 http/validate.ts）
  'INVALID_BODY',
]);

/** 需要登录 */
const UNAUTHORIZED = new Set([
  'AUTH_REQUIRED',
  'INVALID_SESSION',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'ACCOUNT_NOT_FOUND',
  'INVALID_CREDENTIALS',
]);

/** 有身份但没权限 */
const FORBIDDEN = new Set([
  'FORBIDDEN',
  'PET_SLOT_LIMIT',          // 宠物位已满（需要订阅）
  'TIER_NOT_ALLOWED',        // 档位不含该内容
  'MINOR_SINGLE_PURCHASE_LIMIT', // 未成年人单笔上限
  'SPEND_LIMIT_EXCEEDED',    // 消费限额
]);

/** 资源不存在（一律 404，不泄漏「这个 id 是否存在」） */
const NOT_FOUND = new Set([
  'PET_NOT_FOUND',
  'JOB_NOT_FOUND',
  'CAPSULE_NOT_FOUND',
  'CONVERSATION_NOT_FOUND',
  'CHECKIN_NOT_FOUND',
  'DESTINATION_NOT_FOUND',  // 目的地不存在（同样是资源类）
]);

/** 冲突：状态不满足前置条件 */
const CONFLICT = new Set([
  'EMAIL_TAKEN',
  'TIER_DOWNGRADE_BLOCKED',  // 已有宠物数超过目标档位上限
]);

/** 限流 */
const TOO_MANY = new Set([
  'RATE_LIMITED',
  'DAILY_QUOTA_EXCEEDED',
  'LIMIT_REACHED',           // 单日互动次数用完
]);

/** 上游依赖不可用（不是用户的错，也不是代码 bug） */
const BAD_GATEWAY = new Set([
  'LLM_AUTH_FAILED',
  'LLM_NO_BALANCE',
  'LLM_MODEL_NOT_FOUND',
  'SQLITE_UNAVAILABLE',
  'PG_NOT_INSTALLED',
  'PERSISTENCE_CONFIG',
  'SESSION_SECRET_MISSING',
  'SESSION_SECRET_TOO_SHORT',
]);

/** 全部已知错误码（未在此列出的会被当作 500 并打日志） */
export const KNOWN_ERROR_CODES = new Set<string>([
  ...BAD_REQUEST,
  ...UNAUTHORIZED,
  ...FORBIDDEN,
  ...NOT_FOUND,
  ...CONFLICT,
  ...TOO_MANY,
  ...BAD_GATEWAY,
]);

/**
 * 取错误码对应的 HTTP 状态码。
 * 已显式声明 status 的优先（路由层知道更精确的语义）。
 */
export function statusForErrorCode(code: string, explicitStatus?: number): number {
  if (explicitStatus) return explicitStatus;
  if (BAD_REQUEST.has(code)) return 400;
  if (UNAUTHORIZED.has(code)) return 401;
  if (FORBIDDEN.has(code)) return 403;
  if (NOT_FOUND.has(code)) return 404;
  if (CONFLICT.has(code)) return 409;
  if (TOO_MANY.has(code)) return 429;
  if (BAD_GATEWAY.has(code)) return 502;
  return 500;
}
