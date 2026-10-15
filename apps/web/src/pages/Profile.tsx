import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Baby, Check, Copy, KeyRound, Sparkles, Users } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { Button, Card, Chip, SectionTitle, Sheet } from '../components/ui';
import { useApp } from '../store/app';
import { api, auth, withQuery } from '../api/client';
import { SUBSCRIPTION_PLANS } from '../api/types';
import type { FosterListResponse, IntegrationStatus, ProfileResponse, SubscriptionTier } from '../api/types';

/** 屏6：我的 —— 成长数据 + 衣橱 + 好感度明细 + 订阅 + 设置 + 能力接入 */
export function Profile() {
  const user = useApp((s) => s.user);
  const pet = useApp((s) => s.pet);
  const integration = useApp((s) => s.integration);
  const updateUser = useApp((s) => s.updateUser);
  const subscribe = useApp((s) => s.subscribe);
  const pushToast = useApp((s) => s.pushToast);
  const rename = useApp((s) => s.rename);

  const [stats, setStats] = useState<ProfileResponse['stats'] | null>(null);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [foster, setFoster] = useState<FosterListResponse | null>(null);
  const [friendName, setFriendName] = useState('');
  const [days, setDays] = useState(3);
  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [petName, setPetName] = useState(pet?.name ?? '');

  const loadProfile = async () => {
    try {
      const data = await api.get<ProfileResponse>('/profile');
      setStats(data.stats);
      useApp.setState({ user: data.user, pet: data.pet, integration: data.integration });
    } catch {
      /* 静默 */
    }
  };

  useEffect(() => {
    void loadProfile();
  }, []);

  useEffect(() => {
    if (!pet) return;
    void api
      .get<FosterListResponse>(withQuery('/foster', { petId: pet.id }))
      .then(setFoster)
      .catch(() => undefined);
  }, [pet?.id]);

  const mockMode = integration.every(
    (i) => !i.configured || ['mock', 'local-svg-composer', 'browser-web-speech', 'universal-skeleton'].includes(i.provider),
  );

  const startFoster = async () => {
    if (!pet) return;
    try {
      const data = await api.post<{ request: FosterListResponse['requests'][number] }>('/foster', {
        petId: pet.id,
        friendName,
        days,
      });
      setFoster((prev) => (prev ? { ...prev, requests: [data.request, ...prev.requests] } : { requests: [data.request], incomingLine: null }));
      pushToast(`已把${pet.name}托付给${data.request.friendName} ${data.request.days} 天。`, 'warm', '🏠');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '托付失败', 'warning', '🏠');
    }
  };

  const copyEnv = async (status: IntegrationStatus) => {
    const snippet = status.envKeys.map((k) => `${k}=`).join('\n');
    await navigator.clipboard.writeText(snippet);
    pushToast('环境变量模板已复制，填进 .env 即可启用。', 'plain', '📋');
  };

  return (
    <AppShell
      title="我的"
      subtitle="成长数据、衣橱、好感度明细、订阅与设置。所有需要接入 API 的地方在这里都能看到。"
      accessory={
        <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => setIntegrationsOpen(true)}>
          <KeyRound size={14} aria-hidden />
          能力接入（{integration.filter((i) => i.configured).length}/{integration.length}）
        </button>
      }
    >
      {/* 档案头 */}
      <Card className="mb-comfortable">
        <div className="flex flex-wrap items-center gap-comfortable">
          <span className="flex h-16 w-16 items-center justify-center rounded-card bg-surface-sunken text-3xl" aria-hidden>
            {user?.avatarEmoji ?? '🧸'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-title font-bold text-text-primary">{user?.nickname ?? '毛绒屋主人'}</h2>
              <Chip active={user?.tier !== 'free'}>
                {SUBSCRIPTION_PLANS.find((p) => p.tier === user?.tier)?.name ?? '免费'}
              </Chip>
              {user?.minorGuardEnabled ? <Chip>未成年人限额已开</Chip> : null}
            </div>
            <p className="mt-1 text-body-sm text-text-muted">
              连续陪伴 {user?.streakDays ?? 1} 天 · 宠物位 {user?.petSlots ?? 1} 个
              {pet ? ` · 当前宠物 ${pet.name}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-snug">
            <div className="flex items-center gap-snug">
              <input
                className="rt-input w-36"
                value={nickname}
                maxLength={12}
                placeholder="改个昵称"
                onChange={(e) => setNickname(e.target.value)}
              />
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  if (nickname.trim()) void updateUser({ nickname: nickname.trim() });
                }}
              >
                保存
              </Button>
            </div>
          </div>
        </div>

        {/* 数据网格 */}
        <div className="mt-comfortable grid grid-cols-2 gap-snug sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="相处天数" value={stats?.daysTogether ?? 0} suffix="天" />
          <Stat label="打卡" value={stats?.checkinCount ?? 0} suffix="次" />
          <Stat label="手账" value={stats?.journalCount ?? 0} suffix="篇" />
          <Stat label="记忆" value={stats?.memoryCount ?? 0} suffix="条" />
          <Stat label="城市" value={stats?.cityCount ?? 0} suffix="座" />
          <Stat label="好感度" value={stats?.affectionTotal ?? 0} suffix="" />
        </div>
      </Card>

      <div className="grid gap-comfortable lg:grid-cols-2">
        {/* 宠物信息与改名 */}
        <Card>
          <SectionTitle title="宠物档案" hint="同一只宠物只生成一次，之后所有场景复用同一份资产母版。" />
          {pet ? (
            <div className="space-y-snug">
              <div className="flex items-center gap-snug">
                <img src={pet.asset.fallbackRenderUrl} alt={pet.name} className="h-16 w-auto" />
                <div className="min-w-0 flex-1">
                  <input
                    className="rt-input"
                    value={petName}
                    maxLength={12}
                    onChange={(e) => setPetName(e.target.value)}
                  />
                  <p className="mt-1 text-caption text-text-muted">
                    资产母版 {pet.asset.masterId.slice(0, 18)}… · 版本 {pet.asset.version} · 面数 {pet.asset.triangleCount}
                  </p>
                </div>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    if (petName.trim()) void rename(petName.trim());
                  }}
                >
                  改名
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-snug text-caption text-text-muted">
                <div className="rounded-tight bg-surface-sunken/70 p-snug">
                  <p className="rt-label">骨骼</p>
                  <p className="mt-0.5 text-text-secondary">
                    {pet.asset.rigged ? pet.asset.rigTemplate : '绑定中'}
                  </p>
                </div>
                <div className="rounded-tight bg-surface-sunken/70 p-snug">
                  <p className="rt-label">生成服务</p>
                  <p className="mt-0.5 text-text-secondary">{pet.asset.provider}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <span className="rt-label mr-1 self-center">已解锁</span>
                {pet.unlockedOutfits.length ? pet.unlockedOutfits.map((o) => <Chip key={o}>{o}</Chip>) : <Chip>暂无服饰</Chip>}
                {pet.unlockedScenes.map((s) => (
                  <Chip key={s}>场景 {s}</Chip>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-body-sm text-text-muted">还没有宠物。</p>
          )}
        </Card>

        {/* 订阅 */}
        <Card>
          <SectionTitle title="订阅与商业化" hint="好感度不可购买 —— 这条线守住，「陪伴」的可信度就守住了。" />
          <div className="grid gap-snug sm:grid-cols-3">
            {SUBSCRIPTION_PLANS.map((plan) => {
              const active = user?.tier === plan.tier;
              return (
                <button
                  key={plan.tier}
                  type="button"
                  onClick={() => void subscribe(plan.tier as SubscriptionTier, 'monthly')}
                  className={clsx(
                    'rounded-card border p-snug text-left transition-all duration-300 ease-spring hover:-translate-y-0.5 hover:shadow-plush active:scale-[0.98]',
                    active ? 'border-brand-primary/60 bg-brand-primary/10' : 'border-border-subtle/50 bg-surface-raised/70',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-body-sm font-bold text-text-primary">{plan.name}</p>
                    {active ? <Check size={14} className="text-brand-primary" aria-hidden /> : null}
                  </div>
                  <p className="mt-0.5 text-body font-bold text-brand-secondary">
                    ¥{plan.priceMonthly}
                    <span className="text-caption font-normal text-text-muted">/月</span>
                  </p>
                  <p className="mt-0.5 text-caption-sm text-text-muted">年付 ¥{plan.priceYearly}</p>
                  <ul className="mt-snug space-y-1 text-caption-sm text-text-secondary">
                    {plan.highlights.slice(0, 3).map((h) => (
                      <li key={h}>· {h}</li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
          <p className="mt-snug text-caption text-text-muted">
            当前为<strong>模拟开通</strong>，只写状态不扣款。上线前需要接入真实支付通道，并补上未成年人消费限额校验。
          </p>
        </Card>

        {/* 云代养 / 双宠同行（第三阶段） */}
        <Card>
          <SectionTitle title="云代养 / 双宠同行" hint="出差或忙碌时，把它临时托付给好友几天。" />
          <div className="flex flex-wrap items-end gap-snug">
            <div className="min-w-[140px] flex-1">
              <label className="rt-label" htmlFor="friend">
                好友昵称
              </label>
              <input
                id="friend"
                className="rt-input mt-1"
                placeholder="比如：小满"
                value={friendName}
                maxLength={12}
                onChange={(e) => setFriendName(e.target.value)}
              />
            </div>
            <div className="w-24">
              <label className="rt-label" htmlFor="days">
                天数
              </label>
              <input
                id="days"
                type="number"
                min={1}
                max={14}
                className="rt-input mt-1"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </div>
            <Button variant="quiet" onClick={() => void startFoster()} disabled={!pet}>
              <Users size={14} aria-hidden />
              开始托付
            </Button>
          </div>

          {foster?.incomingLine ? (
            <p className="mt-snug rounded-card bg-brand-primary/10 p-snug text-body-sm text-text-secondary">
              {foster.incomingLine}
            </p>
          ) : null}

          <ul className="mt-snug space-y-1.5 text-caption text-text-secondary">
            {(foster?.requests ?? []).slice(0, 4).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-snug">
                <span>
                  {r.friendName} · {r.days} 天
                </span>
                <Chip>{r.status === 'active' ? '代养中' : r.status === 'completed' ? '已接回' : '待确认'}</Chip>
              </li>
            ))}
            {!foster?.requests?.length ? <li className="text-text-muted">还没有托付记录。</li> : null}
          </ul>
        </Card>

        {/* 账号与数据（审计 F5：删除通道） */}
        <Card>
          <SectionTitle title="账号与数据" hint="你的宠物、记忆、照片都只属于这个账号。可以随时注销并彻底删除。" />
          <AccountPanel onDone={() => void loadProfile()} />
        </Card>

        {/* 设置 */}
        <Card>
          <SectionTitle title="设置与安全" hint="未成年人保护与消费限额必须显式可配。" />
          <div className="space-y-snug">
            <label className="flex items-center justify-between gap-snug rounded-tight bg-surface-sunken/60 p-snug">
              <span className="flex items-center gap-2 text-body-sm text-text-secondary">
                <Baby size={15} aria-hidden />
                未成年人消费限额
              </span>
              <input
                type="checkbox"
                className="h-5 w-9 cursor-pointer appearance-none rounded-pill bg-border-strong transition-colors checked:bg-brand-primary"
                checked={user?.minorGuardEnabled ?? true}
                onChange={(e) => void updateUser({ minorGuardEnabled: e.target.checked })}
              />
            </label>
            <div className="flex items-center justify-between gap-snug rounded-tight bg-surface-sunken/60 p-snug">
              <span className="text-body-sm text-text-secondary">每月消费上限</span>
              <input
                type="number"
                min={0}
                max={5000}
                className="rt-input w-24 text-right"
                value={user?.monthlySpendLimit ?? 200}
                onChange={(e) => void updateUser({ monthlySpendLimit: Number(e.target.value) })}
              />
            </div>
            <div className="flex items-center justify-between gap-snug rounded-tight bg-surface-sunken/60 p-snug">
              <span className="text-body-sm text-text-secondary">头像</span>
              <div className="flex gap-1.5">
                {['🧸', '🐾', '🌰', '🪸', '☁️'].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => void updateUser({ avatarEmoji: emoji })}
                    className={clsx(
                      'rt-tap-target rounded-pill px-2 text-lg transition-transform active:scale-90',
                      user?.avatarEmoji === emoji && 'bg-brand-primary/20',
                    )}
                    aria-label={`选择头像 ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-snug flex flex-wrap gap-1.5">
            {pet?.personality.memoryAnchors.map((m) => (
              <Chip key={m}>{m}</Chip>
            ))}
          </div>
        </Card>
      </div>

      {/* 能力接入面板：明确指出「需要介入 API 的地方」 */}
      <Sheet
        open={integrationsOpen}
        onClose={() => setIntegrationsOpen(false)}
        title="需要接入 API 的地方"
        description={
          mockMode
            ? '当前全部能力运行在 Mock 模式：网站功能完整可用，3D 形象 / 语音 / 照片合成为本地降级实现。把下面任一通道配上密钥即可无缝切换到真实能力。'
            : '以下是你已经接入的真实通道，以及还没接入的通道。'
        }
      >
        <div className="space-y-base">
          {(['chat', 'threed', 'rigging', 'tts', 'asr', 'image', 'payment', 'storage', 'push', 'analytics'] as const).map((category) => {
            const items = integration.filter((i) => i.category === category);
            if (!items.length) return null;
            return (
              <div key={category}>
                <p className="rt-label">{CATEGORY_LABEL[category]}</p>
                <ul className="mt-snug space-y-snug">
                  {items.map((item) => {
                    const isFallback = ['mock', 'local-svg-composer', 'browser-web-speech', 'universal-skeleton'].includes(item.provider);
                    return (
                      <li
                        key={item.key}
                        className={clsx(
                          'rounded-card border p-snug',
                          item.configured && !isFallback
                            ? 'border-state-success/40 bg-state-success/8'
                            : 'border-border-subtle/50 bg-surface-raised/70',
                        )}
                      >
                        <div className="flex items-start justify-between gap-snug">
                          <div className="min-w-0">
                            <p className="text-body-sm font-bold text-text-primary">{item.label}</p>
                            <p className="mt-0.5 text-caption leading-relaxed text-text-secondary">{item.note}</p>
                          </div>
                          <Chip active={item.configured && !isFallback}>
                            {item.configured && !isFallback ? '已接入' : isFallback ? 'Mock 降级' : '待接入'}
                          </Chip>
                        </div>
                        {item.envKeys.length ? (
                          <div className="mt-snug flex flex-wrap items-center gap-1.5">
                            {item.envKeys.map((k) => (
                              <code key={k} className="rounded bg-surface-sunken px-1.5 py-0.5 text-caption-sm text-text-secondary">
                                {k}
                              </code>
                            ))}
                            <button
                              type="button"
                              onClick={() => void copyEnv(item)}
                              className="text-caption text-text-muted underline-offset-2 hover:text-brand-primary hover:underline"
                            >
                              <Copy size={11} className="mr-0.5 inline" aria-hidden />
                              复制
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        <div className="mt-base rounded-card bg-surface-sunken/70 p-snug text-caption text-text-muted">
          完整的接入步骤、请求/响应示例与推荐服务商对比，见仓库里的
          <code className="mx-1 rounded bg-surface-raised px-1">docs/API-INTEGRATION.md</code>。
          所有密钥只配在服务端 `.env`，前端永远不会拿到。
        </div>
      </Sheet>
    </AppShell>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  chat: '对话（真心话小屋自由层）',
  threed: '3D 形象生成',
  rigging: '自动绑定骨骼与动画',
  tts: '语音合成（宠物音色）',
  asr: '语音识别（按住说话）',
  image: '图像合成（打卡同框 / 明信片）',
  payment: '支付与订阅',
  storage: '对象存储与 CDN',
  push: '推送通知',
  analytics: '行为埋点',
};

/**
 * 账号面板：改密码 / 注销账号（含数据删除）。
 *
 * 注销是不可逆操作，所以要求输入密码 + 手打 DELETE 确认；
 * 服务端也会再次校验，前端这层只是防误触。
 */
function AccountPanel({ onDone }: { onDone: () => void }) {
  const pushToast = useApp((s) => s.pushToast);
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);

  const changePassword = async () => {
    setBusy(true);
    try {
      await auth.changePassword({ currentPassword, newPassword });
      pushToast('密码已更新，其它设备需要重新登录。', 'warm', '🔐');
      setPwdOpen(false);
      setCurrentPassword('');
      setNewPassword('');
    } catch (e) {
      pushToast(e instanceof Error ? e.message : '修改失败', 'warning', '🔐');
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (confirmText !== 'DELETE') {
      pushToast('请输入 DELETE 以确认', 'warning', '⚠️');
      return;
    }
    setBusy(true);
    try {
      await auth.deleteAccount({ password: deletePassword, confirm: 'DELETE' });
      // token 已被清掉，刷新回登录页
      window.location.reload();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : '注销失败', 'warning', '⚠️');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-snug">
      <div className="flex flex-wrap gap-snug">
        <Button variant="quiet" onClick={() => setPwdOpen((v) => !v)}>
          <KeyRound size={14} aria-hidden />
          修改密码
        </Button>
        <Button variant="quiet" onClick={() => void (async () => {
          auth.logout();
          window.location.reload();
        })()}>
          退出登录
        </Button>
        <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '注销账号并删除数据'}
        </Button>
      </div>

      {pwdOpen ? (
        <div className="space-y-snug rounded-card bg-surface-sunken/60 p-snug">
          <input
            type="password"
            className="rt-input"
            placeholder="当前密码"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <input
            type="password"
            className="rt-input"
            placeholder="新密码（至少 8 位，含字母和数字）"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <Button block onClick={() => void changePassword()} disabled={busy || !currentPassword || !newPassword}>
            确认修改
          </Button>
          <p className="text-caption text-text-muted">修改后，其它设备上的登录会立即失效。</p>
        </div>
      ) : null}

      {open ? (
        <div className="space-y-snug rounded-card border border-state-danger/40 bg-state-danger/8 p-snug">
          <p className="text-body-sm font-bold text-text-primary">这一步不可撤销</p>
          <p className="text-caption leading-relaxed text-text-secondary">
            会删除这个账号下的全部数据：宠物资产母版、好感度与互动记录、对话与记忆、打卡与手账、
            上传的照片、时光胶囊。删除后无法恢复。
          </p>
          <input
            type="password"
            className="rt-input"
            placeholder="输入密码确认"
            autoComplete="current-password"
            value={deletePassword}
            onChange={(e) => setDeletePassword(e.target.value)}
          />
          <input
            className="rt-input"
            placeholder="输入 DELETE 以确认"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
          <Button
            variant="danger"
            block
            onClick={() => void deleteAccount()}
            disabled={busy || confirmText !== 'DELETE' || !deletePassword}
          >
            确认注销并删除全部数据
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix: string }) {
  return (
    <div className="rounded-card bg-surface-sunken/70 p-snug text-center">
      <p className="text-title font-bold text-text-primary">
        {value}
        <span className="ml-0.5 text-caption font-normal text-text-muted">{suffix}</span>
      </p>
      <p className="mt-0.5 text-caption-sm text-text-muted">{label}</p>
    </div>
  );
}

export function ProfileSparkle() {
  return <Sparkles size={14} aria-hidden />;
}
