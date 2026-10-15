import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  Footprints,
  Heart,
  MapPin,
  MessageCircleHeart,
  UserRound,
  Archive,
  PawPrint,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useApp, type Screen } from '../store/app';
import { greetingByHour, useIsDesktop } from '../hooks/useMediaQuery';
import { PetStage } from './PetStage';
import { ProgressBar } from './ui';
import { levelFromAffection } from '../api/types';

const NAV_ITEMS: { screen: Screen; label: string; icon: typeof Heart }[] = [
  { screen: 'cabin', label: '宠物舱', icon: PawPrint },
  { screen: 'hut', label: '小屋', icon: MessageCircleHeart },
  { screen: 'travel', label: '旅途', icon: Footprints },
  { screen: 'checkin', label: '打卡', icon: MapPin },
  { screen: 'profile', label: '我的', icon: UserRound },
];

/** 底部悬浮胶囊（移动端）/ 左侧导航（桌面端） */
export function BottomPill() {
  const screen = useApp((s) => s.screen);
  const navigate = useApp((s) => s.navigate);
  const capsule = useApp((s) => s.navigate);

  return (
    <nav
      className="fixed bottom-comfortable left-1/2 z-40 -translate-x-1/2 md:hidden"
      aria-label="主导航"
    >
      <div className="flex items-center gap-1 rounded-pill border border-border-subtle/50 bg-surface-raised/92 p-tight shadow-plush-hover backdrop-blur-xl">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = screen === item.screen;
          return (
            <button
              key={item.screen}
              type="button"
              onClick={() => navigate(item.screen)}
              className={clsx(
                'rt-tap-target flex flex-col items-center gap-0.5 rounded-pill px-2.5 py-1.5 transition-all duration-300 ease-spring',
                active
                  ? 'bg-surface-sunken font-bold text-brand-secondary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={19} strokeWidth={active ? 2.4 : 2} aria-hidden />
              <span className="text-caption-sm leading-none">{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => capsule('capsule')}
          className={clsx(
            'rt-tap-target flex flex-col items-center gap-0.5 rounded-pill px-2.5 py-1.5 transition-all duration-300 ease-spring',
            screen === 'capsule' ? 'bg-surface-sunken font-bold text-brand-secondary shadow-sm' : 'text-text-muted',
          )}
          aria-label="时光胶囊"
        >
          <Archive size={19} strokeWidth={2} aria-hidden />
          <span className="text-caption-sm leading-none">胶囊</span>
        </button>
      </div>
    </nav>
  );
}

function IntegrationBadge() {
  const integration = useApp((s) => s.integration);
  const live = integration.filter(
    (i) => i.configured && !['mock', 'local-svg-composer', 'browser-web-speech', 'universal-skeleton'].includes(i.provider),
  );
  const mock = live.length === 0;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill px-snug py-1 text-caption font-medium',
        mock ? 'bg-surface-sunken text-text-muted' : 'bg-state-success/18 text-state-success',
      )}
      title={mock ? '全部能力运行在 Mock 模式，功能完整可用' : `已接入 ${live.length} 个真实通道`}
    >
      {mock ? <WifiOff size={12} aria-hidden /> : <Wifi size={12} aria-hidden />}
      {mock ? 'Mock 模式' : `${live.length} 个真实通道`}
    </span>
  );
}

/** 桌面端左侧栏（同一份信息，换一种排布） */
function DesktopSidebar() {
  const screen = useApp((s) => s.screen);
  const navigate = useApp((s) => s.navigate);
  const pet = useApp((s) => s.pet);
  const user = useApp((s) => s.user);

  return (
    <aside className="hidden w-[248px] shrink-0 flex-col gap-base border-r border-border-subtle/50 bg-surface-raised/60 p-comfortable backdrop-blur-md md:flex">
      <div className="flex items-center gap-2">
        <span className="text-2xl" aria-hidden>
          🐾
        </span>
        <div>
          <p className="text-body-lg font-bold tracking-tight text-text-primary">RuaTrip</p>
          <p className="text-caption text-text-muted">Rua 途 · 毛绒搭子</p>
        </div>
      </div>

      <nav className="mt-snug flex flex-col gap-1" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = screen === item.screen;
          return (
            <button
              key={item.screen}
              type="button"
              onClick={() => navigate(item.screen)}
              className={clsx(
                'flex items-center gap-3 rounded-card px-base py-snug text-left text-body-sm transition-all duration-300 ease-spring',
                active
                  ? 'bg-surface-sunken font-bold text-brand-secondary shadow-sm'
                  : 'text-text-secondary hover:bg-surface-sunken/70',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={18} aria-hidden />
              {item.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => navigate('capsule')}
          className={clsx(
            'flex items-center gap-3 rounded-card px-base py-snug text-left text-body-sm transition-all duration-300 ease-spring',
            screen === 'capsule'
              ? 'bg-surface-sunken font-bold text-brand-secondary shadow-sm'
              : 'text-text-secondary hover:bg-surface-sunken/70',
          )}
        >
          <Archive size={18} aria-hidden />
          时光胶囊
        </button>
      </nav>

      {pet ? (
        <div className="mt-auto rounded-card bg-surface-sunken/70 p-base">
          <p className="rt-label">当前宠物</p>
          <p className="mt-1 text-body font-bold text-text-primary">
            {pet.name} <span className="text-caption font-normal text-text-muted">{pet.personality.species}</span>
          </p>
          <div className="mt-snug">
            <ProgressBar
              value={pet.levelProgress * 100}
              label={`Lv.${pet.level} · 好感度 ${pet.affection}`}
            />
          </div>
          <p className="mt-snug text-caption text-text-muted">
            想念值 {pet.longing}/100 · 连续陪伴 {user?.streakDays ?? 1} 天
          </p>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <IntegrationBadge />
        <button
          type="button"
          onClick={() => navigate('profile')}
          className="rounded-pill px-snug py-1 text-caption text-text-muted transition-colors hover:bg-surface-sunken"
        >
          能力接入
        </button>
      </div>
    </aside>
  );
}

function MobileTopBar() {
  const user = useApp((s) => s.user);
  const pet = useApp((s) => s.pet);
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-snug border-b border-border-subtle/40 bg-surface-base/85 px-base py-snug backdrop-blur-xl md:hidden">
      <div className="flex items-center gap-2">
        <span className="text-xl" aria-hidden>
          🐾
        </span>
        <div className="leading-tight">
          <p className="text-body-sm font-bold text-text-primary">
            {pet ? pet.name : 'RuaTrip'}
          </p>
          <p className="text-caption-sm text-text-muted">
            {greetingByHour()}，{user?.nickname ?? '主人'}
          </p>
        </div>
      </div>
      <IntegrationBadge />
    </header>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[60] flex w-[min(92vw,420px)] -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={clsx(
            'pointer-events-auto animate-drop-in rounded-card px-base py-snug text-left text-body-sm shadow-plush-hover backdrop-blur-md',
            t.tone === 'warning'
              ? 'bg-state-warning/92 text-text-primary'
              : t.tone === 'plain'
                ? 'bg-surface-raised/95 text-text-secondary'
                : 'bg-brand-primary/92 text-text-inverse',
          )}
        >
          {t.emoji ? <span className="mr-1.5">{t.emoji}</span> : null}
          {t.text}
        </button>
      ))}
    </div>
  );
}

export function AppShell({
  children,
  title,
  subtitle,
  accessory,
  atmosphere = 1,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  accessory?: ReactNode;
  atmosphere?: 1 | 2 | 3;
}) {
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
  const bootstrap = useApp((s) => s.bootstrap);
  const pet = useApp((s) => s.pet);
  const isDesktop = useIsDesktop();

  const spaceClass = atmosphere === 3 ? 'rt-space-capsule' : atmosphere === 2 ? 'rt-space-hut' : 'rt-space-cabin';

  return (
    <div className={clsx('flex min-h-[100dvh] w-full', spaceClass)}>
      <DesktopSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar />

        <div className="flex min-w-0 flex-1 gap-comfortable px-base pb-28 pt-base md:px-comfortable md:pb-comfortable">
          {isDesktop && pet ? (
            <div className="hidden w-[300px] shrink-0 flex-col gap-base xl:flex">
              <div className="rt-card overflow-hidden p-0">
                <PetStage className="h-[320px] w-full" compact />
                <div className="p-base">
                  <p className="text-body font-bold text-text-primary">{pet.name}</p>
                  <p className="text-caption text-text-muted">
                    {pet.personality.species} · {pet.personality.traits.join(' / ')}
                  </p>
                  <div className="mt-snug">
                    <ProgressBar value={pet.levelProgress * 100} label={`Lv.${pet.level}（${pet.affection} 好感度）`} />
                  </div>
                </div>
              </div>
              <div className="rt-card p-base">
                <p className="rt-label">它的记忆锚点</p>
                <ul className="mt-2 space-y-1.5 text-caption text-text-secondary">
                  {pet.personality.memoryAnchors.length ? (
                    pet.personality.memoryAnchors.map((m) => <li key={m}>· {m}</li>)
                  ) : (
                    <li>· 还没有共同记忆，从今天开始积累。</li>
                  )}
                </ul>
              </div>
            </div>
          ) : null}

          <main className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-content">
              <div className="mb-comfortable hidden items-end justify-between gap-base md:flex">
                <div>
                  <h1 className="text-title-lg font-bold tracking-tight text-text-primary">{title}</h1>
                  {subtitle ? <p className="mt-1 max-w-prose text-body-sm text-text-muted">{subtitle}</p> : null}
                </div>
                {accessory}
              </div>

              {!ready ? (
                <div className="flex min-h-[40dvh] items-center justify-center text-body-sm text-text-muted">
                  正在把毛绒玩具摆好……
                </div>
              ) : error ? (
                <div className="rt-card p-comfortable text-center">
                  <p className="text-body-lg font-bold text-text-primary">连不上服务端</p>
                  <p className="mt-2 text-body-sm text-text-muted">{error}</p>
                  <p className="mt-2 text-caption text-text-muted">
                    请确认后端已启动：<code className="rounded bg-surface-sunken px-1">npm run dev:server</code>
                  </p>
                  <button type="button" className="rt-button mt-base" onClick={() => void bootstrap()}>
                    重试
                  </button>
                </div>
              ) : (
                children
              )}
            </div>
          </main>
        </div>

        {/* 移动端底部留白，避开悬浮胶囊 */}
        <div className="h-24 md:hidden" aria-hidden />
      </div>

      <BottomPill />
      <Toasts />
    </div>
  );
}

export function LevelHint() {
  const pet = useApp((s) => s.pet);
  if (!pet) return null;
  const { nextLevelAt, currentLevelFloor } = levelFromAffection(pet.affection);
  return (
    <p className="text-caption text-text-muted">
      距离 Lv.{pet.level + 1} 还差 {Math.max(0, nextLevelAt - pet.affection)} 点好感度
      <span className="mx-1">·</span>
      本等级从 {currentLevelFloor} 起算
    </p>
  );
}
