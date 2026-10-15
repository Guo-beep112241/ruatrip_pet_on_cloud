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
/**
 * 不该被当静态资源服务的路径。
 *
 * 审计 S3：旧实现对任何「没有扩展名」的未知路径都回退 index.html，
 * 导致 /.env、/.git/config、/Dockerfile 全部返回 200。
 * 内容虽然只是 index.html（源码在 WEB_DIST 之外本来就读不到），
 * 但探测者无法区分「存在」与「不存在」，且会被 CDN 与搜索引擎收录。
 */
/**
 * 反向做法：**只允许已知的静态资源类型**，其余一律不服务。
 *
 * 白名单比黑名单可靠——不会因为以后新增了某个敏感文件（Dockerfile、
 * docker-compose.yml、backup.sql……）而漏掉。
 */
const SERVABLE_EXTENSIONS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.map',
  '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.ogg', '.wav', '.mp4', '.webm',
  '.glb', '.gltf', '.bin', '.ktx2',
  '.txt', '.xml', '.webmanifest', '.wasm',
]);

/** 明确允许的点开头路径（行业标准，浏览器会主动请求） */
const ALLOWED_DOT_PATHS = ['/.well-known/'];

function isBlockedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();

  // 行业标准路径放行
  if (ALLOWED_DOT_PATHS.some((p) => lower.startsWith(p))) return false;

  // 逐段判断：任何一段以点开头都拦掉（覆盖 /.env 与 /a/.env 两种形式，
  // 同时排除 .git、.data、.vscode 等）
  const segments = lower.split('/').filter(Boolean);
  if (segments.some((seg) => seg.startsWith('.'))) return true;

  const ext = extname(lower);
  // 无扩展名 → 一般是 SPA 前端路由（/cabin、/profile）。
  // 但要挡掉那些「本身没有扩展名、却是仓库里的真实文件」的名字，
  // 否则 /Dockerfile、/Makefile 这类会被 SPA 回退成 200（审计 S3 残留）。
  if (!ext) return EXTENSIONLESS_FILE_NAMES.has(segments[segments.length - 1] ?? '');
  // 有扩展名 → 必须在可服务白名单里
  return !SERVABLE_EXTENSIONS.has(ext);
}

/** 没有扩展名但属于「文件名」的常见形态，不应被当作前端路由 */
const EXTENSIONLESS_FILE_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'rakefile', 'procfile', 'jenkinsfile',
  'license', 'licence', 'notice', 'changelog', 'contributing', 'codeowners',
  'readme', 'authors', 'gemfile', 'vagrantfile', 'brewfile',
]);

export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!webDistAvailable()) return false;
  // 敏感路径直接交回上层返回 404，不做 SPA 回退
  if (isBlockedPath(pathname)) return false;

  const requested = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(WEB_DIST, safe);

  // 目录穿越保护
  if (!filePath.startsWith(WEB_DIST)) return false;

  // SPA 回退：只对「无扩展名的前端路由」生效。
  // 带扩展名但文件不存在的请求（如 /foo.bar）不伪造 index.html，
  // 否则会把 HTML 冒充成任意路径的内容（审计 S3）。
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
