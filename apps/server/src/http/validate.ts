/**
 * 轻量请求体校验（审计 M1）。
 *
 * 原状：路由里全是 `(ctx.body ?? {}) as { ... }` —— 类型断言不是校验，
 * 客户端传 `{ petId: 123 }` 或 `{ action: 'drop-table' }` 都能一路流到业务层，
 * 产生难排查的 500（例如 `typeof petId !== 'string'` 时 `.includes` 会抛）。
 *
 * 设计：零依赖的声明式校验，够本项目用，且错误信息直接可展示给用户。
 * 不引 zod/valibot 是为了保持「npm install 3 分钟能跑起来」这个特性。
 */

export type FieldSpec =
  | { type: 'string'; required?: boolean; min?: number; max?: number; pattern?: RegExp; label?: string; trim?: boolean }
  | { type: 'email'; required?: boolean; label?: string }
  | { type: 'number'; required?: boolean; min?: number; max?: number; integer?: boolean; label?: string }
  | { type: 'boolean'; required?: boolean; label?: string }
  | { type: 'enum'; values: readonly string[]; required?: boolean; label?: string }
  /** 字符串数组（如问卷答案的多选） */
  | { type: 'stringArray'; required?: boolean; maxItems?: number; maxLength?: number; label?: string }
  /**
   * 「维度 → 选项数组」的映射（问卷答案的形状）。
   * 形如 { species: ['ragdoll'], palette: ['oat','chestnut'] }。
   * 维度白名单由 services/inference.ts 保证，这里只校验形状与规模。
   */
  | {
      type: 'answerMap';
      required?: boolean;
      /** 最多允许几个维度 */
      maxKeys?: number;
      /** 每个维度最多几个选项 */
      maxItems?: number;
      maxLength?: number;
      label?: string;
    }
  /** 允许为 null 的字符串（前端会显式传 null 表示「清除」） */
  | { type: 'nullableString'; max?: number; label?: string }
  /** 图片引用：字符串或 null，长度受限（真正的白名单校验在 storage 层） */
  | { type: 'imageRef'; required?: boolean; label?: string };

export type Schema = Record<string, FieldSpec>;

export interface ValidationIssue {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  readonly status = 400;
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super('VALIDATION_FAILED');
    this.name = 'ValidationError';
    this.issues = issues;
    this.message = issues.map((i) => i.message).join('；');
  }
}

type Inferred<F extends FieldSpec> = F extends { type: 'string' }
  ? string
  : F extends { type: 'email' }
    ? string
    : F extends { type: 'number' }
      ? number
      : F extends { type: 'boolean' }
        ? boolean
        : F extends { type: 'enum'; values: readonly (infer V)[] }
          ? V
          : F extends { type: 'stringArray' }
            ? string[]
            : F extends { type: 'nullableString' }
              ? string | null
              : F extends { type: 'imageRef' }
                ? string | null
                : unknown;

export type Infer<S extends Schema> = { [K in keyof S]: Inferred<S[K]> };

function labelOf(spec: FieldSpec, field: string): string {
  return 'label' in spec && spec.label ? spec.label : field;
}

/**
 * 校验并归一化请求体。
 *
 * 行为约定：
 *   - 未传且 required → 报错
 *   - 未传且非 required → 从结果里**省略**（而不是塞 undefined），
 *     这样下游的 `!== undefined` 判断语义才准确
 *   - 传了 null 且字段不是 nullable/imageRef → 报错（避免 null 混进业务层）
 *   - 多余字段被**丢弃**，防止客户端顺手塞 tier / ownerId 之类做权限提升
 */
export function validate<S extends Schema>(input: unknown, schema: S): Infer<S> {
  const issues: ValidationIssue[] = [];
  // 非对象一律拒绝：把字符串/数组当成「空对象」放行会让必填校验被绕过
  if (input !== null && input !== undefined && (typeof input !== 'object' || Array.isArray(input))) {
    throw new ValidationError([
      { field: '_body', message: `请求体必须是一个 JSON 对象（收到 ${Array.isArray(input) ? 'array' : typeof input}）` },
    ]);
  }
  const source = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [field, spec] of Object.entries(schema) as [string, FieldSpec][]) {
    const label = labelOf(spec, field);
    const raw = source[field];

    if (raw === undefined) {
      if ('required' in spec && spec.required) {
        issues.push({ field, message: `缺少 ${label}` });
      }
      continue; // 非必填且未传 → 省略
    }

    switch (spec.type) {
      case 'string':
      case 'email': {
        if (typeof raw !== 'string') {
          issues.push({ field, message: `${label} 必须是字符串` });
          break;
        }
        const value = spec.type === 'string' && spec.trim === false ? raw : raw.trim();
        const min = spec.type === 'string' ? (spec.min ?? 0) : 0;
        const max = spec.type === 'string' ? (spec.max ?? 2000) : 254;
        if (value.length < min) {
          issues.push({ field, message: `${label} 至少 ${min} 个字符` });
          break;
        }
        if (value.length > max) {
          issues.push({ field, message: `${label} 不能超过 ${max} 个字符` });
          break;
        }
        if (spec.type === 'string' && spec.pattern && !spec.pattern.test(value)) {
          issues.push({ field, message: `${label} 格式不正确` });
          break;
        }
        out[field] = value;
        break;
      }

      case 'nullableString': {
        if (raw === null) {
          out[field] = null;
          break;
        }
        if (typeof raw !== 'string') {
          issues.push({ field, message: `${label} 必须是字符串或 null` });
          break;
        }
        const value = raw.trim();
        if (value.length > (spec.max ?? 2000)) {
          issues.push({ field, message: `${label} 不能超过 ${spec.max ?? 2000} 个字符` });
          break;
        }
        out[field] = value;
        break;
      }

      case 'imageRef': {
        if (raw === null) {
          out[field] = null;
          break;
        }
        if (typeof raw !== 'string') {
          issues.push({ field, message: `${label} 必须是字符串或 null` });
          break;
        }
        // 上限放宽到 8MB 字符：小体积内嵌图允许，
        // 真正的白名单与体积判断在 storage/validateImageRef 里做
        if (raw.length > 8 * 1024 * 1024) {
          issues.push({ field, message: `${label} 太大了，请先调用 POST /api/upload 上传` });
          break;
        }
        out[field] = raw;
        break;
      }

      case 'number': {
        // 允许字符串数字（表单/query 常见），但必须是有限数
        const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ field, message: `${label} 必须是数字` });
          break;
        }
        if (spec.integer && !Number.isInteger(value)) {
          issues.push({ field, message: `${label} 必须是整数` });
          break;
        }
        if (spec.min !== undefined && value < spec.min) {
          issues.push({ field, message: `${label} 不能小于 ${spec.min}` });
          break;
        }
        if (spec.max !== undefined && value > spec.max) {
          issues.push({ field, message: `${label} 不能大于 ${spec.max}` });
          break;
        }
        out[field] = value;
        break;
      }

      case 'boolean': {
        if (typeof raw === 'boolean') {
          out[field] = raw;
          break;
        }
        // 兼容 "true" / "1" / 1 这类表单值
        if (raw === 'true' || raw === '1' || raw === 1) out[field] = true;
        else if (raw === 'false' || raw === '0' || raw === 0) out[field] = false;
        else issues.push({ field, message: `${label} 必须是布尔值` });
        break;
      }

      case 'enum': {
        if (typeof raw !== 'string' || !spec.values.includes(raw)) {
          issues.push({
            field,
            message: `${label} 只能是 ${spec.values.join(' / ')} 之一`,
          });
          break;
        }
        out[field] = raw;
        break;
      }

      case 'answerMap': {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          issues.push({ field, message: `${label} 必须是「维度 → 选项」的对象` });
          break;
        }
        const maxKeys = spec.maxKeys ?? 12;
        const maxItems = spec.maxItems ?? 8;
        const maxLength = spec.maxLength ?? 64;
        const entries = Object.entries(raw as Record<string, unknown>);
        if (entries.length > maxKeys) {
          issues.push({ field, message: `${label} 的维度过多（最多 ${maxKeys} 个）` });
          break;
        }
        const cleaned: Record<string, string[]> = {};
        let bad = false;
        for (const [dim, value] of entries) {
          if (dim.length === 0 || dim.length > 32) {
            issues.push({ field, message: `${label} 里有非法的维度名` });
            bad = true;
            break;
          }
          if (!Array.isArray(value)) {
            issues.push({ field, message: `${label} 的「${dim}」必须是数组` });
            bad = true;
            break;
          }
          if (value.length > maxItems) {
            issues.push({ field, message: `${label} 的「${dim}」最多 ${maxItems} 项` });
            bad = true;
            break;
          }
          const items: string[] = [];
          for (const item of value) {
            if (typeof item !== 'string') {
              issues.push({ field, message: `${label} 的「${dim}」里只能填字符串选项 id` });
              bad = true;
              break;
            }
            if (item.length > maxLength) {
              issues.push({ field, message: `${label} 的选项 id 过长` });
              bad = true;
              break;
            }
            items.push(item.trim());
          }
          if (bad) break;
          cleaned[dim] = items.filter(Boolean);
        }
        if (!bad) out[field] = cleaned;
        break;
      }

      case 'stringArray': {
        if (!Array.isArray(raw)) {
          issues.push({ field, message: `${label} 必须是数组` });
          break;
        }
        const maxItems = spec.maxItems ?? 20;
        if (raw.length > maxItems) {
          issues.push({ field, message: `${label} 最多 ${maxItems} 项` });
          break;
        }
        const maxLength = spec.maxLength ?? 64;
        const cleaned: string[] = [];
        let bad = false;
        for (const item of raw) {
          if (typeof item !== 'string') {
            issues.push({ field, message: `${label} 里只能是字符串` });
            bad = true;
            break;
          }
          if (item.length > maxLength) {
            issues.push({ field, message: `${label} 单项不能超过 ${maxLength} 个字符` });
            bad = true;
            break;
          }
          cleaned.push(item.trim());
        }
        if (!bad) out[field] = cleaned.filter(Boolean);
        break;
      }

      default: {
        // 类型穷尽保护：新增 FieldSpec 类型时这里会编译报错
        const never: never = spec;
        void never;
        issues.push({ field, message: `${label} 校验规则未实现` });
      }
    }
  }

  if (issues.length) throw new ValidationError(issues);
  return out as Infer<S>;
}

/** 校验 query 参数（值都是字符串或缺失） */
export function validateQuery<S extends Schema>(url: URL, schema: S): Infer<S> {
  const source: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    const value = url.searchParams.get(key);
    if (value !== null) source[key] = value;
  }
  return validate(source, schema);
}
