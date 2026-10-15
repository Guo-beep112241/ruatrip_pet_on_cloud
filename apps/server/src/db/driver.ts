/**
 * 持久化驱动抽象（审计 B1）。
 *
 * 背景：原实现把全部数据放在内存，每次变更重写整个 JSON 文件。
 * 部署到云平台后容器一重建，用户养了一个月的宠物就全没了。
 *
 * 现在的设计：
 *   - `Store` 仍然维护内存快照（本项目的数据量级下这是正确取舍：
 *     单用户几十条记录，读走内存最快；规模上限与迁移路径见 docs/ARCHITECTURE.md）
 *   - 落盘交给 `PersistenceDriver`：**按记录增量写入**，不再整文件重写
 *   - 三个驱动：
 *       file     —— 默认，零配置，本地开发与单机部署可用
 *       sqlite   —— Node 22.5+ 内置 `node:sqlite`，零依赖拿到真持久化
 *       postgres —— 需要 `npm i pg`；多实例部署的唯一正确选择
 *
 * 驱动只负责「存取」，不理解业务语义；业务规则仍全部在 services 层。
 */

/** 集合名 = StoreSchema 里除 version/meta 之外的数组字段 */
export type CollectionName =
  | 'users'
  | 'pets'
  | 'generationJobs'
  | 'interactions'
  | 'conversations'
  | 'messages'
  | 'memories'
  | 'checkins'
  | 'wishlist'
  | 'badges'
  | 'journals'
  | 'postcards'
  | 'capsules'
  | 'fosters';

export const COLLECTIONS: CollectionName[] = [
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
];

/**
 * 单条记录必须有 id。
 * `users` 也是带 id 的集合（多账号），不再是单例。
 * 只剩 surveyAnswers / meta 是单例；旧版单例 `user` 保留兼容（首次启动会迁移）。
 */
export interface PersistRecord {
  id: string;
  data: unknown;
}

export interface PersistBatch {
  upserts: Record<string, PersistRecord[]>;
  deletes: Record<string, string[]>;
  /** 单例：user / surveyAnswers / meta —— 整体覆盖 */
  singletons: Record<string, unknown>;
}

export function emptyBatch(): PersistBatch {
  return { upserts: {}, deletes: {}, singletons: {} };
}

export function batchIsEmpty(batch: PersistBatch): boolean {
  return (
    Object.keys(batch.singletons).length === 0 &&
    Object.values(batch.upserts).every((rows) => rows.length === 0) &&
    Object.values(batch.deletes).every((ids) => ids.length === 0)
  );
}

/** 从内存快照算出一批增量变更 */
export function diffSnapshot(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): PersistBatch {
  const batch = emptyBatch();

  for (const name of COLLECTIONS) {
    const before = (previous[name] as PersistRecord[] | undefined) ?? [];
    const after = (next[name] as PersistRecord[] | undefined) ?? [];
    const beforeById = new Map(before.map((r) => [r.id, r]));
    const afterById = new Map(after.map((r) => [r.id, r]));

    const upserts: PersistRecord[] = [];
    for (const [id, record] of afterById) {
      const prior = beforeById.get(id);
      // 用 JSON 比较判断是否真的变了，避免无意义的数据库写入
      if (!prior || JSON.stringify(prior) !== JSON.stringify(record)) {
        upserts.push({ id, data: record });
      }
    }
    const deletes: string[] = [];
    for (const id of beforeById.keys()) {
      if (!afterById.has(id)) deletes.push(id);
    }
    if (upserts.length) batch.upserts[name] = upserts;
    if (deletes.length) batch.deletes[name] = deletes;
  }

  // 兼容旧单例 `user`：如果存在就当作唯一账号迁移进 users
  for (const name of ['user', 'surveyAnswers', 'meta'] as const) {
    const before = previous[name];
    const after = next[name];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      batch.singletons[name] = after ?? null;
    }
  }

  return batch;
}

export interface PersistenceDriver {
  readonly kind: 'file' | 'sqlite' | 'postgres';
  /** 读取全量快照（启动时调用一次） */
  load(): Promise<Record<string, unknown>>;
  /** 应用一批增量变更，必须保证原子性 */
  persist(batch: PersistBatch): Promise<void>;
  /** 健康探测 */
  healthy(): Promise<boolean>;
  /** 关闭连接（优雅退出） */
  close(): Promise<void>;
}
