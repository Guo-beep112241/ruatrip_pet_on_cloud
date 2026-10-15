/**
 * 内置到项目里的持久化驱动实现。
 *
 * 顺序即推荐度：
 *   sqlite   —— 有 DATABASE_URL(file:) 或默认单机场景，零依赖、真持久化
 *   postgres —— 有 DATABASE_URL(postgres:) 且已装 pg，多实例部署
 *   file     —— 兜底，适合本地开发
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COLLECTIONS,
  batchIsEmpty,
  type PersistBatch,
  type PersistenceDriver,
} from './driver.ts';

/* ============================================================
 * 1. 文件驱动（默认，零配置）
 * ============================================================ */

export class FileDriver implements PersistenceDriver {
  readonly kind = 'file' as const;
  private readonly file: string;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'ruatrip.json');
  }

  async load(): Promise<Record<string, unknown>> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      // 坏档留档，避免整个服务起不来
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined);
      return {};
    }
  }

  /**
   * 文件驱动没有「按行更新」的概念，只能整文件重写。
   * 这也是为什么要提供 sqlite/postgres：数据一多，文件驱动就会成为瓶颈。
   */
  async persist(batch: PersistBatch): Promise<void> {
    if (batchIsEmpty(batch)) return;
    const snapshot = await this.load();
    for (const [name, rows] of Object.entries(batch.upserts)) {
      const list = (snapshot[name] as { id: string }[] | undefined) ?? [];
      const byId = new Map(list.map((r) => [r.id, r]));
      for (const row of rows) byId.set(row.id, row.data as { id: string });
      snapshot[name] = [...byId.values()];
    }
    for (const [name, ids] of Object.entries(batch.deletes)) {
      const list = (snapshot[name] as { id: string }[] | undefined) ?? [];
      const drop = new Set(ids);
      snapshot[name] = list.filter((r) => !drop.has(r.id));
    }
    for (const [name, value] of Object.entries(batch.singletons)) {
      snapshot[name] = value;
    }

    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  async healthy(): Promise<boolean> {
    return existsSync(this.dir);
  }

  async close(): Promise<void> {
    /* 无连接需要关闭 */
  }
}

/* ============================================================
 * 2. SQLite 驱动（Node 22.5+ 内置 node:sqlite，零依赖）
 * ============================================================ */

/** 最小化的 node:sqlite 类型（避免依赖 @types 版本差异） */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

/**
 * 表结构：每张业务表两列 —— id 主键 + data(JSON 文本)。
 *
 * 为什么不用 JSONB：node:sqlite 的 JSON 函数能力有限，而本项目
 * 的业务查询都发生在内存里（见 Store 的设计），数据库只承担持久化职责。
 * 这样表结构极简，迁移与排错都容易。
 */
const SINGLETON_KEYS = ['user', 'surveyAnswers', 'meta'] as const;

export class SqliteDriver implements PersistenceDriver {
  readonly kind = 'sqlite' as const;
  private db: SqliteDatabase | null = null;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private async open(): Promise<SqliteDatabase> {
    if (this.db) return this.db;
    let mod: SqliteModule;
    try {
      mod = (await import('node:sqlite')) as unknown as SqliteModule;
    } catch {
      throw new Error(
        'SQLITE_UNAVAILABLE：当前 Node 版本没有内置 node:sqlite（需要 Node 22.5+）。' +
          '请升级 Node，或改用 FILE 存储，或配置 DATABASE_URL 使用 Postgres。',
      );
    }
    const dir = this.file.slice(0, this.file.lastIndexOf('/'));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

    const db = new mod.DatabaseSync(this.file);
    // WAL 提升并发读写表现；NORMAL 同步级别在持久性与速度之间取平衡
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of COLLECTIONS) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    }
    for (const name of SINGLETON_KEYS) {
      db.exec(`CREATE TABLE IF NOT EXISTS "singleton_${name}" (k TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    }
    db.exec('CREATE TABLE IF NOT EXISTS meta_schema (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO meta_schema (k, v) VALUES (?, ?)').run('version', '1');
    this.db = db;
    return db;
  }

  async load(): Promise<Record<string, unknown>> {
    const db = await this.open();
    const snapshot: Record<string, unknown> = {};
    for (const name of COLLECTIONS) {
      const rows = db.prepare(`SELECT data FROM "${name}"`).all() as { data: string }[];
      snapshot[name] = rows.map((r) => JSON.parse(r.data) as unknown);
    }
    for (const name of SINGLETON_KEYS) {
      const row = db.prepare(`SELECT data FROM "singleton_${name}" WHERE k = ?`).get('value') as
        | { data: string }
        | undefined;
      snapshot[name] = row ? (JSON.parse(row.data) as unknown) : null;
    }
    return snapshot;
  }

  async persist(batch: PersistBatch): Promise<void> {
    if (batchIsEmpty(batch)) return;
    const db = await this.open();

    // 事务保证一批变更要么全成功要么全回滚（避免关联数据写一半）
    db.exec('BEGIN');
    try {
      for (const [name, rows] of Object.entries(batch.upserts)) {
        const stmt = db.prepare(`INSERT INTO "${name}" (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`);
        for (const row of rows) stmt.run(row.id, JSON.stringify(row.data));
      }
      for (const [name, ids] of Object.entries(batch.deletes)) {
        const stmt = db.prepare(`DELETE FROM "${name}" WHERE id = ?`);
        for (const id of ids) stmt.run(id);
      }
      for (const [name, value] of Object.entries(batch.singletons)) {
        const stmt = db.prepare(
          `INSERT INTO "singleton_${name}" (k, data) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data`,
        );
        stmt.run('value', JSON.stringify(value ?? null));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const db = await this.open();
      const row = db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

/* ============================================================
 * 3. Postgres 驱动（需要 npm i pg）
 * ============================================================ */

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/**
 * 表结构与 SQLite 一致：id + data(JSONB)。
 *
 * 为什么用 `pg` 而不是 Supabase REST：
 *   - 自建 Postgres、Neon、Supabase、RDS 都能连，不绑定供应商
 *   - 事务语义清晰，迁移脚本就是普通 SQL
 * 代价是多一个依赖，所以做成按需加载：不装也能跑（走 sqlite/file）。
 */
export class PostgresDriver implements PersistenceDriver {
  readonly kind = 'postgres' as const;
  private client: PgClient | null = null;
  private readonly connectionString: string;
  private readonly ssl: boolean;

  constructor(connectionString: string, ssl = true) {
    this.connectionString = connectionString;
    this.ssl = ssl;
  }

  private async open(): Promise<PgClient> {
    if (this.client) return this.client;
    let pg: { Client: new (cfg: Record<string, unknown>) => PgClient };
    try {
      // 变量说明符避免打包器静态分析，让 pg 保持可选依赖
      const specifier = 'pg';
      pg = (await import(specifier)) as unknown as { Client: new (cfg: Record<string, unknown>) => PgClient };
    } catch {
      throw new Error(
        'PG_NOT_INSTALLED：使用 Postgres 需要先安装驱动 —— 运行 `npm i pg`（在仓库根目录）。' +
          '若不想引入依赖，可改用 SQLite（STORAGE_DRIVER=sqlite）或 FILE。',
      );
    }
    const client = new pg.Client({
      connectionString: this.connectionString,
      ssl: this.ssl ? { rejectUnauthorized: false } : false,
    });
    await client.connect();
    await this.migrate(client);
    this.client = client;
    return client;
  }

  private async migrate(client: PgClient): Promise<void> {
    for (const name of COLLECTIONS) {
      await client.query(
        `CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY, data JSONB NOT NULL)`,
      );
    }
    for (const name of SINGLETON_KEYS) {
      await client.query(
        `CREATE TABLE IF NOT EXISTS "singleton_${name}" (k TEXT PRIMARY KEY, data JSONB NOT NULL)`,
      );
    }
    await client.query('CREATE TABLE IF NOT EXISTS meta_schema (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    await client.query('INSERT INTO meta_schema (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING', [
      'version',
      '1',
    ]);
  }

  async load(): Promise<Record<string, unknown>> {
    const client = await this.open();
    const snapshot: Record<string, unknown> = {};
    for (const name of COLLECTIONS) {
      const { rows } = await client.query(`SELECT data FROM "${name}"`);
      snapshot[name] = rows.map((r) => r.data as unknown);
    }
    for (const name of SINGLETON_KEYS) {
      const { rows } = await client.query(`SELECT data FROM "singleton_${name}" WHERE k = $1`, ['value']);
      snapshot[name] = rows[0]?.data ?? null;
    }
    return snapshot;
  }

  async persist(batch: PersistBatch): Promise<void> {
    if (batchIsEmpty(batch)) return;
    const client = await this.open();
    await client.query('BEGIN');
    try {
      for (const [name, rows] of Object.entries(batch.upserts)) {
        for (const row of rows) {
          await client.query(
            `INSERT INTO "${name}" (id, data) VALUES ($1, $2::jsonb)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [row.id, JSON.stringify(row.data)],
          );
        }
      }
      for (const [name, ids] of Object.entries(batch.deletes)) {
        for (const id of ids) {
          await client.query(`DELETE FROM "${name}" WHERE id = $1`, [id]);
        }
      }
      for (const [name, value] of Object.entries(batch.singletons)) {
        await client.query(
          `INSERT INTO "singleton_${name}" (k, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data`,
          ['value', JSON.stringify(value ?? null)],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const client = await this.open();
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }
}

/* ============================================================
 * 从环境变量构建
 * ============================================================ */

export interface DriverChoice {
  driver: PersistenceDriver;
  /** 人类可读的说明，启动日志与 /api/health 会展示 */
  description: string;
  /** 是否需要提醒运维注意（例如用了不适合生产的存储） */
  productionWarning?: string;
}

export interface DriverConfig {
  dataDir: string;
  /** 显式指定驱动：auto | file | sqlite | postgres */
  driver: 'auto' | 'file' | 'sqlite' | 'postgres';
  /** postgres 连接串 */
  databaseUrl: string;
  /** sqlite 文件路径 */
  sqliteFile: string;
  /** postgres 是否强制 SSL */
  pgSsl: boolean;
}

export function createPersistenceDriver(config: DriverConfig): DriverChoice {
  const explicit = config.driver;
  const url = config.databaseUrl;

  const usePostgres = explicit === 'postgres' || (explicit === 'auto' && /^postgres(ql)?:\/\//i.test(url));
  if (usePostgres) {
    if (!url) {
      throw new Error('PERSISTENCE_CONFIG：指定了 postgres 驱动但没有提供 DATABASE_URL。');
    }
    return {
      driver: new PostgresDriver(url, config.pgSsl),
      description: `Postgres（${url.replace(/:[^:@/]+@/, ':***@').slice(0, 60)}）`,
    };
  }

  const useSqlite = explicit === 'sqlite' || (explicit === 'auto' && canUseSqlite());
  if (useSqlite) {
    return {
      driver: new SqliteDriver(config.sqliteFile),
      description: `SQLite（${config.sqliteFile}）`,
    };
  }

  return {
    driver: new FileDriver(config.dataDir),
    description: `JSON 文件（${join(config.dataDir, 'ruatrip.json')}）`,
    productionWarning:
      'JSON 文件驱动在多实例部署或容器重建时会丢数据。生产环境请配置 DATABASE_URL（Postgres）或 STORAGE_DRIVER=sqlite。',
  };
}

/** Node 22.5+ 才有 node:sqlite；低版本自动回落文件驱动 */
function canUseSqlite(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  return major > 22 || (major === 22 && minor >= 5);
}
