#!/usr/bin/env node
/**
 * 数据备份脚本（审计 O4）。
 *
 * 没有备份的持久化等于没有持久化：SQLite 文件损坏、误删账号、
 * 迁移失败都会造成不可逆的数据丢失。
 *
 * 用法：
 *   node scripts/backup.mjs                    # 备份到 ./backups/
 *   node scripts/backup.mjs --out /var/backups # 指定目录
 *   node scripts/backup.mjs --keep 14          # 只保留最近 14 份
 *
 * 支持 SQLite 与 JSON 文件两种驱动。Postgres 请用 pg_dump：
 *   pg_dump "$DATABASE_URL" | gzip > backup-$(date +%F).sql.gz
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dataDir = resolve(argOf('--data', process.env.DATA_DIR ?? './.data'));
const outDir = resolve(argOf('--out', './backups'));
const keep = Number(argOf('--keep', '7'));

if (!existsSync(dataDir)) {
  console.error(`数据目录不存在：${dataDir}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(outDir, `ruatrip-${stamp}`);
mkdirSync(target, { recursive: true });

let backedUp = 0;

/** SQLite：先 checkpoint 把 WAL 合并进主库，再复制 */
const dbFile = join(dataDir, 'ruatrip.db');
if (existsSync(dbFile)) {
  try {
    execFileSync('sqlite3', [dbFile, 'PRAGMA wal_checkpoint(TRUNCATE);'], { stdio: 'ignore' });
    console.log('已 checkpoint WAL');
  } catch {
    // 没装 sqlite3 CLI 也能继续：直接拷 .db/.wal/-shm 三个文件
    console.log('（未找到 sqlite3 命令，直接复制数据库文件）');
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${dbFile}${suffix}`;
    if (existsSync(f)) {
      cpSync(f, join(target, `ruatrip.db${suffix}`));
      backedUp += 1;
    }
  }
}

/** JSON 文件驱动 */
const jsonFile = join(dataDir, 'ruatrip.json');
if (existsSync(jsonFile)) {
  cpSync(jsonFile, join(target, 'ruatrip.json'));
  backedUp += 1;
}

/** 上传的图片（本地存储驱动才有） */
const uploads = join(dataDir, 'uploads');
if (existsSync(uploads)) {
  cpSync(uploads, join(target, 'uploads'), { recursive: true });
  backedUp += 1;
}

if (!backedUp) {
  console.error(`在 ${dataDir} 里没有找到可备份的数据（ruatrip.db / ruatrip.json / uploads）`);
  console.error('如果用的是 Postgres，请改用 pg_dump（见脚本头部说明）。');
  process.exit(1);
}

const size = execFileSync('du', ['-sh', target], { encoding: 'utf8' }).split('\t')[0];
console.log(`✓ 备份完成：${target}（${size}，${backedUp} 项）`);

/** 轮转：只保留最近 keep 份 */
const entries = readdirSync(outDir)
  .filter((n) => n.startsWith('ruatrip-'))
  .map((n) => ({ n, t: statSync(join(outDir, n)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

for (const { n } of entries.slice(keep)) {
  rmSync(join(outDir, n), { recursive: true, force: true });
  console.log(`  已清理旧备份 ${n}`);
}
console.log(`  当前保留 ${Math.min(entries.length, keep)} 份`);
