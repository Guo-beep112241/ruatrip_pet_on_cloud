/**
 * 轻量 JSON 存储层。
 *
 * 设计说明：这是「数据层」的默认实现，目的是让项目零依赖即可完整运行。
 * 说明书第十章的数据层要求（宠物资产元数据 / 互动日志 / 记忆库 / 行为埋点）
 * 都在 Store 里有对应集合。生产环境把这一层替换为 Postgres/Supabase 即可，
 * 上层 repository 与 service 的调用签名保持不变（见 docs/ARCHITECTURE.md）。
 */
import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { writeFileSync as writeFileSyncCompat } from 'node:fs';
import { join } from 'node:path';
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
  user: UserProfile | null;
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

const emptyStore = (): StoreSchema => ({
  version: 1,
  user: null,
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

/**
 * 写入策略（审计 B4 修复）。
 *
 * 旧实现每次变更都 `writeFileSync` 全量落盘：JSON 涨到几十 MB 后，
 * 每一次互动都会同步阻塞事件循环，表现为整个服务变慢甚至卡死。
 *
 * 现在改为：
 *   1. **防抖**：合并短时间内的多次变更，只落盘一次（默认 250ms）
 *   2. **异步**：用 fs/promises，不阻塞事件循环
 *   3. **原子**：先写 .tmp 再 rename，进程被杀也不会留下半个文件
 *   4. **串行**：写入排队，避免并发 rename 互相覆盖
 *   5. **兜底**：flushSync() 供退出流程与测试使用
 */
export interface StoreOptions {
  /** 防抖窗口（毫秒）；设 0 表示每次变更立即异步落盘 */
  debounceMs?: number;
  /** 是否在控制台打印慢写入告警 */
  warnSlowMs?: number;
}

export class Store {
  private data: StoreSchema = emptyStore();
  private readonly file: string;
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly warnSlowMs: number;

  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private pendingWrite = false;
  private lastWriteError: Error | null = null;

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = dir;
    this.debounceMs = options.debounceMs ?? 250;
    this.warnSlowMs = options.warnSlowMs ?? 400;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'ruatrip.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.data = emptyStore();
      this.flushSync();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreSchema>;
      this.data = { ...emptyStore(), ...parsed };
    } catch {
      // 数据损坏时保留坏档，重建空档，避免整个服务起不来
      renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      this.data = emptyStore();
      this.flushSync();
    }
  }

  read(): StoreSchema {
    return this.data;
  }

  /** 变更数据并安排一次落盘（防抖 + 异步） */
  update<T>(mutator: (data: StoreSchema) => T): T {
    const result = mutator(this.data);
    this.schedule();
    return result;
  }

  /** 预约落盘：合并短时间内的多次变更 */
  private schedule(): void {
    if (this.debounceMs <= 0) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // 必须在这里 catch：否则失败会变成 unhandledRejection，
      // 在 Node 里默认直接终止进程（例如容器关闭时数据目录被移除）。
      // 错误本身已记录在 lastWriteError，由 /api/health 暴露。
      void this.flush().catch(() => undefined);
    }, this.debounceMs);
    // 不阻止进程退出：即使定时器还没触发，SIGTERM 处理里会 flushSync 兜底
    this.timer.unref?.();
  }

  /**
   * 异步原子落盘。
   * 写入串行执行：如果上一次还没写完，就把本次标记为 pending，
   * 等上一次结束后再写，避免两个 rename 互相覆盖。
   */
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
    // 写入期间又有变更 → 再写一次
    if (this.pendingWrite) await this.flush();
  }

  private async writeOnce(): Promise<void> {
    const started = Date.now();
    const tmp = `${this.file}.tmp`;
    // 先在内存里序列化，避免 await 期间数据被并发修改导致快照不一致
    const payload = JSON.stringify(this.data, null, 2);
    try {
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.file);
      this.lastWriteError = null;
      const cost = Date.now() - started;
      if (cost > this.warnSlowMs) {
        console.warn(
          `[ruatrip:store] 落盘耗时 ${cost}ms（数据 ${(payload.length / 1024).toFixed(0)}KB）。` +
            '数据量继续增长时建议迁移到数据库，见 docs/API-INTEGRATION.md 第 11 节。',
        );
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      this.lastWriteError = err;
      // 数据目录被移除（容器正在关闭、测试清理了临时目录）不算致命：
      // 记录状态即可，不要打断进程，更不要变成未处理的 rejection。
      if (err.code === 'ENOENT' && !existsSync(this.dir)) {
        console.warn('[ruatrip:store] 数据目录已不存在，跳过本次落盘');
        return;
      }
      console.error('[ruatrip:store] 落盘失败：', err);
      throw err;
    }
  }

  /** 同步落盘：仅供构造期、测试与退出流程使用 */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    writeFileSyncCompat(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /**
   * 停止接受新的落盘并等待在途写入完成。
   * 测试清理临时目录、以及进程退出前都该调用它。
   */
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

  /** 最近一次落盘错误，供 /api/health 探测 */
  get writeError(): Error | null {
    return this.lastWriteError;
  }

  /** 数据文件大小（字节），供健康检查与运维观测 */
  sizeBytes(): number {
    try {
      return existsSync(this.file) ? readFileSync(this.file).length : 0;
    } catch {
      return 0;
    }
  }

  /** 待写状态（有定时器或正在写） */
  isDirty(): boolean {
    return this.timer !== null || this.writing !== null;
  }

  reset(): void {
    this.data = emptyStore();
    this.schedule();
  }
}

let store: Store | null = null;

export function getStore(dir: string): Store {
  if (!store) store = new Store(dir);
  return store;
}
