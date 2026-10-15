import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Camera, Compass, Gift, Locate, MapPin, Sparkles } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { Button, Card, Chip, EmptyState, SectionTitle, Sheet } from '../components/ui';
import { useApp } from '../store/app';
import { api, withQuery } from '../api/client';
import type { CheckinResponse, Destination, TravelOverviewResponse } from '../api/types';
import { DESTINATIONS } from '../api/types';

/** 屏4：打卡探索 —— 地图 + 打卡 + 徽章墙 */
export function CheckinMap() {
  const pet = useApp((s) => s.pet);
  const pushToast = useApp((s) => s.pushToast);
  const [data, setData] = useState<TravelOverviewResponse | null>(null);
  const [selected, setSelected] = useState<Destination | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CheckinResponse | null>(null);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    if (!pet) return;
    try {
      const result = await api.get<TravelOverviewResponse>(withQuery('/travel', { petId: pet.id }));
      setData(result);
    } catch {
      /* 静默：页面顶部已有全局错误态 */
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet?.id]);

  if (!pet) {
    return (
      <AppShell title="打卡探索" subtitle="还没有可以带出门的宠物">
        <EmptyState emoji="🧭" title="指南针还没指向任何地方" description="先孵化一只宠物，再带它去打卡。" />
      </AppShell>
    );
  }

  const visitedIds = new Set((data?.checkins ?? []).map((c) => c.destinationId));
  const badges = data?.badges ?? [];
  const unlocked = badges.filter((b) => b.unlocked).length;

  const locate = () => {
    if (!('geolocation' in navigator)) {
      pushToast('这个浏览器不支持定位，可以手动选择目的地。', 'plain', '📍');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        pushToast(`已定位：${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)}`, 'plain', '📍');
      },
      () => pushToast('定位失败或被拒绝，可以手动选择目的地。', 'plain', '📍'),
      { timeout: 6000 },
    );
  };

  const onPickPhoto = (file: File) => {
    if (file.size > 6 * 1024 * 1024) {
      pushToast('照片超过 6MB，先压缩一下再上传。', 'warning', '🖼️');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result));
    reader.readAsDataURL(file);
  };

  const doCheckin = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await api.post<CheckinResponse>('/travel/checkin', {
        petId: pet.id,
        destinationId: selected.id,
        photoUrl: photo,
        ...(geo ?? {}),
      });
      setOutcome(res);
      useApp.setState({ pet: res.pet });
      setSelected(null);
      setPhoto(null);
      await load();
      if (res.gain > 0) pushToast(`好感度 +${res.gain}`, 'warm', '📍');
      if (res.blindBox) pushToast(`旅行盲盒：${res.blindBox.emoji} ${res.blindBox.name}`, 'warm', '🎁');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '打卡失败', 'warning', '📍');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell
      title="打卡探索"
      subtitle="到达景点后打卡，宠物会出镜合成、解封剧情章节、带回一枚盲盒纪念品。"
      accessory={
        <div className="flex gap-2">
          <button type="button" className="rt-button-quiet rt-tap-target" onClick={locate}>
            <Locate size={14} aria-hidden />
            定位到当前位置
          </button>
        </div>
      }
    >
      <div className="grid gap-comfortable lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        {/* 地图区 */}
        <div className="flex flex-col gap-base">
          <Card padded={false} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border-subtle/40 px-base py-snug">
              <div>
                <p className="rt-label">打卡地图</p>
                <p className="text-caption text-text-muted">
                  {geo ? `当前坐标 ${geo.lat.toFixed(2)}, ${geo.lng.toFixed(2)}` : '未开启定位，可直接选择目的地'}
                </p>
              </div>
              <Chip active>
                <Compass size={12} aria-hidden />
                已解锁 {unlocked} / {DESTINATIONS.length}
              </Chip>
            </div>

            <div className="relative aspect-[4/3] w-full bg-surface-sunken">
              <MapCanvas
                destinations={DESTINATIONS}
                visitedIds={visitedIds}
                selectedId={selected?.id ?? null}
                onSelect={(d) => setSelected(d)}
                userPoint={geo}
              />
            </div>
          </Card>

          {/* 横滑徽章墙 */}
          <div>
            <SectionTitle title="足迹徽章" hint="到访即解锁；攒够 3 个城市解锁一段完整旅途故事。" />
            <div className="flex gap-snug overflow-x-auto no-scrollbar pb-1">
              {badges.map((b) => (
                <div
                  key={b.id}
                  className={clsx(
                    'rt-card flex h-[112px] w-[104px] shrink-0 flex-col items-center justify-center gap-1 p-snug text-center',
                    !b.unlocked && 'opacity-45 grayscale',
                  )}
                >
                  <span className="text-3xl" aria-hidden>
                    {b.emoji}
                  </span>
                  <span className="text-caption font-medium text-text-primary">{b.name}</span>
                  <span className="text-caption-sm text-text-muted">{b.unlocked ? '已解锁' : '未解锁'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 打卡详情区 */}
        <div className="flex flex-col gap-base">
          {selected ? (
            <Card>
              <div className="flex items-start justify-between gap-snug">
                <div>
                  <p className="rt-label">准备打卡</p>
                  <h3 className="mt-0.5 text-body-lg font-bold text-text-primary">
                    {selected.emoji} {selected.name}
                    <span className="ml-2 text-caption font-normal text-text-muted">
                      {selected.country} · {selected.region}
                    </span>
                  </h3>
                </div>
                {visitedIds.has(selected.id) ? <Chip active>再次到访</Chip> : <Chip>首次到访</Chip>}
              </div>

              <p className="mt-snug text-body-sm leading-relaxed text-text-secondary">
                剧情副本《{selected.storyTitle}》：{selected.storyChapters[0]?.content}
              </p>

              {selected.exclusiveSkin ? (
                <p className="mt-snug flex items-center gap-1 text-caption text-text-muted">
                  <Sparkles size={12} aria-hidden />
                  城市限定皮肤：{selected.exclusiveSkin.name} {selected.exclusiveSkin.emoji}
                </p>
              ) : null}

              {/* 实景照片上传（AR 同框 / 打卡合影的输入） */}
              <div className="mt-base">
                <p className="rt-label">实景照片（可选）</p>
                <div className="mt-snug flex items-center gap-snug">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onPickPhoto(file);
                    }}
                  />
                  <Button variant="quiet" icon={<Camera size={15} aria-hidden />} onClick={() => fileRef.current?.click()}>
                    {photo ? '换一张' : '拍照 / 上传'}
                  </Button>
                  {photo ? (
                    <>
                      <img src={photo} alt="待合成实景" className="h-14 w-14 rounded-tight object-cover" />
                      <Button variant="ghost" onClick={() => setPhoto(null)}>
                        移除
                      </Button>
                    </>
                  ) : null}
                </div>
                <p className="mt-1.5 text-caption text-text-muted">
                  上传后会走图像合成服务，并带上这只宠物的「资产母版 id」做角色锁定——它不会换脸。
                </p>
              </div>

              <div className="mt-base flex gap-snug">
                <Button block onClick={() => void doCheckin()} disabled={busy}>
                  <MapPin size={15} aria-hidden />
                  {busy ? '合成中…' : '立即打卡'}
                </Button>
                <Button variant="quiet" onClick={() => setSelected(null)}>
                  取消
                </Button>
              </div>
            </Card>
          ) : (
            <Card>
              <p className="rt-label">选择目的地</p>
              <p className="mt-snug text-body-sm text-text-muted">
                点地图上的图钉，或者从下面直接选一个。宠物心愿单里的地方会有额外剧情。
              </p>
              <div className="mt-snug grid grid-cols-2 gap-snug">
                {DESTINATIONS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelected(d)}
                    className={clsx(
                      'flex items-center gap-snug rounded-card border border-border-subtle/50 bg-surface-raised/70 p-snug text-left transition-all duration-300 ease-spring hover:-translate-y-0.5 hover:shadow-plush active:scale-[0.98]',
                      visitedIds.has(d.id) && 'border-brand-primary/40 bg-brand-primary/8',
                    )}
                  >
                    <span className="text-2xl" aria-hidden>
                      {d.emoji}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-body-sm font-bold text-text-primary">{d.name}</span>
                      <span className="block text-caption-sm text-text-muted">
                        {visitedIds.has(d.id) ? '已到访' : d.region}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {/* 历史打卡 */}
          <Card>
            <p className="rt-label">打卡记录（旅行时光机）</p>
            <ul className="mt-snug space-y-snug">
              {(data?.checkins ?? [])
                .slice()
                .reverse()
                .slice(0, 6)
                .map((c) => (
                  <li key={c.id} className="flex gap-snug">
                    {c.composedPhotoUrl ? (
                      <img src={c.composedPhotoUrl} alt={`${c.destinationName}合影`} className="h-14 w-14 shrink-0 rounded-tight object-cover" />
                    ) : (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-tight bg-surface-sunken text-xl">📍</div>
                    )}
                    <div className="min-w-0">
                      <p className="text-body-sm font-bold text-text-primary">
                        {c.destinationName}
                        {c.blindBox ? <span className="ml-2 text-caption font-normal text-text-muted">盲盒 {c.blindBox.emoji} {c.blindBox.name}</span> : null}
                      </p>
                      <p className="line-clamp-2 text-caption text-text-secondary">「{c.petCaption}」</p>
                      <p className="text-caption-sm text-text-muted">
                        {new Date(c.visitedAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </li>
                ))}
              {!data?.checkins?.length ? (
                <li className="text-body-sm text-text-muted">还没有打卡记录。第一次总是最好写的。</li>
              ) : null}
            </ul>
          </Card>
        </div>
      </div>

      {/* 打卡结果 */}
      <Sheet
        open={Boolean(outcome)}
        onClose={() => setOutcome(null)}
        title="打卡完成"
        description={outcome ? `${outcome.checkin.destinationName} · ${new Date(outcome.checkin.visitedAt).toLocaleString('zh-CN')}` : ''}
      >
        {outcome ? (
          <div className="space-y-snug">
            <div className="rounded-card bg-surface-sunken/70 p-snug text-body-sm text-text-secondary">
              {outcome.travelAlert}
            </div>

            {outcome.checkin.composedPhotoUrl ? (
              <figure className="overflow-hidden rounded-card">
                <img src={outcome.checkin.composedPhotoUrl} alt="宠物出镜合影" className="w-full object-cover" />
                <figcaption className="mt-1 text-caption text-text-muted">宠物出镜合成图（角色锁定 · 母版一致）</figcaption>
              </figure>
            ) : null}

            {outcome.storyChapter ? (
              <div className="rounded-card border-l-2 border-brand-primary bg-surface-raised p-snug">
                <p className="rt-label">剧情第 {outcome.storyChapter.index} 章 · {outcome.storyChapter.title}</p>
                <p className="mt-1 text-body-sm text-text-secondary">{outcome.storyChapter.content}</p>
              </div>
            ) : null}

            {outcome.revisitMemory ? (
              <p className="rounded-card bg-surface-sunken/70 p-snug text-body-sm text-text-secondary">
                🕰️ {outcome.revisitMemory}
              </p>
            ) : null}

            <div className="grid gap-snug sm:grid-cols-2">
              {outcome.blindBox ? (
                <div className="flex items-center gap-snug rounded-card bg-surface-raised p-snug">
                  <span className="text-2xl" aria-hidden>{outcome.blindBox.emoji}</span>
                  <div>
                    <p className="text-caption text-text-muted">旅行盲盒</p>
                    <p className="text-body-sm font-bold text-text-primary">
                      {outcome.blindBox.name}
                      <span className="ml-1 text-caption font-normal text-text-muted">{outcome.blindBox.rarity}</span>
                    </p>
                  </div>
                </div>
              ) : null}
              {outcome.unlockedSkin ? (
                <div className="flex items-center gap-snug rounded-card bg-surface-raised p-snug">
                  <span className="text-2xl" aria-hidden>{outcome.unlockedSkin.emoji}</span>
                  <div>
                    <p className="text-caption text-text-muted">城市限定解锁</p>
                    <p className="text-body-sm font-bold text-text-primary">{outcome.unlockedSkin.name}</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-card bg-surface-raised p-snug">
              <p className="rt-label">自动生成的手账</p>
              <p className="mt-1 text-body-sm font-bold text-text-primary">{outcome.journal.title}</p>
              <p className="mt-1 line-clamp-4 text-caption leading-relaxed text-text-secondary">{outcome.journal.body}</p>
            </div>

            <div className="rounded-card bg-surface-raised p-snug">
              <p className="rt-label">宠物视角明信片</p>
              <p className="mt-1 text-body-sm italic text-text-secondary">「{outcome.postcard.text}」</p>
              <p className="mt-1 text-right text-caption text-text-muted">{outcome.postcard.signature}</p>
            </div>

            <div className="flex items-center justify-between rounded-card bg-brand-primary/10 p-snug">
              <span className="flex items-center gap-1 text-body-sm text-text-secondary">
                <Gift size={14} aria-hidden />
                好感度
              </span>
              <span className="text-body font-bold text-brand-primary">+{outcome.gain}</span>
            </div>
          </div>
        ) : null}
      </Sheet>
    </AppShell>
  );
}

/** 轻量地图：等距圆柱投影，避免引入地图 SDK；接真实底图时替换此组件即可 */
function MapCanvas({
  destinations,
  visitedIds,
  selectedId,
  onSelect,
  userPoint,
}: {
  destinations: Destination[];
  visitedIds: Set<string>;
  selectedId: string | null;
  onSelect: (d: Destination) => void;
  userPoint: { lat: number; lng: number } | null;
}) {
  // 等距圆柱投影；留出内边距，避免最右侧/最上方的城市名被卡片裁掉
  const project = (lat: number, lng: number) => {
    const x = ((lng - 70) / (145 - 70)) * 100;
    const y = ((55 - lat) / (55 - 5)) * 100;
    return { x: Math.max(8, Math.min(90, x)), y: Math.max(8, Math.min(92, y)) };
  };

  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" role="img" aria-label="打卡地图">
      <defs>
        <linearGradient id="mapbg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="hsl(36 33% 97%)" />
          <stop offset="100%" stopColor="hsl(34 28% 91%)" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#mapbg)" />
      {/* 经纬网格 */}
      {Array.from({ length: 9 }).map((_, i) => (
        <line key={`h${i}`} x1="0" y1={i * 12.5} x2="100" y2={i * 12.5} stroke="hsl(30 24% 84% / 0.55)" strokeWidth="0.22" />
      ))}
      {Array.from({ length: 9 }).map((_, i) => (
        <line key={`v${i}`} x1={i * 12.5} y1="0" x2={i * 12.5} y2="100" stroke="hsl(30 24% 84% / 0.55)" strokeWidth="0.22" />
      ))}

      {destinations.map((d) => {
        const { x, y } = project(d.lat, d.lng);
        const visited = visitedIds.has(d.id);
        const active = selectedId === d.id;
        return (
          <g
            key={d.id}
            className="cursor-pointer"
            onClick={() => onSelect(d)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(d);
            }}
            aria-label={`选择 ${d.name}`}
          >
            {active ? <circle cx={x} cy={y} r="4.4" fill="hsl(10 100% 70% / 0.25)" /> : null}
            <circle
              cx={x}
              cy={y}
              r={visited ? 2.1 : 1.7}
              fill={visited ? 'hsl(10 100% 70%)' : 'hsl(20 35% 40% / 0.35)'}
              stroke="hsl(38 42% 99%)"
              strokeWidth="0.5"
            />
            <text x={x} y={y - 3} textAnchor="middle" fontSize="3.4" fill="hsl(30 20% 24% / 0.78)">
              {d.name}
            </text>
          </g>
        );
      })}

      {userPoint ? (
        (() => {
          const { x, y } = project(userPoint.lat, userPoint.lng);
          return (
            <g>
              <circle cx={x} cy={y} r="1.4" fill="hsl(96 26% 42%)" />
              <circle cx={x} cy={y} r="3.2" fill="none" stroke="hsl(96 26% 42% / 0.45)" strokeWidth="0.4" />
              <text x={x} y={y + 5.6} textAnchor="middle" fontSize="2.6" fill="hsl(96 26% 32%)">
                你在这里
              </text>
            </g>
          );
        })()
      ) : null}
    </svg>
  );
}
