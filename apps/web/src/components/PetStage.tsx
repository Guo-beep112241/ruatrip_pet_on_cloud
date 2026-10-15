import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useApp } from '../store/app';
import { SCENE_PRESETS } from '../api/types';

/**
 * 宠物主展示区。
 *
 * 现实中这里应该是 Three.js 渲染的 3D 母版（见 docs/API-INTEGRATION.md §2）。
 * 在未接入 / 低端机降级时，使用服务端渲染的 SVG 母版（/api/asset/pet.svg），
 * 它带呼吸、眨眼、摇尾动画，所以即使在 Mock 模式下宠物也是「活着」的。
 */
export function PetStage({ className, compact = false }: { className?: string; compact?: boolean }) {
  const pet = useApp((s) => s.pet);
  const reaction = useApp((s) => s.reaction);
  const touchPet = useApp((s) => s.touchPet);
  const [animation, setAnimation] = useState<string>('');
  const [tilt, setTilt] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!reaction) return;
    setAnimation(reaction.animation);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnimation(''), reaction.ms);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [reaction]);

  if (!pet) return null;

  const scene = SCENE_PRESETS.find((s) => s.id === pet.activeScene) ?? SCENE_PRESETS[0]!;
  // 资产母版未就绪（生成中）时，用同一接口按当前名字兜底渲染
  const art =
    pet.asset.meshUrl || pet.asset.fallbackRenderUrl
      ? pet.asset.fallbackRenderUrl
      : `/api/asset/pet.svg?species=${pet.species}&palette=${pet.vector.palette.join(',')}&name=${encodeURIComponent(pet.name)}`;

  const animationClass =
    animation === 'eat-happy' || animation === 'eat-fast'
      ? 'animate-[breathe_1.2s_ease-in-out_infinite]'
      : animation === 'bath-fluffy'
        ? 'animate-[tailWag_0.4s_ease-in-out_infinite]'
        : animation === 'play-pounce'
          ? 'animate-[float_0.9s_ease-in-out_infinite]'
          : animation === 'reunion-run' || animation === 'reunion-hug'
            ? 'animate-[breathe_1.4s_ease-in-out_infinite]'
            : animation === 'mood-shy'
              ? 'rotate-[-4deg]'
              : '';

  return (
    <div
      className={clsx('relative flex items-end justify-center overflow-hidden', className)}
      style={{
        background: scene.gradient,
        // 换场景时光影方向跟着变（说明书 3.3-4）
        boxShadow: `inset 0 0 120px 30px ${scene.ambient}`,
      }}
      onPointerMove={(e) => {
        // 轻微视差，模拟可旋转查看（3D 版这里换成 OrbitControls）
        if (compact) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width - 0.5;
        setTilt(ratio * 10);
      }}
      onPointerLeave={() => setTilt(0)}
    >
      {/* 环境光晕 */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background: `radial-gradient(60% 45% at 32% 22%, hsl(38 80% 92% / 0.85), transparent 70%)`,
        }}
        aria-hidden
      />

      {/* 宠物本体 */}
      <button
        type="button"
        className={clsx(
          'relative z-10 select-none transition-transform duration-700 ease-spring focus-visible:outline-none',
          animationClass,
          compact ? 'h-[46%]' : 'h-[78%]',
        )}
        style={{ transform: `rotate(${tilt * 0.35}deg)` }}
        onClick={() => void touchPet('head')}
        onDoubleClick={() => void touchPet('head', 'double')}
        onContextMenu={(e) => {
          e.preventDefault();
          void touchPet('head', 'long');
        }}
        aria-label={`摸摸${pet.name}`}
      >
        <img
          src={art}
          alt={`${pet.name}的形象`}
          className="h-full w-auto drop-shadow-[0_18px_28px_rgba(90,60,35,0.28)]"
          draggable={false}
        />
        {/* 服装叠加：接入真实换装后由模型材质替换，这里只做语义提示 */}
        {pet.equippedOutfit ? (
          <span className="absolute -right-2 top-2 rounded-pill bg-surface-raised/90 px-snug py-1 text-caption shadow-plush">
            {pet.equippedOutfit.replace('outfit-', '')} 已穿戴
          </span>
        ) : null}
      </button>

      {/* 抚摸热点：点击身体不同部位有不同反应（说明书 6.3） */}
      {!compact ? (
        <>
          <button
            type="button"
            aria-label="摸下巴"
            className="absolute bottom-[26%] left-[38%] h-16 w-16 rounded-full opacity-0"
            onClick={() => void touchPet('chin')}
          />
          <button
            type="button"
            aria-label="碰尾巴"
            className="absolute bottom-[18%] right-[16%] h-16 w-16 rounded-full opacity-0"
            onClick={() => void touchPet('tail')}
          />
        </>
      ) : null}

      {/* 地面阴影 */}
      <div className="pointer-events-none absolute bottom-3 h-6 w-[52%] rounded-full bg-text-primary/15 blur-md" aria-hidden />
    </div>
  );
}
