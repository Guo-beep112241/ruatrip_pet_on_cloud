/**
 * 内存快照 + 可插拔持久化（审计 B1、B4）。
 *
 * 设计取舍（明确写在这里，避免后来者误判）：
 *
 *   本项目选择「进程内全量快照 + 增量落盘」而不是「每次查询都打数据库」。
 *   理由：单个用户的数据量很小（实测 17 个集合、十几条记录、KB 级），
 *   读走内存延迟最低，业务代码也不用处理异步与连接池。
 *
 *   代价与边界：
 *     - 内存占用随用户数线性增长。按每用户 5 只宠物、每只 200 条互动估算约
 *       200KB/用户 → 1000 用户约 200MB，单机仍可接受；上万用户必须改为
 *       「按用户分片查询」，那是一次真正的仓储层重写
 *       （只需改 repositories/index.ts 的 22 个方法，见 docs/ARCHITECTURE.md）。
 *     - 多实例部署时各实例内存不一致，因此多实例必须同时换成按需查询的仓储实现。
 *
 *   落盘策略：
 *     1. **增量**：只写变化的记录（diff 快照），不再整文件重写
 *     2. **防抖**：合并短时间内的多次变更（默认 250ms）
 *     3. **异步 + 原子**：不阻塞事件循环，失败不让进程崩溃
 *     4. **串行**：上一批没写完就排队，避免并发覆盖
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffSnapshot, type PersistBatch, type PersistenceDriver } from './driver.ts';
import { FileDriver } from './drivers.ts';
import type { AccountRecord } from '../auth/index.ts';
import type {
  AffectionLogEntry,
  Badge,
  CapsuleProject,
  ChatMessage,
  Checkin,
  Conversation,
  FosterRequest,
  GenerationJob,
  JournalEntry,
  MemoryEntry,
  Pet,
  Postcard,
  PreferenceAnswers,
  UserProfile,
  WishlistItem,
} from '../../../../packages/shared/src/index.ts';

export interface StoreSchema {
  version: number;
  /**
   * 旧版单用户字段。
   * 保留是为了兼容既有存档：首次启动时会被迁移进 `users` 并清空。
   * 新代码不要再直接读写它。
   */
  user: UserProfile | null;
  /** 账号集合（含凭据哈希；绝不整体返回给前端） */
  users: AccountRecord[];
  surveyAnswers: PreferenceAnswers | null;
  pets: Pet[];
  generationJobs: GenerationJob[];
  interactions: AffectionLogEntry[];
  conversations: Conversation[];
  messages: ChatMessage[];
  memories: MemoryEntry[];
  checkins: Checkin[];
  wishlist: WishlistItem[];
  badges: Badge[];
  journals: JournalEntry[];
  postcards: Postcard[];
  capsules: CapsuleProject[];
  fosters: FosterRequest[];
  meta: Record<string, string | number | boolean>;
}

export const emptyStore = (): StoreSchema => ({
  version: 1,
  user: null,
  users: [],
  surveyAnswers: null,
  pets: [],
  generationJobs: [],
  interactions: [],
  conversations: [],
  messages: [],
  memories: [],
  checkins: [],
  wishlist: [],
  badges: [],
  journals: [],
  postcards: [],
  capsules: [],
  fosters: [],
  meta: {},
});

export interface StoreOptions {
  /** 防抖窗口（毫秒）；0 表示每次变更立即异步落盘 */
  debounceMs?: number;
  /** 超过这个耗时就打印慢写入告警 */
  warnSlowMs?: number;
  /** 持久化驱动；不传则用文件驱动（向后兼容） */
  driver?: PersistenceDriver;
}

export class Store {
  private data: StoreSchema = emptyStore();
  /** 已确认落盘的快照，用于计算增量 */
  private persisted: Record<string, unknown> = {};
  private readonly driver: PersistenceDriver;
  private readonly file: string;
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly warnSlowMs: number;

  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private pendingWrite = false;
  private lastWriteError: Error | null = null;
  private loaded = false;

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = dir;
    this.debounceMs = options.debounceMs ?? 250;
    this.warnSlowMs = options.warnSlowMs ?? 400;
    this.file = join(dir, 'ruatrip.json');
    this.driver = options.driver ?? new FileDriver(dir);

    // 文件驱动在构造期同步加载，保持既有调用点不变；
    // 其它驱动（sqlite/postgres）是异步 IO，由服务启动时 await store.init()
    if (this.driver.kind === 'file') this.loadSync();
  }

  /* ---------------- 加载 ---------------- */

  private loadSync(): void {
    if (!existsSync(this.file)) {
      this.data = emptyStore();
      this.writeFullSync();
      this.persisted = toPlain(this.data);
      this.loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreSchema>;
      this.data = mergeSchema(parsed);
    } catch {
      // 坏档留档，服务照常起来
      renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      this.data = emptyStore();
      this.writeFullSync();
    }
    this.persisted = toPlain(this.data);
    this.loaded = true;
  }

  /** 异步加载：任意驱动可用；服务启动时调用一次 */
  async init(): Promise<void> {
    if (this.loaded) return;
    const snapshot = await this.driver.load();
    this.data = mergeSchema(snapshot as Partial<StoreSchema>);
    this.persisted = toPlain(this.data);
    this.loaded = true;
  }

  private writeFullSync(): void {
    if (!existsSync(this.dir)) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /* ---------------- 读写 ---------------- */

  read(): StoreSchema {
    return this.data;
  }

  /** 变更数据并安排一次落盘 */
  update<T>(mutator: (data: StoreSchema) => T): T {
    const result = mutator(this.data);
    this.schedule();
    return result;
  }

  private schedule(): void {
    if (this.debounceMs <= 0) {
      void this.flush().catch(() => undefined);
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // 必须在这里 catch：否则失败会变成 unhandledRejection，
      // Node 默认直接终止进程（容器关闭时数据目录消失正好走这条路径）。
      void this.flush().catch(() => undefined);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** 计算增量并落盘；写入串行执行，避免并发覆盖 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) {
      this.pendingWrite = true;
      return this.writing;
    }
    this.pendingWrite = false;
    this.writing = this.writeOnce().finally(() => {
      this.writing = null;
    });
    await this.writing;
    if (this.pendingWrite) await this.flush();
  }

  private async writeOnce(): Promise<void> {
    const started = Date.now();
    const current = toPlain(this.data);
    const batch: PersistBatch = diffSnapshot(this.persisted, current);
    if (isBatchEmpty(batch)) return;

    try {
      await this.driver.persist(batch);
      this.persisted = current;
      this.lastWriteError = null;
      const cost = Date.now() - started;
      if (cost > this.warnSlowMs) {
        console.warn(`[ruatrip:store] 落盘耗时 ${cost}ms（驱动 ${this.driver.kind}）`);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      this.lastWriteError = err;
      if (err.code === 'ENOENT' && !existsSync(this.dir)) {
        console.warn('[ruatrip:store] 数据目录已不存在，跳过本次落盘');
        return;
      }
      console.error('[ruatrip:store] 落盘失败：', err);
      throw err;
    }
  }

  /** 同步落盘：仅供退出流程与测试使用（仅文件驱动支持） */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.driver.kind !== 'file') {
      console.warn('[ruatrip:store] flushSync 仅支持文件驱动，请改用 await flush() / drain()');
      return;
    }
    this.writeFullSync();
    this.persisted = toPlain(this.data);
  }

  /** 停止接受新的落盘并等待在途写入完成 */
  async destroy(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) await this.writing.catch(() => undefined);
    this.pendingWrite = false;
  }

  /** 等待所有待写内容落盘（优雅退出时调用） */
  async drain(): Promise<void> {
    if (this.timer) await this.flush();
    else if (this.writing) await this.writing;
  }

  /** 落盘并关闭驱动连接（优雅退出的最后一步） */
  async close(): Promise<void> {
    await this.drain();
    await this.driver.close();
  }

  /* ---------------- 观测 ---------------- */

  get writeError(): Error | null {
    return this.lastWriteError;
  }

  get driverKind(): PersistenceDriver['kind'] {
    return this.driver.kind;
  }

  /** 数据规模：文件驱动返回文件大小，其它驱动返回内存快照字节数 */
  sizeBytes(): number {
    if (this.driver.kind === 'file' && existsSync(this.file)) {
      try {
        return readFileSync(this.file).length;
      } catch {
        /* 退化为内存估算 */
      }
    }
    return Buffer.byteLength(JSON.stringify(this.data));
  }

  isDirty(): boolean {
    return this.timer !== null || this.writing !== null;
  }

  reset(): void {
    this.data = emptyStore();
    this.schedule();
  }
}

/**
 * 转成可 diff 的普通对象。
 * 用显式断言而不是泛型 clone：StoreSchema 没有索引签名，
 * 而 diffSnapshot 需要按集合名访问字段。
 */
/**
 * 把加载到的快照合并到空档上。
 *
 * 为什么不直接用 `{...empty, ...loaded}`：
 * 驱动在「该字段还没有数据」时会返回 null（例如 SQLite 的单例表为空），
 * 展开运算会把这个 null 覆盖到默认值上，导致 `meta` 变成 null 而崩在 getMeta。
 * 这里显式处理每一种字段的形态，坏值一律回落默认。
 */
function mergeSchema(loaded: Partial<StoreSchema>): StoreSchema {
  const base = emptyStore();
  const result: StoreSchema = { ...base };

  result.version = typeof loaded.version === 'number' ? loaded.version : base.version;

  for (const key of SINGLETON_OBJECT_KEYS) {
    const value = loaded[key];
    // user / surveyAnswers 允许为 null（表示尚未创建），但必须是对象或 null
    result[key] = value && typeof value === 'object' ? (value as never) : null;
  }
  const meta = loaded.meta;
  result.meta = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};

  for (const key of ARRAY_KEYS) {
    const value = loaded[key];
    result[key] = Array.isArray(value) ? (value as never) : [];
  }
  return result;
}

const SINGLETON_OBJECT_KEYS = ['user', 'surveyAnswers'] as const;

const ARRAY_KEYS = [
  'users',
  'pets',
  'generationJobs',
  'interactions',
  'conversations',
  'messages',
  'memories',
  'checkins',
  'wishlist',
  'badges',
  'journals',
  'postcards',
  'capsules',
  'fosters',
] as const;

function toPlain(schema: StoreSchema): Record<string, unknown> {
  try {
    return structuredClone(schema) as unknown as Record<string, unknown>;
  } catch {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  }
}

function isBatchEmpty(batch: PersistBatch): boolean {
  return (
    Object.keys(batch.singletons).length === 0 &&
    Object.values(batch.upserts).every((rows) => rows.length === 0) &&
    Object.values(batch.deletes).every((ids) => ids.length === 0)
  );
}

/* ------------------------------------------------------------------ */
/* 单例工厂                                                            */
/* ------------------------------------------------------------------ */

let store: Store | null = null;

/**
 * 取全局 Store。
 *
 * 注意：sqlite/postgres 驱动需要先 await init() 才能读到数据，
 * 所以服务启动流程是：
 *   const store = getStore(dir, { driver }); await store.init();
 */
export function getStore(dir: string, options: StoreOptions = {}): Store {
  if (!store) store = new Store(dir, options);
  return store;
}

/** 仅供测试重置单例 */
export function __resetStoreForTests(): void {
  store = null;
}
