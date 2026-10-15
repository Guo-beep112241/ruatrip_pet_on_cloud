import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { HeartHandshake, Image as ImageIcon, Loader2, PenLine, ShieldCheck } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { Button, Card, Chip, EmptyState, ProgressBar, SectionTitle } from '../components/ui';
import { useApp } from '../store/app';
import { api } from '../api/client';
import type { CapsuleCreateResponse, CapsuleListResponse, CapsuleProject } from '../api/types';
import { DESTINATIONS } from '../api/types';

/**
 * 屏5：时光胶囊 —— 旧照上传、毛绒复原、纪念相册、写给它。
 * 这个页面刻意做得更暗、更克制，并且不做任何推荐位——它适合「主动寻找」，不适合被推销。
 */
export function TimeCapsule() {
  const pet = useApp((s) => s.pet);
  const pushToast = useApp((s) => s.pushToast);
  const [projects, setProjects] = useState<CapsuleProject[]>([]);
  const [disclaimer, setDisclaimer] = useState('');
  const [name, setName] = useState('');
  const [letter, setLetter] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<CapsuleProject | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const data = await api.get<CapsuleListResponse>('/capsule');
      setProjects(data.projects);
    } catch {
      /* 静默 */
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!active || active.stage === 'done' || active.stage === 'failed') return;
    const timer = setInterval(async () => {
      try {
        const data = await api.get<{ project: CapsuleProject; disclaimer: string }>(`/capsule/${active.id}`);
        setActive(data.project);
        setDisclaimer(data.disclaimer);
        setProjects((prev) => prev.map((p) => (p.id === data.project.id ? data.project : p)));
      } catch {
        /* 静默 */
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [active?.id, active?.stage]);

  const submit = async () => {
    if (!photo) {
      pushToast('先选一张旧照片吧。', 'plain', '🕯️');
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<CapsuleCreateResponse>('/capsule', {
        photoUrl: photo,
        petName: name || '它',
        letterTo: letter,
      });
      setProjects((prev) => [data.project, ...prev]);
      setActive(data.project);
      setDisclaimer(data.disclaimer);
      pushToast('收到了。慢慢来。', 'plain', '🕯️');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '提交失败', 'warning', '🕯️');
    } finally {
      setBusy(false);
    }
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

  return (
    <AppShell
      title="时光胶囊"
      subtitle="一个安静的地方。你可以上传它的旧照，让它以毛绒的样子继续陪着你。"
      atmosphere={3}
    >
      {/* 预期管理：必须明确提示，否则会造成二次情感伤害 */}
      <Card className="mb-comfortable border-state-warning/30 bg-state-warning/8">
        <div className="flex items-start gap-snug">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-state-warning" aria-hidden />
          <div className="text-body-sm leading-relaxed text-text-secondary">
            <p className="font-bold text-text-primary">先说清楚一件事</p>
            <p className="mt-1">
              这里生成的是「基于照片的陪伴形象」，<strong>不是它本人</strong>。
              它能做到毛色、花纹、体型大致相似，但无法做到一模一样。
            </p>
            <p className="mt-1 text-caption text-text-muted">
              如果你现在很沉，先不要急着开始。这个入口不会被推荐，它只在这里等你。
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-comfortable lg:grid-cols-2">
        {/* 区一：上传 */}
        <Card>
          <SectionTitle title="上传它的照片" hint="一张清晰的正面照就够了。照片只用于生成，你可以随时删除。" />

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPickPhoto(file);
            }}
          />

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={clsx(
              'flex min-h-[180px] w-full flex-col items-center justify-center gap-snug rounded-card border border-dashed transition-all duration-300 ease-spring',
              photo ? 'border-transparent bg-surface-sunken/40 p-snug' : 'border-border-strong/60 bg-surface-sunken/40 hover:-translate-y-0.5 hover:shadow-plush',
            )}
          >
            {photo ? (
              <img src={photo} alt="已选择的旧照片" className="max-h-[220px] w-auto rounded-card object-contain" />
            ) : (
              <>
                <ImageIcon size={26} className="text-text-muted" aria-hidden />
                <span className="text-body-sm text-text-muted">点击选择一张旧照片</span>
                <span className="text-caption-sm text-text-muted">支持相机直接拍，也支持相册</span>
              </>
            )}
          </button>

          <div className="mt-base space-y-snug">
            <div>
              <label className="rt-label" htmlFor="capsule-name">
                它叫什么
              </label>
              <input
                id="capsule-name"
                className="rt-input mt-1"
                placeholder="比如：豆豆"
                maxLength={12}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="rt-label" htmlFor="capsule-letter">
                想对它说的话（可选）
              </label>
              <textarea
                id="capsule-letter"
                className="rt-input mt-1 min-h-[96px] resize-y"
                placeholder="写在这里的话，会存进胶囊，只有你看得到。"
                maxLength={400}
                value={letter}
                onChange={(e) => setLetter(e.target.value)}
              />
            </div>
          </div>

          <Button block className="mt-base" onClick={() => void submit()} disabled={busy || !photo}>
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <HeartHandshake size={16} aria-hidden />}
            开始毛绒复原
          </Button>
          <p className="mt-snug text-caption text-text-muted">
            照片授权范围：仅用于本次形象生成与你的私人相册。删除通道在本页下方的项目列表里。
          </p>
        </Card>

        {/* 区二：复原结果 */}
        <Card>
          <SectionTitle title="复原进度" hint="图生 3D / 图生图是异步任务，通常需要几十秒到几分钟。" />
          {active ? (
            <div>
              <div className="relative flex h-[180px] items-center justify-center overflow-hidden rounded-card bg-surface-sunken/60">
                {active.stage === 'done' && active.restoredImageUrl ? (
                  <img src={active.restoredImageUrl} alt={`${active.petName}的毛绒形象`} className="h-full w-auto animate-breathe" />
                ) : (
                  <div className="flex flex-col items-center gap-snug text-text-muted">
                    <span className="text-4xl animate-pulse-soft" aria-hidden>
                      🕯️
                    </span>
                    <span className="text-body-sm">{STAGE_LABEL[active.stage]}</span>
                  </div>
                )}
              </div>
              <div className="mt-base">
                <ProgressBar value={active.progress} label={`${active.petName} · ${STAGE_LABEL[active.stage]}`} tone="chestnut" />
              </div>
              <p className="mt-snug text-body-sm text-text-secondary">
                {disclaimer || '这里生成的是基于照片的陪伴形象，不是它本人。'}
              </p>
              {active.stage === 'done' ? (
                <div className="mt-base flex flex-wrap gap-snug">
                  <Chip active>已存入纪念相册</Chip>
                  <Chip>可随时删除</Chip>
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState
              emoji="🫧"
              title="还没有正在复原的项目"
              description="上传一张照片，它就会开始。这个过程不会催你。"
            />
          )}
        </Card>
      </div>

      {/* 纪念相册 */}
      <section className="mt-loose">
        <SectionTitle title="纪念相册" hint="你主动保存下来的那些。" />
        {projects.length ? (
          <div className="grid grid-cols-2 gap-base sm:grid-cols-3 lg:grid-cols-4">
            {projects.map((p) => (
              <Card key={p.id} padded={false} className="overflow-hidden" interactive onClick={() => setActive(p)}>
                <div className="flex h-32 items-center justify-center bg-surface-sunken/60">
                  {p.restoredImageUrl ? (
                    <img src={p.restoredImageUrl} alt={p.petName} className="h-full w-auto object-contain" />
                  ) : (
                    <span className="text-3xl opacity-50" aria-hidden>
                      🕯️
                    </span>
                  )}
                </div>
                <div className="p-snug">
                  <p className="text-body-sm font-bold text-text-primary">{p.petName}</p>
                  <p className="text-caption-sm text-text-muted">
                    {new Date(p.createdAt).toLocaleDateString('zh-CN')} · {STAGE_LABEL[p.stage]}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState emoji="📔" title="相册还是空的" description="你上传并复原的形象会出现在这里。" />
        )}
      </section>

      {/* 次级功能列表：安静入口，不做推荐位 */}
      <section className="mt-loose">
        <SectionTitle title="还有一些安静的角落" hint="这里没有推送，也没有红点。" />
        <div className="grid gap-snug sm:grid-cols-2 lg:grid-cols-3">
          <QuietItem
            emoji="✍️"
            title="写给它"
            description="一封信会存进胶囊，随时可以回来改。"
            action={
              <span className="text-caption text-text-muted">
                {letter ? `已写 ${letter.length} 字` : '在本页上方输入框里写'}
              </span>
            }
          />
          <QuietItem
            emoji="🕰️"
            title="纪念日"
            description="记下它的生日、离开的日子，那天它会安静一点。"
            action={<span className="text-caption text-text-muted">需要接入日历与推送 API</span>}
          />
          <QuietItem
            emoji="🧾"
            title="复原精修（一次性付费）"
            description="更高精度的旗舰生成通道，高客单价、低频。"
            action={<span className="text-caption text-text-muted">需要接入支付 API</span>}
          />
          <QuietItem
            emoji="🗑️"
            title="删除与授权管理"
            description="上传的照片与生成结果都可以彻底删除。"
            action={<span className="text-caption text-text-muted">删除通道已在项目详情中提供</span>}
          />
          <QuietItem
            emoji="🌿"
            title="休息提示"
            description="检测到长时间停留或频繁提及离别情绪时，轻量提示休息与现实支持渠道。"
            action={<span className="text-caption text-text-muted">情绪关怀逻辑已在对话层实现</span>}
          />
          <QuietItem
            emoji="🏔️"
            title="把它的足迹留在旅途里"
            description="复原出的形象可以和普通宠物一样打卡、写手账。"
            action={
              <span className="text-caption text-text-muted">
                已有 {DESTINATIONS.length} 个目的地可用
              </span>
            }
          />
        </div>
      </section>

      <div className="mt-loose flex items-center justify-center gap-2 text-caption text-text-muted">
        <PenLine size={12} aria-hidden />
        {pet ? `${pet.name}不会知道你来过这里。` : '它会在这里等你。'}
      </div>
    </AppShell>
  );
}

const STAGE_LABEL: Record<string, string> = {
  uploaded: '已收到照片',
  analyzing: '正在读它的样子',
  restoring: '正在做毛绒化复原',
  done: '完成了',
  failed: '这次没成功',
};

function QuietItem({
  emoji,
  title,
  description,
  action,
}: {
  emoji: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-border-subtle/40 bg-surface-raised/60 p-base">
      <div className="flex items-start gap-snug">
        <span className="text-xl" aria-hidden>
          {emoji}
        </span>
        <div>
          <p className="text-body-sm font-bold text-text-primary">{title}</p>
          <p className="mt-1 text-caption leading-relaxed text-text-secondary">{description}</p>
          <div className="mt-snug">{action}</div>
        </div>
      </div>
    </div>
  );
}
