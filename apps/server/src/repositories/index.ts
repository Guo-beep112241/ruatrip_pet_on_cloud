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
import type { Store } from '../db/store.ts';

export class Repositories {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /* ---------------- user ---------------- */
  getUser(): UserProfile | null {
    return this.store.read().user;
  }
  saveUser(user: UserProfile): UserProfile {
    return this.store.update((d) => {
      d.user = user;
      return user;
    });
  }
  patchUser(patch: Partial<UserProfile>): UserProfile | null {
    return this.store.update((d) => {
      if (!d.user) return null;
      d.user = { ...d.user, ...patch };
      return d.user;
    });
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
  getActivePet(): Pet | null {
    const pets = this.store.read().pets;
    return pets.length ? (pets[pets.length - 1] ?? null) : null;
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
