/**
 * multipart/form-data 解析（零依赖）。
 *
 * 为什么需要：手机浏览器用 <input type="file" capture> 拍照上传时，
 * 走的是 multipart 表单而不是 base64 JSON。原来只支持 JSON body，
 * 相当于把「拍照打卡」这条核心路径堵住了。
 *
 * 只实现本项目需要的能力：解析字段与文件、限制体积、拒绝异常输入。
 * 不追求覆盖 RFC 的全部边界情况（嵌套 multipart、Content-Transfer-Encoding 等）。
 */

export interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartResult {
  fields: Record<string, string>;
  files: MultipartFile[];
}

export class MultipartError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'MultipartError';
  }
}

/** 从 Content-Type 头里取 boundary */
export function parseBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  return value ? value.trim() : null;
}

/**
 * 解析 multipart 请求体。
 *
 * 实现思路：按 boundary 切分原始 Buffer（**在字节层面切，不转字符串**，
 * 否则二进制图片会被破坏），再对每个部分解析头部与内容。
 */
export function parseMultipart(body: Buffer, boundary: string, options: { maxFileBytes: number; maxFiles?: number }): MultipartResult {
  const maxFiles = options.maxFiles ?? 6;
  const delimiter = Buffer.from(`--${boundary}`);
  const result: MultipartResult = { fields: {}, files: [] };

  let index = body.indexOf(delimiter);
  if (index < 0) throw new MultipartError('请求体不是合法的 multipart 数据（找不到 boundary）');

  while (index >= 0) {
    const partStart = index + delimiter.length;
    // 结束标记是 `--boundary--`
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;

    const nextDelimiter = body.indexOf(delimiter, partStart);
    if (nextDelimiter < 0) throw new MultipartError('multipart 数据不完整（缺少结束 boundary）');

    // 每个部分以 CRLF 开头、以 CRLF 结尾
    let part = body.subarray(partStart, nextDelimiter);
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    if (part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new MultipartError('multipart 分段缺少头部与内容的分隔');

    const headerText = part.subarray(0, headerEnd).toString('utf8');
    const content = part.subarray(headerEnd + 4);

    const disposition = /content-disposition:\s*([^\r\n]+)/i.exec(headerText)?.[1] ?? '';
    const fieldName = /name="([^"]*)"/i.exec(disposition)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? '';
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? 'application/octet-stream';

    if (filename) {
      if (result.files.length >= maxFiles) {
        throw new MultipartError(`一次最多上传 ${maxFiles} 个文件`);
      }
      if (content.length > options.maxFileBytes) {
        throw new MultipartError(
          `文件太大（${(content.length / 1024 / 1024).toFixed(1)}MB），请压缩到 ${(options.maxFileBytes / 1024 / 1024).toFixed(0)}MB 以内`,
        );
      }
      result.files.push({
        fieldName,
        // 文件名的路径部分要去掉，防止客户端塞路径
        filename: filename.split(/[/\\]/).pop() ?? filename,
        contentType,
        data: Buffer.from(content),
      });
    } else if (fieldName) {
      const text = content.toString('utf8');
      if (text.length > 8 * 1024) throw new MultipartError(`字段 ${fieldName} 内容过长`);
      result.fields[fieldName] = text;
    }

    index = nextDelimiter;
  }

  return result;
}

/** 小数值字段解析（带范围校验） */
export function numberField(
  fields: Record<string, string>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = fields[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
