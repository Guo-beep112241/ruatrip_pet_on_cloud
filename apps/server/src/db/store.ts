/**
 * 轻量 JSON 存储层。
 *
 * 设计说明：这是「数据层」的默认实现，目的是让项目零依赖即可完整运行。
 * 说明书第十章的数据层要求（宠物资产元数据 / 互动日志 / 记忆库 / 行为埋点）
 * 都在 Store 里有对应集合。生产环境把这一层替换为 Postgres/Supabase 即可，
 * 上层 repository 与 service 的调用签名保持不变（见 docs/ARCHITECTURE.md）。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
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

export class Store {
  private data: StoreSchema = emptyStore();
  private readonly file: string;
  private dirty = false;

  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'ruatrip.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.data = emptyStore();
      this.flush();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreSchema>;
      this.data = { ...emptyStore(), ...parsed };
    } catch {
      // 数据损坏时保留坏档，重建空档，避免整个服务起不来
      renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      this.data = emptyStore();
      this.flush();
    }
  }

  /** 原子写入：先写临时文件再 rename */
  flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  read(): StoreSchema {
    return this.data;
  }

  update<T>(mutator: (data: StoreSchema) => T): T {
    const result = mutator(this.data);
    this.dirty = true;
    this.flush();
    return result;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  reset(): void {
    this.data = emptyStore();
    this.flush();
  }
}

let store: Store | null = null;

export function getStore(dir: string): Store {
  if (!store) store = new Store(dir);
  return store;
}
