/**
 * 记忆系统（说明书 6.2 记忆系统）
 *
 * 规则：
 *   - 每段对话结束提炼摘要，写入该宠物的长期记忆；
 *   - 关键事件单独标记，宠物会在后续对话中主动提起（「被记住」的关键体验）；
 *   - 记忆有容量上限，超出后按重要性淘汰，避免成本失控（可用订阅档位放宽）。
 */
import type { MemoryEntry } from '../../../../packages/shared/src/index.ts';
import type { Repositories } from '../repositories/index.ts';
import { extractKeyEvents, summarizeConversation } from './content.ts';

/** 容量上限按订阅档位放宽（说明书 十一 订阅：更长记忆） */
export const MEMORY_CAPACITY: Record<string, number> = { free: 40, plus: 120, pro: 300 };

export function capacityFor(tier: string): number {
  return MEMORY_CAPACITY[tier] ?? MEMORY_CAPACITY.free!;
}

export function rememberConversation(
  repos: Repositories,
  petId: string,
  messages: { role: string; content: string }[],
  capacity: number,
): MemoryEntry[] {
  const created: MemoryEntry[] = [];
  const summary = summarizeConversation(messages);
  if (summary) {
    created.push({
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      petId,
      kind: 'summary',
      content: summary,
      importance: 3,
      tags: ['conversation'],
      happenedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }

  const joined = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
  for (const event of extractKeyEvents(joined)) {
    created.push({
      id: `mem-key-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      petId,
      kind: 'key-event',
      content: event,
      importance: 9,
      tags: ['key-event'],
      happenedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }

  for (const entry of created) repos.addMemory(entry);
  prune(repos, petId, capacity);
  return created;
}

/** 按重要性淘汰，同重要性保留更新的 */
export function prune(repos: Repositories, petId: string, capacity: number): void {
  const all = repos.listMemories(petId);
  if (all.length <= capacity) return;
  const keep = new Set(
    [...all]
      .sort((a, b) => (b.importance - a.importance) || (b.createdAt.localeCompare(a.createdAt)))
      .slice(0, capacity)
      .map((m) => m.id),
  );
  repos.replaceMemories(petId, all.filter((m) => keep.has(m.id)));
}

/** 记录关键事件（打卡、第一次洗澡等由业务侧调用） */
export function rememberEvent(
  repos: Repositories,
  petId: string,
  content: string,
  importance = 7,
  tags: string[] = ['event'],
): MemoryEntry {
  const entry: MemoryEntry = {
    id: `mem-ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    petId,
    kind: 'key-event',
    content,
    importance,
    tags,
    happenedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  repos.addMemory(entry);
  return entry;
}

/** 主动提及：按当前场景挑一条记忆（说明书记忆层） */
export function recallFor(
  repos: Repositories,
  petId: string,
  sceneTags: string[],
): MemoryEntry | null {
  const all = repos.listMemories(petId);
  if (!all.length) return null;
  const matched = all.filter((m) => m.tags.some((t) => sceneTags.includes(t)));
  const pool = matched.length ? matched : all;
  return [...pool].sort((a, b) => (b.importance - a.importance) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
