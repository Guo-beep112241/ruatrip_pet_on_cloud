import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, Check, Loader2, Sparkles } from 'lucide-react';
import { Card, Chip, ProgressBar } from '../components/ui';
import { useApp } from '../store/app';
import { PREFERENCE_QUESTIONS, SPECIES_CATALOG } from '../api/types';
import type { PreferenceAnswers } from '../api/types';
import { goTo } from '../hooks/useHashRouter';

type Step = 'intro' | 'survey' | 'confirm' | 'hatching' | 'met';

/** 首次使用主路径（说明书八）：问卷 → 孵化 → 首见 → 引导喂饭与真心话 → 打卡 → 首篇手账 */
export function Onboarding() {
  const [step, setStep] = useState<Step>('intro');
  const [index, setIndex] = useState(0);
  const [name, setName] = useState('');

  const draft = useApp((s) => s.surveyDraft);
  const setSurveyAnswer = useApp((s) => s.setSurveyAnswer);
  const submitSurvey = useApp((s) => s.submitSurvey);
  const result = useApp((s) => s.surveyResult);
  const createPet = useApp((s) => s.createPet);
  const pet = useApp((s) => s.pet);
  const job = useApp((s) => s.job);
  const loading = useApp((s) => s.loading);

  const question = PREFERENCE_QUESTIONS[index];
  const answeredCount = useMemo(
    () => PREFERENCE_QUESTIONS.filter((q) => (draft[q.id] ?? []).length > 0).length,
    [draft],
  );

  /** 孵化完成 → 自动进入「首见」 */
  useEffect(() => {
    if (step === 'hatching' && job && (job.stage === 'ready' || job.stage === 'fallback_used')) {
      const timer = setTimeout(() => setStep('met'), 900);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [step, job]);

  const toggle = (dimension: string, optionId: string, maxSelect?: number) => {
    const current = (draft as PreferenceAnswers)[dimension as keyof PreferenceAnswers] ?? [];
    let next: string[];
    if (current.includes(optionId)) next = current.filter((v) => v !== optionId);
    else if (maxSelect && current.length >= maxSelect) next = [...current.slice(1), optionId];
    else next = [...current, optionId];
    setSurveyAnswer(dimension, next);
  };

  const goNext = async () => {
    if (index < PREFERENCE_QUESTIONS.length - 1) {
      setIndex(index + 1);
      return;
    }
    const submitted = await submitSurvey();
    if (submitted) setStep('confirm');
  };

  const finish = async () => {
    const chosen = name.trim() || result?.suggestedNames[0] || '小家伙';
    setStep('hatching');
    await createPet(chosen);
  };

  /* ---------------- 步骤 1：开场 ---------------- */
  if (step === 'intro') {
    return (
      <Shell>
        <Card className="mx-auto max-w-phone text-center">
          <span className="text-5xl" aria-hidden>
            🐾
          </span>
          <h1 className="mt-base text-title font-bold tracking-tight text-text-primary">
            给无法养真宠物的人，<br />一只毛绒搭子
          </h1>
          <p className="mt-snug text-body-sm leading-relaxed text-text-muted">
            过敏、租房禁宠、经常出差、作息不规律——
            这些都不该成为没有陪伴的理由。
          </p>
          <ul className="mt-base space-y-2 text-left text-body-sm text-text-secondary">
            {[
              '3D 真实感形象，可以换装、换场景、随手摸',
              '关系会生长：好感度、性格、记忆随相处累积',
              '能一起旅行打卡，回来还会自动写手账',
              '它记得你说过的话，会主动提起',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Check size={16} className="mt-1 shrink-0 text-brand-primary" aria-hidden />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="rt-button mt-loose w-full" onClick={() => setStep('survey')}>
            开始偏好问卷
            <ArrowRight size={16} aria-hidden />
          </button>
          <p className="mt-snug text-caption text-text-muted">8 道题，3 分钟内完成。不喜欢的题可以跳过，我们会用相似画像补全。</p>
        </Card>
      </Shell>
    );
  }

  /* ---------------- 步骤 2：问卷 ---------------- */
  if (step === 'survey' && question) {
    const selected = draft[question.id] ?? [];
    return (
      <Shell>
        <div className="mx-auto max-w-phone">
          <div className="mb-base">
            <div className="flex items-center justify-between text-caption text-text-muted">
              <span>
                第 {index + 1} / {PREFERENCE_QUESTIONS.length} 题
              </span>
              <span>已完成 {answeredCount} 题</span>
            </div>
            <ProgressBar className="mt-1.5" value={index + 1} max={PREFERENCE_QUESTIONS.length} />
          </div>

          <Card>
            <h2 className="text-body-lg font-bold leading-snug text-text-primary">{question.question}</h2>
            {question.helper ? <p className="mt-1 text-caption text-text-muted">{question.helper}</p> : null}

            <div className="mt-base grid gap-snug sm:grid-cols-2">
              {question.options.map((opt) => {
                const active = selected.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => toggle(question.id, opt.id, question.maxSelect)}
                    className={clsx(
                      'flex items-center gap-snug rounded-card border p-snug text-left transition-all duration-300 ease-spring active:scale-[0.98]',
                      active
                        ? 'border-brand-primary/60 bg-brand-primary/12 shadow-plush'
                        : 'border-border-subtle/50 bg-surface-raised/70 hover:-translate-y-0.5 hover:shadow-plush',
                    )}
                    aria-pressed={active}
                  >
                    <span className="text-2xl" aria-hidden>
                      {opt.emoji}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-body-sm font-bold text-text-primary">{opt.label}</span>
                      {opt.hint ? <span className="block text-caption-sm text-text-muted">{opt.hint}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {question.maxSelect ? (
              <p className="mt-snug text-caption text-text-muted">最多选 {question.maxSelect} 个，选满后会自动替换最早的选择。</p>
            ) : null}
          </Card>

          <div className="mt-base flex items-center justify-between gap-snug">
            <button
              type="button"
              className="rt-button-quiet rt-tap-target"
              onClick={() => setIndex(Math.max(0, index - 1))}
              disabled={index === 0}
            >
              上一题
            </button>
            <div className="flex gap-snug">
              <button
                type="button"
                className="rt-button-quiet rt-tap-target"
                onClick={() => void goNext()}
              >
                跳过这题
              </button>
              <button type="button" className="rt-button rt-tap-target" onClick={() => void goNext()} disabled={loading}>
                {index === PREFERENCE_QUESTIONS.length - 1 ? '看我的画像' : '下一题'}
                <ArrowRight size={16} aria-hidden />
              </button>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  /* ---------------- 步骤 3：确认画像与命名 ---------------- */
  if (step === 'confirm' && result) {
    const species = SPECIES_CATALOG.find((s) => s.id === result.petDraft.species) ?? SPECIES_CATALOG[0]!;
    return (
      <Shell>
        <div className="mx-auto grid max-w-content gap-comfortable lg:grid-cols-2">
          <Card>
            <p className="rt-label">你的偏好画像</p>
            <h2 className="mt-1 text-title font-bold text-text-primary">
              {result.petDraft.speciesEmoji} {species.name}
            </h2>
            <p className="mt-1 text-body-sm text-text-muted">
              问卷完整度 {Math.round(result.inference.confidence * 100)}%
              {result.inference.inferredDimensions.length
                ? `（${result.inference.inferredDimensions.length} 个维度用相似画像补全，之后会被你的行为持续修正）`
                : '（全部由你亲自选择）'}
            </p>

            <div className="mt-base space-y-snug">
              <Row label="体型">{result.petDraft.bodySize}</Row>
              <Row label="毛感">{result.petDraft.fur}</Row>
              <Row label="配色">{result.petDraft.palette.join(' / ')}</Row>
              <Row label="性格">{result.petDraft.personalityPreview.traits.join(' / ')}</Row>
            </div>

            <div className="mt-base rounded-card bg-surface-sunken/70 p-base">
              <p className="rt-label">它会这样跟你说话</p>
              <p className="mt-1 text-body-sm text-text-secondary">
                说话节奏：{result.petDraft.personalityPreview.speechRhythm}
              </p>
              <div className="mt-snug flex flex-wrap gap-1.5">
                {result.petDraft.personalityPreview.catchphrases.map((c) => (
                  <Chip key={c}>「{c}」</Chip>
                ))}
              </div>
            </div>

            <div className="mt-base flex flex-wrap gap-1.5">
              {result.suggestedQuirks.map((q) => (
                <Chip key={q}>小毛病：{q}</Chip>
              ))}
            </div>
          </Card>

          <Card>
            <p className="rt-label">给它起个名字</p>
            <input
              className="rt-input mt-2 text-body-lg"
              placeholder="比如：汤圆"
              value={name}
              maxLength={12}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="mt-snug flex flex-wrap gap-snug">
              {result.suggestedNames.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setName(n)}
                  className={clsx('rt-chip rt-tap-target transition-transform active:scale-95', name === n && 'rt-chip-active')}
                >
                  {n}
                </button>
              ))}
            </div>

            <div className="mt-base rounded-card border border-border-subtle/50 p-base text-caption text-text-muted">
              <p>生成流程会走：偏好向量 → 3D 生成（几何 + PBR 贴图）→ 自动绑定骨骼 → 状态机动画。</p>
              <p className="mt-1.5">
                这个过程是异步的，大概几十秒。它会用「孵化」动画陪着你，所以等待也是体验的一部分。
              </p>
            </div>

            <button type="button" className="rt-button mt-base w-full" onClick={() => void finish()} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" size={16} aria-hidden /> : <Sparkles size={16} aria-hidden />}
              开始孵化
            </button>
            <p className="mt-snug text-caption text-text-muted">
              同一只宠物只生成一次，之后所有场景都用同一份「资产母版」，所以它不会换脸。
            </p>
          </Card>
        </div>
      </Shell>
    );
  }

  /* ---------------- 步骤 4：孵化 ---------------- */
  if (step === 'hatching' || step === 'met') {
    const progress = job?.progress ?? 6;
    const stageLabel: Record<string, string> = {
      queued: '排队中',
      generating_mesh: '生成几何',
      texturing: '上色贴图',
      rigging: '绑定骨骼',
      ready: '完成',
      fallback_used: '完成（降级资产）',
      failed: '失败',
    };
    return (
      <Shell>
        <div className="mx-auto max-w-phone text-center">
          <Card>
            {step === 'met' && pet ? (
              <>
                <img
                  src={pet.asset.fallbackRenderUrl}
                  alt="刚孵化的宠物"
                  className="mx-auto h-56 w-auto animate-breathe"
                />
                <h2 className="mt-base text-title font-bold text-text-primary">它出来了</h2>
                <p className="mt-snug text-body-sm text-text-secondary">
                  「{pet.personality.catchphrases[0] ?? '嗯……'}」——{pet.name}看着你。
                </p>
                {job?.rigFallbackUsed ? (
                  <p className="mt-snug text-caption text-text-muted">
                    提示：自动绑定走的是通用骨架兜底（{job.rigFallbackUsed}），动作集略少，但体验不中断。
                  </p>
                ) : null}
                <button
                  type="button"
                  className="rt-button mt-base w-full"
                  onClick={() => {
                    useApp.getState().finishOnboarding();
                    goTo('cabin');
                  }}
                >
                  进宠物舱，打个招呼
                </button>
              </>
            ) : (
              <>
                <div className="relative mx-auto flex h-56 w-56 items-center justify-center">
                  <div className="absolute inset-0 animate-pulse-soft rounded-full bg-brand-primary/15 blur-xl" />
                  <div className="absolute inset-6 animate-float rounded-full border border-dashed border-brand-secondary/40" />
                  <span className="relative text-6xl" aria-hidden>
                    🥚
                  </span>
                </div>
                <h2 className="mt-base text-title font-bold text-text-primary">正在孵化</h2>
                <p className="mt-snug min-h-[3rem] text-body-sm text-text-secondary">
                  {job?.incubatingLine ?? '正在准备一块干净的工作台。'}
                </p>
                <div className="mt-base">
                  <ProgressBar value={progress} label={`阶段：${stageLabel[job?.stage ?? 'queued'] ?? '准备中'}`} />
                </div>
                <p className="mt-snug text-caption text-text-muted">
                  生成服务：{job?.provider ?? 'mock'}。这个等待是真实的异步任务，不是假进度条。
                </p>
              </>
            )}
          </Card>
        </div>
      </Shell>
    );
  }

  return null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center px-base py-loose">
      <div className="w-full max-w-content">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-snug border-b border-border-subtle/40 pb-1.5 text-body-sm">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text-primary">{children}</span>
    </div>
  );
}
