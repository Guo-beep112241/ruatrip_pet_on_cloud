import { useEffect, useState } from 'react';
import { Sparkles, Flame, Footprints, Droplets } from 'lucide-react';
import { AppShell, LevelHint } from '../components/AppShell';
import { PetStage } from '../components/PetStage';
import { InteractionDock, MoodBubble, SideDock } from '../components/InteractionDock';
import { Card, Chip, EmptyState, ProgressBar } from '../components/ui';
import { useApp } from '../store/app';
import { goTo } from '../hooks/useHashRouter';
import { api, withQuery } from '../api/client';
import type { AffectionOverviewResponse } from '../api/types';

/** 屏1：宠物舱（核心情感锚点，全屏沉浸式） */
export function PetCabin() {
  const pet = useApp((s) => s.pet);
  const interact = useApp((s) => s.interact);
  const [overview, setOverview] = useState<AffectionOverviewResponse | null>(null);

  useEffect(() => {
    if (!pet) return;
    let cancelled = false;
    void api
      .get<AffectionOverviewResponse>(withQuery('/affection', { petId: pet.id }))
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pet?.id, pet?.affection]);

  if (!pet) {
    return (
      <AppShell title="宠物舱" subtitle="还没有宠物">
        <EmptyState
          emoji="🥚"
          title="还没有属于你的毛绒搭子"
          description="用 3 分钟回答 8 个问题，它会按你的偏好被孵化出来。"
          action={
            <button type="button" className="rt-button mt-snug" onClick={() => goTo('onboarding')}>
              去孵化一只
            </button>
          }
        />
      </AppShell>
    );
  }

  const usage = overview?.remainingByAction;
  const leftOf = (action: 'feed' | 'bathe' | 'play', fallback: number) => {
    const entry = usage?.[action];
    if (!entry) return fallback;
    return Math.max(0, entry.limit - entry.used);
  };
  const feedLeft = leftOf('feed', 2);
  const batheLeft = leftOf('bathe', 1);
  const playLeft = leftOf('play', 3);

  return (
    <AppShell
      title="宠物舱"
      subtitle="它占屏幕最大的比例，待机时会呼吸、眨眼、摇尾巴。点它不同部位会有不同反应。"
      accessory={
        <div className="flex items-center gap-2">
          <Chip active>
            <Sparkles size={12} aria-hidden />
            Lv.{pet.level}
          </Chip>
          <Chip>
            <Flame size={12} aria-hidden />
            连续 {overview?.pet ? '' : ''}陪伴中
          </Chip>
        </div>
      }
    >
      <div className="grid gap-comfortable lg:grid-cols-cabin">
        {/* 左：沉浸式展示区 */}
        <div className="flex flex-col gap-base">
          <div className="rt-card overflow-hidden p-0 rt-glow">
            <PetStage className="h-[52dvh] min-h-[340px] w-full sm:h-[56dvh] lg:h-[62dvh]" />
            <div className="flex flex-wrap items-center justify-between gap-snug border-t border-border-subtle/40 bg-surface-raised/80 px-base py-snug">
              <div className="min-w-0">
                <p className="truncate text-body-lg font-bold text-text-primary">
                  {pet.name}
                  <span className="ml-2 text-caption font-normal text-text-muted">
                    {pet.personality.species} · {pet.quirks.join(' / ')}
                  </span>
                </p>
                <p className="mt-0.5 text-caption text-text-muted">
                  口头禅：「{pet.personality.catchphrases[0] ?? '嗯……'}」
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Chip>{pet.stage === 'young' ? '幼年' : pet.stage === 'adult' ? '成年' : '孵化中'}</Chip>
                <Chip>想念值 {pet.longing}</Chip>
              </div>
            </div>
          </div>

          <MoodBubble />
        </div>

        {/* 右：操作与状态 */}
        <div className="flex flex-col gap-base">
          <InteractionDock />

          <Card>
            <p className="rt-label">今日互动余额</p>
            <div className="mt-snug grid grid-cols-3 gap-snug text-center">
              <div className="rounded-tight bg-surface-sunken/70 py-snug">
                <p className="text-title font-bold text-text-primary">{feedLeft}</p>
                <p className="text-caption-sm text-text-muted">喂饭剩余</p>
              </div>
              <div className="rounded-tight bg-surface-sunken/70 py-snug">
                <p className="text-title font-bold text-text-primary">{batheLeft}</p>
                <p className="text-caption-sm text-text-muted">洗澡剩余</p>
              </div>
              <div className="rounded-tight bg-surface-sunken/70 py-snug">
                <p className="text-title font-bold text-text-primary">{playLeft}</p>
                <p className="text-caption-sm text-text-muted">陪玩剩余</p>
              </div>
            </div>
            <div className="mt-snug">
              <ProgressBar
                value={overview?.todayGain ?? 0}
                max={overview?.dailyCap ?? 120}
                tone="chestnut"
                label={`今日好感度 ${overview?.todayGain ?? 0} / ${overview?.dailyCap ?? 120}`}
              />
              <p className="mt-1 text-caption-sm text-text-muted">
                单日收益有上限，超出部分会衰减——这是防刷设计，也是「关系而非进度条」的锚点。
              </p>
            </div>
            <div className="mt-snug">
              <LevelHint />
              {overview?.nextStreakMilestone ? (
                <p className="mt-1 flex items-center gap-1 text-caption text-text-muted">
                  <Flame size={12} aria-hidden />
                  连续陪伴第 {overview.nextStreakMilestone.day} 天有额外奖励
                </p>
              ) : null}
            </div>
          </Card>

          <SideDock />

          <Card>
            <p className="rt-label">最近发生的事</p>
            <ul className="mt-snug space-y-1.5">
              {(overview?.recent ?? []).slice(0, 5).map((log) => (
                <li key={log.id} className="flex items-center justify-between gap-snug text-body-sm">
                  <span className="truncate text-text-secondary">{log.note ?? actionLabel(log.action)}</span>
                  <span className="shrink-0 font-medium text-brand-primary">
                    {log.gain >= 0 ? `+${log.gain}` : log.gain}
                  </span>
                </li>
              ))}
              {!overview?.recent?.length ? (
                <li className="text-body-sm text-text-muted">还没有记录。今天先从喂一顿饭开始吧。</li>
              ) : null}
            </ul>
            <div className="mt-snug flex flex-wrap gap-2">
              <button
                type="button"
                className="rt-button-quiet rt-tap-target"
                onClick={() => void interact('feed')}
              >
                <Droplets size={14} aria-hidden />
                快速喂一顿
              </button>
              <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => goTo('checkin')}>
                <Footprints size={14} aria-hidden />
                带它出门
              </button>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    feed: '喂饭',
    bathe: '洗澡',
    play: '陪玩',
    chat: '真心话对话',
    checkin: '旅行打卡',
    streak: '连续陪伴',
    reunion: '重逢',
  };
  return map[action] ?? action;
}
