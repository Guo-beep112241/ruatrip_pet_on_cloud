/**
 * Repository 层：把 Store 的读写包装成语义化方法。
 * 上层 service 只依赖这些方法，因此换数据库时只需重写本文件。
 */
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
import type { AccountRecord } from '../auth/index.ts';
import { sumSpendThisMonth, type SpendEntry } from '../services/billing.ts';
import { createDefaultProfile } from '../auth/index.ts';
import type { Store } from '../db/store.ts';

export class Repositories {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /* ---------------- accounts（多用户） ---------------- */

  /**
   * 一次性迁移：把旧版的单例 `user` 变成 users 集合里的第一个账号。
   *
   * 为什么要迁移而不是直接丢弃：老用户的宠物数据里存着 ownerId = 'user-local'，
   * 如果直接丢掉 user 记录，那些宠物就永远没有归属者，等于全部失联。
   * 迁移后给这个账号分配一个真实 id，并把相关数据的 ownerId 一起改写。
   */
  migrateLegacyUser(): { migrated: boolean; userId?: string } {
    const legacy = this.store.read().user;
    if (!legacy) return { migrated: false };
    if (this.store.read().users.length > 0) {
      // 已经有账号了，旧字段只是残留，清掉即可
      this.store.update((d) => {
        d.user = null;
        return true;
      });
      return { migrated: false };
    }

    const legacyId = legacy.id || 'user-local';
    const account: AccountRecord = {
      id: legacyId,
      // 旧数据没有邮箱；用一个不会被登录命中的占位值，
      // 用户首次登录时通过「认领」流程设置真实邮箱与密码（见 auth routes）
      email: `${legacyId}@legacy.local`,
      passwordHash: '',
      passwordVersion: 0,
      profile: { ...legacy, id: legacyId },
      createdAt: legacy.createdAt ?? new Date().toISOString(),
      lastLoginAt: null,
    };
    this.store.update((d) => {
      d.users.push(account);
      d.user = null;
      return account;
    });
    return { migrated: true, userId: legacyId };
  }

  /** 按 id 取账号（含凭据，仅供服务端使用） */
  getAccount(userId: string): AccountRecord | null {
    return this.store.read().users.find((u) => u.id === userId) ?? null;
  }

  /** 按邮箱取账号（登录用）；大小写不敏感 */
  getAccountByEmail(email: string): AccountRecord | null {
    const target = email.trim().toLowerCase();
    return this.store.read().users.find((u) => u.email.toLowerCase() === target) ?? null;
  }

  listAccounts(): AccountRecord[] {
    return this.store.read().users;
  }

  /** 创建账号 */
  createAccount(input: {
    id: string;
    email: string;
    passwordHash: string;
    nickname?: string;
  }): AccountRecord {
    const account: AccountRecord = {
      id: input.id,
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      passwordVersion: 0,
      profile: createDefaultProfile({ id: input.id, ...(input.nickname ? { nickname: input.nickname } : {}) }),
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    return this.store.update((d) => {
      d.users.push(account);
      return account;
    });
  }

  /** 更新账号（凭据或档案） */
  patchAccount(userId: string, patch: Partial<Omit<AccountRecord, 'id'>>): AccountRecord | null {
    return this.store.update((d) => {
      const idx = d.users.findIndex((u) => u.id === userId);
      if (idx < 0) return null;
      const next = { ...(d.users[idx] as AccountRecord), ...patch };
      d.users[idx] = next;
      return next;
    });
  }

  /**
   * 更新账号档案。
   * 只覆盖 UserProfile 内的字段，防止把凭据字段（passwordHash 等）透传进来。
   */
  patchProfile(userId: string, patch: Partial<UserProfile>): UserProfile | null {
    return this.store.update((d) => {
      const idx = d.users.findIndex((u) => u.id === userId);
      if (idx < 0) return null;
      const account = d.users[idx] as AccountRecord;
      const next: AccountRecord = { ...account, profile: { ...account.profile, ...patch, id: account.id } };
      d.users[idx] = next;
      return next.profile;
    });
  }

  /** 记录登录时间 */
  touchLogin(userId: string): void {
    this.patchAccount(userId, { lastLoginAt: new Date().toISOString() });
  }

  /** 改密码：更新哈希并让旧 token 失效（pwv + 1） */
  setPassword(userId: string, passwordHash: string): boolean {
    return this.store.update((d) => {
      const idx = d.users.findIndex((u) => u.id === userId);
      if (idx < 0) return false;
      const account = d.users[idx] as AccountRecord;
      d.users[idx] = {
        ...account,
        passwordHash,
        passwordVersion: account.passwordVersion + 1,
      };
      return true;
    });
  }

  /** 注销账号：删除账号及其全部数据 */
  deleteAccount(userId: string): { removedPets: number } {
    return this.store.update((d) => {
      const petIds = new Set(d.pets.filter((p) => p.ownerId === userId).map((p) => p.id));
      const removedPets = petIds.size;

      d.users = d.users.filter((u) => u.id !== userId);
      d.pets = d.pets.filter((p) => p.ownerId !== userId);
      d.generationJobs = d.generationJobs.filter((j) => !petIds.has(j.petId));
      d.interactions = d.interactions.filter((i) => !petIds.has(i.petId));
      d.conversations = d.conversations.filter((c) => c.userId !== userId && !petIds.has(c.petId));
      d.messages = d.messages.filter((m) => !petIds.has(m.petId));
      d.memories = d.memories.filter((m) => !petIds.has(m.petId));
      d.checkins = d.checkins.filter((c) => c.userId !== userId && !petIds.has(c.petId));
      d.wishlist = d.wishlist.filter((w) => !petIds.has(w.petId));
      d.badges = d.badges.filter((b) => b.petId !== undefined && !petIds.has(b.petId));
      d.journals = d.journals.filter((j) => !petIds.has(j.petId));
      d.postcards = d.postcards.filter((p) => !petIds.has(p.petId));
      d.capsules = d.capsules.filter((c) => c.userId !== userId);
      d.fosters = d.fosters.filter((f) => f.ownerId !== userId && !petIds.has(f.petId));
      // 消费台账也要清理（隐私与对账口径一致）
      d.spendLedger = d.spendLedger.filter((e) => e.userId !== userId);
      return { removedPets };
    });
  }

  /* ---------------- 消费台账（审计 F6） ---------------- */

  addSpend(entry: SpendEntry): SpendEntry {
    return this.store.update((d) => {
      d.spendLedger.push(entry);
      return entry;
    });
  }

  /** 某用户本月已消费金额 */
  spentThisMonth(userId: string): number {
    return sumSpendThisMonth(this.store.read().spendLedger, userId);
  }

  listSpend(userId: string, limit = 50): SpendEntry[] {
    return this.store
      .read()
      .spendLedger.filter((e) => e.userId === userId)
      .slice(-limit)
      .reverse();
  }

  /* ---------------- 归属校验 ---------------- */

  /**
   * 这套方法的意义：把「这个资源属于这个用户吗」变成一次显式调用。
   *
   * 没有它们之前，任何拿到 petId 的人都能读写别人的宠物
   * （requirePet 只检查「宠物存在」，不检查「是不是你的」）。
   */
  ownsPet(userId: string, petId: string): boolean {
    const pet = this.store.read().pets.find((p) => p.id === petId);
    return Boolean(pet && pet.ownerId === userId);
  }

  ownsConversation(userId: string, conversationId: string): boolean {
    const conv = this.store.read().conversations.find((c) => c.id === conversationId);
    return Boolean(conv && conv.userId === userId);
  }

  ownsCheckin(userId: string, checkinId: string): boolean {
    const checkin = this.store.read().checkins.find((c) => c.id === checkinId);
    return Boolean(checkin && checkin.userId === userId);
  }

  ownsCapsule(userId: string, capsuleId: string): boolean {
    const capsule = this.store.read().capsules.find((c) => c.id === capsuleId);
    return Boolean(capsule && capsule.userId === userId);
  }

  ownsFoster(userId: string, fosterId: string): boolean {
    const foster = this.store.read().fosters.find((f) => f.id === fosterId);
    return Boolean(foster && foster.ownerId === userId);
  }

  /* ---------------- survey ---------------- */
  getAnswers(): PreferenceAnswers | null {
    return this.store.read().surveyAnswers;
  }
  saveAnswers(answers: PreferenceAnswers): PreferenceAnswers {
    return this.store.update((d) => {
      d.surveyAnswers = answers;
      return answers;
    });
  }

  /* ---------------- pets ---------------- */
  listPets(): Pet[] {
    return this.store.read().pets;
  }
  getPet(id: string): Pet | null {
    return this.store.read().pets.find((p) => p.id === id) ?? null;
  }
  /**
   * 取某用户的当前宠物。
   * 必须按 ownerId 过滤：否则多用户场景下会取到别人的宠物。
   */
  getActivePet(userId?: string): Pet | null {
    const all = this.store.read().pets;
    const pets = userId ? all.filter((p) => p.ownerId === userId) : all;
    return pets.length ? (pets[pets.length - 1] ?? null) : null;
  }

  listPetsByOwner(userId: string): Pet[] {
    return this.store.read().pets.filter((p) => p.ownerId === userId);
  }
  savePet(pet: Pet): Pet {
    return this.store.update((d) => {
      const idx = d.pets.findIndex((p) => p.id === pet.id);
      if (idx >= 0) d.pets[idx] = pet;
      else d.pets.push(pet);
      return pet;
    });
  }

  /* ---------------- generation jobs ---------------- */
  saveJob(job: GenerationJob): GenerationJob {
    return this.store.update((d) => {
      const idx = d.generationJobs.findIndex((j) => j.id === job.id);
      if (idx >= 0) d.generationJobs[idx] = job;
      else d.generationJobs.push(job);
      return job;
    });
  }
  getJob(id: string): GenerationJob | null {
    return this.store.read().generationJobs.find((j) => j.id === id) ?? null;
  }
  getJobByPet(petId: string): GenerationJob | null {
    const jobs = this.store.read().generationJobs.filter((j) => j.petId === petId);
    return jobs.length ? (jobs[jobs.length - 1] ?? null) : null;
  }

  /* ---------------- affection logs ---------------- */
  addInteraction(entry: AffectionLogEntry): AffectionLogEntry {
    return this.store.update((d) => {
      d.interactions.push(entry);
      return entry;
    });
  }
  listInteractions(petId: string, limit = 50): AffectionLogEntry[] {
    return this.store
      .read()
      .interactions.filter((i) => i.petId === petId)
      .slice(-limit)
      .reverse();
  }
  interactionsSince(petId: string, sinceIso: string): AffectionLogEntry[] {
    return this.store
      .read()
      .interactions.filter((i) => i.petId === petId && i.createdAt >= sinceIso);
  }
  lastInteractionAt(petId: string, action: string): string | null {
    const hits = this.store
      .read()
      .interactions.filter((i) => i.petId === petId && i.action === action);
    return hits.length ? (hits[hits.length - 1]?.createdAt ?? null) : null;
  }

  /* ---------------- conversations ---------------- */
  listConversations(petId: string): Conversation[] {
    return this.store.read().conversations.filter((c) => c.petId === petId);
  }
  getConversation(id: string): Conversation | null {
    return this.store.read().conversations.find((c) => c.id === id) ?? null;
  }
  saveConversation(conv: Conversation): Conversation {
    return this.store.update((d) => {
      const idx = d.conversations.findIndex((c) => c.id === conv.id);
      if (idx >= 0) d.conversations[idx] = conv;
      else d.conversations.push(conv);
      return conv;
    });
  }
  listMessages(conversationId: string): ChatMessage[] {
    return this.store.read().messages.filter((m) => m.conversationId === conversationId);
  }
  addMessage(msg: ChatMessage): ChatMessage {
    return this.store.update((d) => {
      d.messages.push(msg);
      // 单会话消息上限，避免本地文件无限膨胀
      const mine = d.messages.filter((m) => m.conversationId === msg.conversationId);
      if (mine.length > 400) {
        const drop = new Set(mine.slice(0, mine.length - 400).map((m) => m.id));
        d.messages = d.messages.filter((m) => !drop.has(m.id));
      }
      return msg;
    });
  }

  /* ---------------- memories ---------------- */
  listMemories(petId: string): MemoryEntry[] {
    return this.store
      .read()
      .memories.filter((m) => m.petId === petId)
      .sort((a, b) => b.importance - a.importance);
  }
  addMemory(entry: MemoryEntry): MemoryEntry {
    return this.store.update((d) => {
      d.memories.push(entry);
      return entry;
    });
  }
  replaceMemories(petId: string, entries: MemoryEntry[]): void {
    this.store.update((d) => {
      d.memories = d.memories.filter((m) => m.petId !== petId).concat(entries);
      return entries;
    });
  }

  /* ---------------- travel ---------------- */
  listCheckins(petId: string): Checkin[] {
    return this.store.read().checkins.filter((c) => c.petId === petId);
  }
  addCheckin(checkin: Checkin): Checkin {
    return this.store.update((d) => {
      d.checkins.push(checkin);
      return checkin;
    });
  }
  listWishlist(petId: string): WishlistItem[] {
    return this.store.read().wishlist.filter((w) => w.petId === petId);
  }
  addWishlist(item: WishlistItem): WishlistItem {
    return this.store.update((d) => {
      d.wishlist.push(item);
      return item;
    });
  }
  updateWishlist(id: string, patch: Partial<WishlistItem>): WishlistItem | null {
    return this.store.update((d) => {
      const idx = d.wishlist.findIndex((w) => w.id === id);
      if (idx < 0) return null;
      const next = { ...(d.wishlist[idx] as WishlistItem), ...patch };
      d.wishlist[idx] = next;
      return next;
    });
  }
  listBadges(petId: string): Badge[] {
    return this.store.read().badges.filter((b) => b.petId === petId);
  }
  saveBadge(badge: Badge): Badge {
    return this.store.update((d) => {
      const idx = d.badges.findIndex((b) => b.id === badge.id);
      if (idx >= 0) d.badges[idx] = badge;
      else d.badges.push(badge);
      return badge;
    });
  }

  /* ---------------- journal & postcards ---------------- */
  listJournals(petId: string): JournalEntry[] {
    return this.store.read().journals.filter((j) => j.petId === petId);
  }
  getJournal(id: string): JournalEntry | null {
    return this.store.read().journals.find((j) => j.id === id) ?? null;
  }
  addJournal(entry: JournalEntry): JournalEntry {
    return this.store.update((d) => {
      d.journals.push(entry);
      return entry;
    });
  }
  listPostcards(petId: string): Postcard[] {
    return this.store.read().postcards.filter((p) => p.petId === petId);
  }
  addPostcard(card: Postcard): Postcard {
    return this.store.update((d) => {
      d.postcards.push(card);
      return card;
    });
  }

  /* ---------------- capsule ---------------- */
  listCapsules(userId: string): CapsuleProject[] {
    return this.store.read().capsules.filter((c) => c.userId === userId);
  }
  getCapsule(id: string): CapsuleProject | null {
    return this.store.read().capsules.find((c) => c.id === id) ?? null;
  }
  saveCapsule(project: CapsuleProject): CapsuleProject {
    return this.store.update((d) => {
      const idx = d.capsules.findIndex((c) => c.id === project.id);
      if (idx >= 0) d.capsules[idx] = project;
      else d.capsules.push(project);
      return project;
    });
  }

  /* ---------------- foster ---------------- */
  listFosters(petId: string): FosterRequest[] {
    return this.store.read().fosters.filter((f) => f.petId === petId);
  }
  saveFoster(req: FosterRequest): FosterRequest {
    return this.store.update((d) => {
      const idx = d.fosters.findIndex((f) => f.id === req.id);
      if (idx >= 0) d.fosters[idx] = req;
      else d.fosters.push(req);
      return req;
    });
  }

  /* ---------------- meta ---------------- */
  getMeta<T extends string | number | boolean>(key: string, fallback: T): T {
    const value = this.store.read().meta[key];
    return (value === undefined ? fallback : value) as T;
  }
  setMeta(key: string, value: string | number | boolean): void {
    this.store.update((d) => {
      d.meta[key] = value;
      return value;
    });
  }
}
