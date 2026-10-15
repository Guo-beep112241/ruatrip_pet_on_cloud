import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Gift, Mail, MapPinned, Sparkles } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { Card, Chip, EmptyState, ProgressBar, SectionTitle, Sheet } from '../components/ui';
import { useApp } from '../store/app';
import { api, withQuery } from '../api/client';
import { goTo } from '../hooks/useHashRouter';
import type { JournalEntry, Postcard, TravelOverviewResponse, WishlistItem } from '../api/types';

type Tab = 'wishlist' | 'journal' | 'postcard';

/** 屏3：旅途 —— 心愿单、旅途手账时间轴、明信片工坊 */
export function TravelJournal() {
  const pet = useApp((s) => s.pet);
  const pushToast = useApp((s) => s.pushToast);
  const [tab, setTab] = useState<Tab>('wishlist');
  const [data, setData] = useState<TravelOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<JournalEntry | null>(null);
  const [cardDetail, setCardDetail] = useState<Postcard | null>(null);

  const load = async () => {
    if (!pet) return;
    setLoading(true);
    try {
      const result = await api.get<TravelOverviewResponse>(withQuery('/travel', { petId: pet.id }));
      setData(result);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '旅途数据加载失败', 'warning', '🗺️');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet?.id]);

  if (!pet) {
    return (
      <AppShell title="旅途" subtitle="还没有可以带出门的宠物">
        <EmptyState emoji="🧳" title="行李还没收拾" description="先孵化一只宠物，然后带它去第一个地方。" action={<button type="button" className="rt-button mt-snug" onClick={() => goTo('onboarding')}>去孵化</button>} />
      </AppShell>
    );
  }

  const makeJournal = async () => {
    try {
      const res = await api.post<{ entry: JournalEntry }>('/journal', { petId: pet.id });
      setData((prev) => (prev ? { ...prev, journals: [res.entry, ...prev.journals] } : prev));
      pushToast('新的一篇手账写好了。', 'warm', '📖');
      setTab('journal');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '手账生成失败', 'warning', '📖');
    }
  };

  const makePostcard = async (checkinId?: string) => {
    try {
      const res = await api.post<{ postcard: Postcard }>('/postcard', {
        petId: pet.id,
        ...(checkinId ? { checkinId } : {}),
        template: 'postcard-classic',
      });
      setData((prev) => (prev ? { ...prev, postcards: [res.postcard, ...prev.postcards] } : prev));
      setCardDetail(res.postcard);
      setTab('postcard');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '明信片生成失败', 'warning', '✉️');
    }
  };

  return (
    <AppShell
      title="旅途"
      subtitle="打卡是动作，不是内容。真正值钱的是「宠物陪你去过哪里、发生了什么」。"
      accessory={
        <div className="flex gap-2">
          <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => void makeJournal()}>
            <BookOpen size={14} aria-hidden />
            生成手账
          </button>
          <button type="button" className="rt-button rt-tap-target" onClick={() => goTo('checkin')}>
            <MapPinned size={14} aria-hidden />
            去打卡
          </button>
        </div>
      }
    >
      {/* 城市剧情副本进度 */}
      {data ? (
        <Card className="mb-comfortable">
          <div className="flex flex-wrap items-center justify-between gap-snug">
            <div>
              <p className="rt-label">城市剧情副本</p>
              <p className="mt-0.5 text-body font-bold text-text-primary">{data.storyProgress.title}</p>
              <p className="text-caption text-text-muted">
                {data.storyProgress.storyUnlocked
                  ? '完整旅途故事已解锁。翻到最后一章看看它写了什么。'
                  : `到访满 ${data.storyProgress.requiredCities} 个城市可解锁一段完整旅途故事。`}
              </p>
            </div>
            <Chip active>
              <Sparkles size={12} aria-hidden />
              {data.storyProgress.unlockedCities} / {data.storyProgress.requiredCities} 城市
            </Chip>
          </div>
          <div className="mt-snug">
            <ProgressBar
              value={data.storyProgress.unlockedCities}
              max={data.storyProgress.requiredCities}
              tone="chestnut"
            />
          </div>
        </Card>
      ) : null}

      {/* Tab 切换 */}
      <div className="mb-base flex gap-snug overflow-x-auto no-scrollbar">
        {(
          [
            { id: 'wishlist', label: '心愿单', emoji: '🌠' },
            { id: 'journal', label: '旅途手账', emoji: '📖' },
            { id: 'postcard', label: '明信片工坊', emoji: '✉️' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={clsx('rt-chip rt-tap-target shrink-0 px-base py-snug text-body-sm transition-transform active:scale-95', tab === t.id && 'rt-chip-active')}
          >
            <span aria-hidden>{t.emoji}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'wishlist' ? (
        <section>
          <SectionTitle title="宠物心愿单" hint="它主动提出的邀请，而不是你的单方面记录。" />
          <div className="grid gap-base sm:grid-cols-2">
            {(data?.wishlist ?? []).map((w) => (
              <WishCard key={w.id} wish={w} onGo={() => goTo('checkin')} />
            ))}
            {!data?.wishlist?.length && !loading ? (
              <EmptyState emoji="🌠" title="它还没说想去哪" description="在宠物舱多陪它几天，它就会说出想去的地方。" />
            ) : null}
          </div>
        </section>
      ) : null}

      {tab === 'journal' ? (
        <section>
          <SectionTitle title="旅途手账" hint="时间轴形式：照片 + 文案 + 宠物出镜。" />
          <div className="relative pl-6">
            <div className="absolute bottom-2 left-2 top-2 w-px bg-border-subtle" aria-hidden />
            {(data?.journals ?? []).map((entry) => (
              <div key={entry.id} className="relative mb-base">
                <span className="absolute -left-[18px] top-4 h-3 w-3 rounded-full border-2 border-surface-base bg-brand-primary" aria-hidden />
                <Card interactive onClick={() => setDetail(entry)}>
                  <div className="flex items-start justify-between gap-snug">
                    <div className="min-w-0">
                      <p className="truncate text-body font-bold text-text-primary">{entry.title}</p>
                      <p className="mt-0.5 text-caption text-text-muted">
                        {new Date(entry.createdAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {' · '}模板 {entry.template}
                      </p>
                    </div>
                    <Chip>{entry.destinationName}</Chip>
                  </div>
                  {entry.blocks.find((b) => b.type === 'photo') ? (
                    <div className="mt-snug overflow-hidden rounded-card">
                      <img
                        src={(entry.blocks.find((b) => b.type === 'photo') as { url: string }).url}
                        alt={`${pet.name}在${entry.destinationName}`}
                        className="h-40 w-full object-cover"
                      />
                    </div>
                  ) : null}
                  <p className="mt-snug line-clamp-3 text-body-sm leading-relaxed text-text-secondary">{entry.body}</p>
                  <div className="mt-snug flex flex-wrap gap-1.5">
                    {entry.tags.map((t) => (
                      <Chip key={t}>#{t}</Chip>
                    ))}
                  </div>
                </Card>
              </div>
            ))}
            {!data?.journals?.length && !loading ? (
              <EmptyState emoji="📖" title="手账还是空的" description="去打卡一次，回来就会自动生成第一篇。" action={<button type="button" className="rt-button mt-snug" onClick={() => goTo('checkin')}>去打卡</button>} />
            ) : null}
          </div>
        </section>
      ) : null}

      {tab === 'postcard' ? (
        <section>
          <SectionTitle
            title="明信片工坊"
            hint="用宠物的第一人称语气生成，天然有分享欲。"
            action={
              <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => void makePostcard()}>
                <Mail size={14} aria-hidden />
                生成一张
              </button>
            }
          />
          <div className="grid gap-base sm:grid-cols-2">
            {(data?.postcards ?? []).map((card) => (
              <Card key={card.id} interactive onClick={() => setCardDetail(card)} className="bg-surface-raised">
                <div className="flex items-center justify-between">
                  <Chip>{card.scene}</Chip>
                  <span className="text-caption text-text-muted">致 {card.to}</span>
                </div>
                <p className="mt-snug text-body leading-relaxed text-text-primary">「{card.text}」</p>
                <p className="mt-snug text-right text-body-sm italic text-text-muted">{card.signature}</p>
              </Card>
            ))}
            {!data?.postcards?.length && !loading ? (
              <EmptyState emoji="✉️" title="还没有明信片" description="打卡一次会自动附一张；也可以随时手动生成。" action={<button type="button" className="rt-button mt-snug" onClick={() => void makePostcard()}>生成一张</button>} />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 手账详情 */}
      <Sheet open={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.title ?? ''} description={`${detail?.destinationName ?? ''} · ${detail?.template ?? ''}`}>
        <div className="space-y-snug">
          {detail?.blocks.map((block, i) => {
            if (block.type === 'photo') {
              return (
                <figure key={i} className="overflow-hidden rounded-card">
                  <img src={block.url} alt={block.caption} className="w-full object-cover" />
                  <figcaption className="mt-1 text-caption text-text-muted">{block.caption}</figcaption>
                </figure>
              );
            }
            if (block.type === 'quote') {
              return (
                <blockquote key={i} className="border-l-2 border-brand-primary pl-snug text-body-sm italic text-text-secondary">
                  {block.content}
                  <footer className="mt-1 text-caption not-italic text-text-muted">— {block.author}</footer>
                </blockquote>
              );
            }
            if (block.type === 'badge') {
              return (
                <div key={i} className="flex items-center gap-2 rounded-card bg-surface-sunken/70 p-snug">
                  <span className="text-2xl" aria-hidden>{block.emoji}</span>
                  <span className="text-body-sm font-bold text-text-primary">解锁徽章：{block.label}</span>
                </div>
              );
            }
            return (
              <p key={i} className="text-body-sm leading-relaxed text-text-secondary">
                {block.content}
              </p>
            );
          })}
        </div>
        <div className="mt-base flex gap-snug">
          <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => void navigator.clipboard.writeText(detail?.body ?? '')}>
            复制文案
          </button>
          <button type="button" className="rt-button rt-tap-target" onClick={() => void makePostcard(detail?.checkinId ?? undefined)}>
            做成明信片
          </button>
        </div>
      </Sheet>

      {/* 明信片详情 */}
      <Sheet open={Boolean(cardDetail)} onClose={() => setCardDetail(null)} title="宠物视角明信片" description={`模板：${cardDetail?.template ?? ''}`}>
        <div className="rounded-card border border-border-subtle/60 bg-surface-raised p-comfortable">
          <p className="text-caption text-text-muted">致 {cardDetail?.to}</p>
          <p className="mt-snug text-body-lg leading-relaxed text-text-primary">{cardDetail?.text}</p>
          <p className="mt-base text-right text-body-sm italic text-text-muted">{cardDetail?.signature}</p>
        </div>
        <div className="mt-base flex gap-snug">
          <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => void navigator.clipboard.writeText(cardDetail?.text ?? '')}>
            复制文案
          </button>
        </div>
      </Sheet>
    </AppShell>
  );
}

function WishCard({ wish, onGo }: { wish: WishlistItem; onGo: () => void }) {
  return (
    <Card className={clsx(wish.status === 'unlocked' && 'bg-state-success/10')}>
      <div className="flex items-start justify-between gap-snug">
        <div>
          <p className="text-body font-bold text-text-primary">{wish.destinationName}</p>
          <p className="mt-0.5 text-caption text-text-muted">{wish.status === 'unlocked' ? '已解锁' : '还没去'}</p>
        </div>
        <Gift size={16} className="mt-0.5 shrink-0 text-brand-primary" aria-hidden />
      </div>
      <p className="mt-snug text-body-sm leading-relaxed text-text-secondary">「{wish.petQuote}」</p>
      <p className="mt-snug text-caption text-text-muted">解锁奖励：{wish.reward}</p>
      {wish.status === 'wishing' ? (
        <button type="button" className="rt-button-quiet rt-tap-target mt-snug w-full" onClick={onGo}>
          带它去这里
        </button>
      ) : null}
    </Card>
  );
}
