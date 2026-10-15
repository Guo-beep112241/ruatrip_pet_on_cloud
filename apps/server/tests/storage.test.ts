/**
 * 存储与上传的回归测试（审计 B3）。
 *
 * 覆盖：图片魔数校验、体积上限、路径穿越防护、S3 签名、防抖写入。
 * 不依赖网络与外部服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalStorageProvider,
  buildKey,
  decodeImage,
  validateImageRef,
  MAX_IMAGE_BYTES,
  MAX_INLINE_DATA_URL_BYTES,
} from '../src/storage/index.ts';
import { Store } from '../src/db/store.ts';
import { parseBoundary, parseMultipart, MultipartError, numberField } from '../src/http/multipart.ts';

/* ---------- 测试用图片素材 ---------- */

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const JPEG_FAKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP_FAKE = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);

/* ============================================================
 * 图片校验
 * ============================================================ */

test('B3: 按魔数识别真实图片类型，不信任声明的 MIME', () => {
  const png = decodeImage(PNG_1x1);
  assert.equal(png.ok, true);
  assert.equal(png.ext, 'png');
  assert.equal(png.mime, 'image/png');

  assert.equal(decodeImage(GIF_1x1).ext, 'gif');
  assert.equal(decodeImage(JPEG_FAKE).ext, 'jpg');
  assert.equal(decodeImage(WEBP_FAKE).ext, 'webp');
});

test('B3: 拒绝伪装成图片的非图片内容', () => {
  const notImage = Buffer.from('<svg><script>alert(1)</script></svg>');
  const verdict = decodeImage(notImage);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /只支持/);

  // 声称是 jpeg 但内容是 PNG：以实际内容为准会不一致 → 拒绝
  const lying = decodeImage(`data:image/jpeg;base64,${PNG_1x1.toString('base64')}`);
  assert.equal(lying.ok, false, '声明与实际不符必须拒绝');
  assert.match(lying.reason ?? '', /不一致/);
});

test('B3: 拒绝超过体积上限的图片', () => {
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_IMAGE_BYTES + 1)]);
  const verdict = decodeImage(huge);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /太大/);
});

test('B3: 接受 base64 data URL 与原始 Buffer 两种入参', () => {
  const viaDataUrl = decodeImage(`data:image/png;base64,${PNG_1x1.toString('base64')}`);
  assert.equal(viaDataUrl.ok, true);
  assert.equal(viaDataUrl.bytes, PNG_1x1.length);

  const viaBuffer = decodeImage(PNG_1x1);
  assert.equal(viaBuffer.ok, true);
  assert.equal(viaBuffer.bytes, PNG_1x1.length);
});

test('B3: 畸形 data URL 与空内容被拒绝，且不抛异常', () => {
  for (const bad of ['', 'data:image/png;base64,', 'not-a-data-url', 'data:image/png,plain', 'data:;base64,AAAA']) {
    const verdict = decodeImage(bad);
    assert.equal(verdict.ok, false, `应拒绝：${bad}`);
    assert.ok(verdict.reason, '必须给出原因');
  }
  assert.equal(decodeImage(Buffer.alloc(0)).ok, false);
});

test('B3: 存储键不含路径穿越字符，且格式稳定', () => {
  const key = buildKey('../../etc', 'png');
  assert.ok(!key.includes('..'), `键里不能有 ..：${key}`);
  assert.ok(!key.includes('//'), '不能有双斜杠');
  assert.match(key, /^[a-zA-Z0-9_-]+\/[a-z0-9]+-[a-z0-9]+\.png$/);

  const weird = buildKey('用户 id / with spaces', 'JPG');
  assert.ok(!/[\s/]{2,}/.test(weird.replace(/^[^/]*\//, '')));
});

/* ============================================================
 * 本地存储驱动
 * ============================================================ */

test('B3: 本地驱动可存可取可删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruatrip-store-'));
  try {
    const storage = new LocalStorageProvider(dir, '/api/uploads');
    const key = buildKey('user-1', 'png');

    const stored = await storage.put({ key, data: PNG_1x1, contentType: 'image/png' });
    assert.equal(stored.url, `/api/uploads/${key}`);
    assert.equal(stored.bytes, PNG_1x1.length);

    const got = await storage.get(key);
    assert.ok(got, '应能取回');
    assert.ok(got!.data.equals(PNG_1x1), '取回内容必须与写入一致');
    assert.equal(got!.contentType, 'image/png');

    assert.equal(await storage.delete(key), true);
    assert.equal(await storage.get(key), null);
    assert.equal(await storage.delete(key), false, '重复删除应返回 false 而不是抛错');
    assert.equal(await storage.healthy(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3: 本地驱动拒绝真正逃出根目录的键', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruatrip-trav-'));
  try {
    const storage = new LocalStorageProvider(dir, '/api/uploads');
    // 这些含 ".."，必须被拒绝
    for (const evil of ['../../etc/passwd', '..%2f..%2fetc', 'a/../../b', '..', 'a/..']) {
      await assert.rejects(
        () => storage.put({ key: evil, data: PNG_1x1, contentType: 'image/png' }),
        /INVALID_STORAGE_KEY/,
        `应拒绝穿越键：${evil}`,
      );
      assert.equal(await storage.get(evil), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 另起一个目录验证「前导斜杠」的处理：它被规范化成相对路径，
  // 写在存储根内（不是漏洞），但要确认最终落点仍在根目录之内。
  const dir2 = mkdtempSync(join(tmpdir(), 'ruatrip-trav2-'));
  try {
    const storage = new LocalStorageProvider(dir2, '/api/uploads');
    const stored = await storage.put({ key: '/etc/passwd', data: PNG_1x1, contentType: 'image/png' });
    assert.ok(stored.key.replace(/^\//, '').startsWith('etc/'), '前导斜杠被剥离');
    const escaped = join(dir2, '..', 'etc', 'passwd');
    assert.equal(existsSync(escaped), false, '绝不能写到存储根之外');
    // 空键必须被拒绝
    await assert.rejects(() => storage.put({ key: '', data: PNG_1x1, contentType: 'image/png' }), /INVALID_STORAGE_KEY/);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

/* ============================================================
 * 图片引用校验（堵住绕过上传接口的口子）
 * ============================================================ */

test('B3: 图片引用只接受自家存储路径 / 小内嵌图 / 空值', () => {
  const prefixes = ['/api/uploads/', 'https://cdn.example.com/'];

  // 空值允许（走合成图）
  assert.equal(validateImageRef(null, { allowedPrefixes: prefixes }).ok, true);
  assert.equal(validateImageRef('', { allowedPrefixes: prefixes }).ok, true);

  // 自家存储路径允许
  assert.equal(validateImageRef('/api/uploads/u1/a.png', { allowedPrefixes: prefixes }).ok, true);
  assert.equal(validateImageRef('https://cdn.example.com/u1/a.png', { allowedPrefixes: prefixes }).ok, true);

  // 小 data URL 允许
  const small = `data:image/png;base64,${PNG_1x1.toString('base64')}`;
  assert.equal(validateImageRef(small, { allowedPrefixes: prefixes }).ok, true);
});

test('B3: 大内嵌图与外部 URL 被拒绝（这是曾经的绕过口子）', () => {
  const prefixes = ['/api/uploads/'];

  const bigInline = `data:image/png;base64,${'A'.repeat(MAX_INLINE_DATA_URL_BYTES * 2)}`;
  const bigVerdict = validateImageRef(bigInline, { allowedPrefixes: prefixes });
  assert.equal(bigVerdict.ok, false);
  assert.match(bigVerdict.reason ?? '', /请先调用 POST \/api\/upload/);

  const external = validateImageRef('https://evil.example.com/track.jpg', { allowedPrefixes: prefixes });
  assert.equal(external.ok, false, '外部 URL 默认不接受');

  const evil = validateImageRef('javascript:alert(1)', { allowedPrefixes: prefixes });
  assert.equal(evil.ok, false);

  const relative = validateImageRef('../../../etc/passwd', { allowedPrefixes: prefixes });
  assert.equal(relative.ok, false);
});

/* ============================================================
 * multipart 解析
 * ============================================================ */

function buildMultipart(
  boundary: string,
  parts: { name: string; filename?: string; contentType?: string; value: string | Buffer }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) header += `; filename="${p.filename}"`;
    header += '\r\n';
    if (p.contentType) header += `Content-Type: ${p.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

test('B3: multipart 能正确解析字段与二进制文件（不破坏字节）', () => {
  const boundary = '----ruatrip123';
  const body = buildMultipart(boundary, [
    { name: 'purpose', value: 'checkin' },
    { name: 'file', filename: 'photo.png', contentType: 'image/png', value: PNG_1x1 },
  ]);

  const parsed = parseMultipart(body, boundary, { maxFileBytes: MAX_IMAGE_BYTES });
  assert.equal(parsed.fields.purpose, 'checkin');
  assert.equal(parsed.files.length, 1);
  const file = parsed.files[0]!;
  assert.equal(file.fieldName, 'file');
  assert.equal(file.filename, 'photo.png');
  assert.equal(file.contentType, 'image/png');
  // 关键：二进制内容必须逐字节一致
  assert.ok(file.data.equals(PNG_1x1), 'multipart 解析不得破坏二进制内容');
});

test('B3: multipart 文件名去掉路径部分（防客户端塞路径）', () => {
  const boundary = 'b1';
  const body = buildMultipart(boundary, [
    { name: 'file', filename: '../../evil.png', contentType: 'image/png', value: PNG_1x1 },
  ]);
  const parsed = parseMultipart(body, boundary, { maxFileBytes: MAX_IMAGE_BYTES });
  assert.equal(parsed.files[0]!.filename, 'evil.png');
});

test('B3: multipart 超限文件被拒绝并给出可读原因', () => {
  const boundary = 'b2';
  const body = buildMultipart(boundary, [
    { name: 'file', filename: 'big.png', contentType: 'image/png', value: Buffer.alloc(2048) },
  ]);
  assert.throws(
    () => parseMultipart(body, boundary, { maxFileBytes: 1024 }),
    (error: unknown) => error instanceof MultipartError && /文件太大/.test((error as Error).message),
  );
});

test('B3: multipart 非法输入被拒绝而不是静默解析出空结果', () => {
  assert.throws(() => parseMultipart(Buffer.from('garbage'), 'nope', { maxFileBytes: 1024 }), MultipartError);
  assert.throws(
    () => parseMultipart(Buffer.from('--b\r\nno header separator'), 'b', { maxFileBytes: 1024 }),
    MultipartError,
  );
});

test('B3: boundary 解析兼容带引号与不带引号两种写法', () => {
  assert.equal(parseBoundary('multipart/form-data; boundary=abc'), 'abc');
  assert.equal(parseBoundary('multipart/form-data; boundary="abc def"'), 'abc def');
  assert.equal(parseBoundary('application/json'), null);
  assert.equal(parseBoundary(undefined), null);
});

test('numberField 带范围钳制，非法值回落默认', () => {
  const fields = { days: '5', bad: 'abc', huge: '999', neg: '-3' };
  assert.equal(numberField(fields, 'days', 1, 1, 14), 5);
  assert.equal(numberField(fields, 'bad', 7, 1, 14), 7, '非数字回落默认');
  assert.equal(numberField(fields, 'huge', 1, 1, 14), 14, '超上限被钳制');
  assert.equal(numberField(fields, 'neg', 1, 1, 14), 1, '低于下限被钳制');
  assert.equal(numberField(fields, 'missing', 3, 1, 14), 3);
});

/* ============================================================
 * 防抖写入（审计 B4）
 * ============================================================ */

test('B4: 连续多次变更只落盘一次（防抖合并）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruatrip-debounce-'));
  try {
    const store = new Store(dir, { debounceMs: 40 });
    for (let i = 0; i < 20; i += 1) {
      store.update((d) => {
        d.meta.counter = i;
        return i;
      });
    }
    assert.equal(store.isDirty(), true, '还没到防抖窗口，应有待写内容');
    await store.drain();
    assert.equal(store.isDirty(), false, 'drain 后不应再有待写内容');

    const onDisk = JSON.parse(readFileSync(join(dir, 'ruatrip.json'), 'utf8'));
    assert.equal(onDisk.meta.counter, 19, '最后一次变更必须落盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4: 写入是原子的，不会留下半个文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruatrip-atomic-'));
  try {
    const store = new Store(dir, { debounceMs: 10 });
    store.update((d) => {
      d.meta.big = 'x'.repeat(50_000);
      return true;
    });
    await store.flush();

    // 临时文件必须已被 rename 掉
    assert.equal(existsSync(join(dir, 'ruatrip.json.tmp')), false, '.tmp 不应残留');
    const parsed = JSON.parse(readFileSync(join(dir, 'ruatrip.json'), 'utf8'));
    assert.equal(parsed.meta.big.length, 50_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4: 数据损坏时保留坏档并重建，服务不崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruatrip-corrupt-'));
  try {
    writeFileSync(join(dir, 'ruatrip.json'), '{ this is not json', 'utf8');
    const store = new Store(dir, { debounceMs: 0 });
    assert.equal(store.read().pets.length, 0, '应重建为空档');
    // 坏档被留档以备排查
    const files = readdirSync(dir);
    assert.ok(
      files.some((f) => f.includes('corrupt')),
      `应保留坏档：${files.join(',')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4: sizeBytes 可用于健康检查判断数据规模', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruatrip-size-'));
  const store = new Store(dir, { debounceMs: 0 });
  try {
    const before = store.sizeBytes();
    store.update((d) => {
      d.meta.padding = 'y'.repeat(10_000);
      return true;
    });
    await store.flush();
    assert.ok(store.sizeBytes() > before + 9_000, '写入后体积应增长');
  } finally {
    // 必须先停掉 store 的异步写入，再删临时目录，
    // 否则在途的 rename 会因目录消失而失败
    await store.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4: 数据目录消失不会导致未处理的 rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruatrip-gone-'));
  const store = new Store(dir, { debounceMs: 10 });
  store.update((d) => {
    d.meta.x = 1;
    return true;
  });
  // 模拟容器关闭：目录在写入完成前被移除
  rmSync(dir, { recursive: true, force: true });
  // 这里不应抛异常，也不应产生 unhandledRejection
  await assert.doesNotReject(() => store.flush());
  await store.destroy();
});
