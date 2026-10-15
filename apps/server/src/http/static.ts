/**
 * 生产环境静态资源托管。
 *
 * 说明：为了让「一个命令跑起来」成立，服务端会在构建产物存在时同源托管前端，
 * 这样就不需要额外起一个静态服务器，也不会有跨域问题。
 * 如果 apps/web/dist 不存在（例如只跑 API），本模块自动跳过，不影响接口。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server/src/http -> 仓库根 */
export const REPO_ROOT = resolve(here, '../../../..');
export const WEB_DIST = join(REPO_ROOT, 'apps/web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function webDistAvailable(): boolean {
  return existsSync(join(WEB_DIST, 'index.html'));
}

/** 返回 true 表示已经处理了响应 */
export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!webDistAvailable()) return false;

  const requested = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(WEB_DIST, safe);

  // 目录穿越保护
  if (!filePath.startsWith(WEB_DIST)) return false;

  // SPA 回退：没有扩展名或文件不存在时，交回 index.html
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (extname(requested)) return false;
    filePath = join(WEB_DIST, 'index.html');
  }

  const ext = extname(filePath).toLowerCase();
  const isHashed = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}
