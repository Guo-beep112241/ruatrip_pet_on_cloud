import { useState } from 'react';
import clsx from 'clsx';
import { Heart, Image, Shirt, Sparkles, Utensils, Bath, ToyBrick, MessageCircleHeart } from 'lucide-react';
import { useApp } from '../store/app';
import { Button, Card, Chip, ProgressBar, Sheet } from './ui';
import { SHOP_ITEMS, SCENE_PRESETS, MOOD_COPY } from '../api/types';
import { goTo } from '../hooks/useHashRouter';

const TOYS = [
  { id: 'toy-ball', label: '小球', emoji: '🎾' },
  { id: 'toy-feather', label: '逗猫棒', emoji: '🪶' },
  { id: 'toy-pillow', label: '抱枕', emoji: '🧸' },
];

/** 情绪气泡：宠物即时状态的语言表达（说明书 6.3-3） */
export function MoodBubble() {
  const pet = useApp((s) => s.pet);
  const reaction = useApp((s) => s.reaction);
  if (!pet) return null;
  const mood = MOOD_COPY[pet.mood] ?? MOOD_COPY.happy;
  const text = reaction?.text ?? mood.lines[0] ?? '（看着你）';

  return (
    <div key={reaction?.key ?? pet.mood} className="animate-drop-in">
      <div className="relative inline-flex max-w-[92%] items-start gap-2 rounded-card rounded-bl-sm bg-surface-raised/95 px-base py-snug text-body-sm text-text-primary shadow-plush backdrop-blur-md">
        <span className="text-lg leading-none" aria-hidden>
          {reaction?.emoji ?? mood.emoji}
        </span>
        <p className="leading-relaxed">{text}</p>
      </div>
      <p className="mt-1 pl-1 text-caption text-text-muted">
        现在的状态：{mood.label}
        {pet.longing < 55 ? ` · 想念值 ${pet.longing}/100，它在等你` : ''}
      </p>
    </div>
  );
}

/** 互动操作区：喂饭 / 洗澡 / 陪玩 / 真心话（说明书 6.3-2） */
export function InteractionDock() {
  const pet = useApp((s) => s.pet);
  const interact = useApp((s) => s.interact);
  const [busy, setBusy] = useState<string | null>(null);
  const [toyOpen, setToyOpen] = useState(false);

  if (!pet) return null;

  const run = async (action: 'feed' | 'bathe' | 'play', toyId?: string) => {
    setBusy(action);
    await interact(action, toyId);
    setBusy(null);
  };

  const actions = [
    { id: 'feed' as const, label: '喂饭', emoji: '🍚', icon: Utensils, hint: '每日 2 次' },
    { id: 'bathe' as const, label: '洗澡', emoji: '🫧', icon: Bath, hint: '每日 1 次' },
    { id: 'play' as const, label: '陪玩', emoji: '🎾', icon: ToyBrick, hint: '每种玩具单独计数' },
  ];

  return (
    <>
      <Card className="w-full">
        <div className="flex items-center justify-between">
          <div>
            <p className="rt-label">互动操作</p>
            <p className="mt-0.5 text-body-sm text-text-muted">好感度只能靠相处获得，不能购买。</p>
          </div>
          <button
            type="button"
            onClick={() => goTo('hut')}
            className="rt-button-quiet rt-tap-target"
          >
            <MessageCircleHeart size={15} aria-hidden />
            去小屋
          </button>
        </div>

        <div className="mt-base grid grid-cols-2 gap-snug sm:grid-cols-4">
          {actions.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.id}
                type="button"
                disabled={busy === a.id}
                onClick={() => (a.id === 'play' ? setToyOpen(true) : void run(a.id))}
                className={clsx(
                  'rt-card rt-card-hover rt-card-active flex min-h-[92px] flex-col items-center justify-center gap-1 p-snug transition-opacity',
                  busy === a.id && 'opacity-60',
                )}
              >
                <span className="text-2xl" aria-hidden>
                  {a.emoji}
                </span>
                <span className="flex items-center gap-1 text-body-sm font-bold text-text-primary">
                  <Icon size={14} aria-hidden />
                  {a.label}
                </span>
                <span className="text-caption-sm text-text-muted">{a.hint}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => goTo('hut')}
            className="rt-card rt-card-hover rt-card-active flex min-h-[92px] flex-col items-center justify-center gap-1 bg-brand-primary/12 p-snug"
          >
            <span className="text-2xl" aria-hidden>
              💬
            </span>
            <span className="text-body-sm font-bold text-brand-secondary">真心话</span>
            <span className="text-caption-sm text-text-muted">低收益，但鼓励</span>
          </button>
        </div>

        <div className="mt-base">
          <ProgressBar
            value={pet.levelProgress * 100}
            label={`Lv.${pet.level} · 好感度 ${pet.affection}`}
          />
        </div>

        {pet.quirks.length ? (
          <div className="mt-snug flex flex-wrap gap-1.5">
            <span className="rt-label mr-1 self-center">小毛病</span>
            {pet.quirks.map((q) => (
              <Chip key={q}>{q}</Chip>
            ))}
          </div>
        ) : null}
      </Card>

      <Sheet
        open={toyOpen}
        onClose={() => setToyOpen(false)}
        title="今天玩哪个？"
        description="每种玩具单独计数，避免一次刷满。"
      >
        <div className="grid grid-cols-3 gap-snug">
          {TOYS.map((toy) => (
            <button
              key={toy.id}
              type="button"
              onClick={() => {
                setToyOpen(false);
                void run('play', toy.id);
              }}
              className="rt-card rt-card-hover rt-card-active flex flex-col items-center gap-1 p-base"
            >
              <span className="text-3xl" aria-hidden>
                {toy.emoji}
              </span>
              <span className="text-body-sm font-medium text-text-primary">{toy.label}</span>
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

/** 侧边浮层：衣橱 / 场景 / 拍照（说明书 6.3-6） */
export function SideDock() {
  const pet = useApp((s) => s.pet);
  const equip = useApp((s) => s.equip);
  const redeem = useApp((s) => s.redeem);
  const [layer, setLayer] = useState<'wardrobe' | 'scene' | 'shop' | null>(null);

  if (!pet) return null;

  const ownedOutfits = SHOP_ITEMS.filter((i) => i.kind === 'outfit' && pet.unlockedOutfits.includes(i.id));
  const ownedScenes = SCENE_PRESETS.filter((s) => pet.unlockedScenes.includes(s.id));

  return (
    <>
      <div className="flex flex-col gap-snug">
        <button type="button" onClick={() => setLayer('wardrobe')} className="rt-button-quiet rt-tap-target justify-start">
          <Shirt size={15} aria-hidden />
          衣橱（换装）
        </button>
        <button type="button" onClick={() => setLayer('scene')} className="rt-button-quiet rt-tap-target justify-start">
          <Image size={15} aria-hidden />
          场景（换背景）
        </button>
        <button type="button" onClick={() => setLayer('shop')} className="rt-button-quiet rt-tap-target justify-start">
          <Sparkles size={15} aria-hidden />
          好感度商店
        </button>
        <button
          type="button"
          onClick={() => goTo('checkin')}
          className="rt-button rt-tap-target justify-start"
        >
          <Heart size={15} aria-hidden />
          一键合影（去打点）
        </button>
      </div>

      <Sheet
        open={layer === 'wardrobe'}
        onClose={() => setLayer(null)}
        title="衣橱"
        description="服装走「贴图 + 挂点」而非独立模型，所以换装实时生效。"
      >
        <div className="grid grid-cols-2 gap-snug sm:grid-cols-3">
          <button
            type="button"
            onClick={() => void equip({ outfitId: null })}
            className={clsx('rt-card rt-card-hover p-snug text-left', !pet.equippedOutfit && 'ring-2 ring-brand-primary/50')}
          >
            <span className="text-2xl" aria-hidden>
              🐾
            </span>
            <p className="mt-1 text-body-sm font-bold text-text-primary">不穿</p>
          </button>
          {ownedOutfits.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => void equip({ outfitId: item.id })}
              className={clsx(
                'rt-card rt-card-hover p-snug text-left',
                pet.equippedOutfit === item.id && 'ring-2 ring-brand-primary/50',
              )}
            >
              <span className="text-2xl" aria-hidden>
                {item.emoji}
              </span>
              <p className="mt-1 text-body-sm font-bold text-text-primary">{item.name}</p>
              <p className="text-caption-sm text-text-muted">{item.description}</p>
            </button>
          ))}
        </div>
        {!ownedOutfits.length ? (
          <p className="mt-base text-body-sm text-text-muted">还没有衣服。去好感度商店看看，那里只能用好感度兑换。</p>
        ) : null}
      </Sheet>

      <Sheet
        open={layer === 'scene'}
        onClose={() => setLayer(null)}
        title="场景"
        description="换场景时，光影方向会跟着变，否则宠物会像贴上去的。"
      >
        <div className="grid grid-cols-2 gap-snug sm:grid-cols-3">
          {SCENE_PRESETS.filter((s) => pet.unlockedScenes.includes(s.id) || s.id === 'home-warm').map((scene) => (
            <button
              key={scene.id}
              type="button"
              onClick={() => void equip({ sceneId: scene.id })}
              className={clsx(
                'overflow-hidden rounded-card border border-border-subtle/50 text-left transition-all duration-300 ease-spring hover:-translate-y-1 active:scale-[0.98]',
                pet.activeScene === scene.id && 'ring-2 ring-brand-primary/60',
              )}
            >
              <div className="h-20 w-full" style={{ background: scene.gradient }} />
              <div className="bg-surface-raised p-snug">
                <p className="text-body-sm font-bold text-text-primary">{scene.name}</p>
                <p className="text-caption-sm text-text-muted">光影 {scene.lightAngle}°</p>
              </div>
            </button>
          ))}
        </div>
        <p className="mt-snug text-caption text-text-muted">
          可用场景 {ownedScenes.length}/{SCENE_PRESETS.length}：雪夜、老书房、夏日海边需要用好感度解锁。
        </p>
      </Sheet>

      <Sheet
        open={layer === 'shop'}
        onClose={() => setLayer(null)}
        title="好感度商店"
        description="价值观红线：好感度不可购买。这里全部只能用相处换来的好感度兑换。"
      >
        <p className="mb-snug text-body-sm text-text-secondary">
          当前好感度：<strong className="text-brand-primary">{pet.affection}</strong>
        </p>
        <div className="grid gap-snug sm:grid-cols-2">
          {SHOP_ITEMS.map((item) => {
            const owned = [...pet.unlockedOutfits, ...pet.unlockedScenes].includes(item.id);
            const affordable = pet.affection >= item.price;
            return (
              <Card key={item.id} padded={false} className="flex items-center gap-snug p-snug">
                <span
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-card text-2xl"
                  style={{ backgroundColor: `${item.previewColor}33` }}
                  aria-hidden
                >
                  {item.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body-sm font-bold text-text-primary">{item.name}</p>
                  <p className="line-clamp-2 text-caption-sm text-text-muted">{item.description}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Chip>{item.price} 好感度</Chip>
                    {item.subscriberEarlyAccess ? <Chip>订阅提前</Chip> : null}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={owned ? 'ghost' : 'quiet'}
                  disabled={owned || !affordable}
                  onClick={() => void redeem(item.id)}
                >
                  {owned ? '已有' : affordable ? '兑换' : '不够'}
                </Button>
              </Card>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
