import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { KeyRound, Loader2, LogIn, Mail, ShieldCheck, UserPlus } from 'lucide-react';
import { auth, setToken, type AuthStatus } from '../api/client';
import { useApp } from '../store/app';
import { Button, Card } from '../components/ui';

/**
 * 登录 / 注册页（审计 B2）。
 *
 * 三种初始状态：
 *   1. 库里还没有账号（requiresSetup）→ 引导创建第一个账号
 *   2. 已有账号 → 登录表单
 *   3. 已登录 → 直接进应用（由 App.tsx 处理）
 */
export function Auth() {
  const bootstrap = useApp((s) => s.bootstrap);
  const pushToast = useApp((s) => s.pushToast);

  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await auth.status();
        setStatus(s);
        // 新库没有账号 → 直接展示注册，少点一次
        if (s.requiresSetup) setMode('register');
      } catch (e) {
        setError(e instanceof Error ? e.message : '无法连接服务端');
      }
    })();
  }, []);

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('请填写邮箱与密码');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        await auth.register({ email: email.trim(), password, ...(nickname.trim() ? { nickname: nickname.trim() } : {}) });
        pushToast('账号创建好了，开始孵化你的毛绒搭子吧。', 'warm', '🎉');
      } else {
        await auth.login({ email: email.trim(), password });
        pushToast('欢迎回来。', 'warm', '🐾');
      }
      // 登录成功后重新拉取数据，让 App.tsx 切到正常流程
      await bootstrap();
    } catch (e) {
      const message = e instanceof Error ? e.message : '操作失败';
      setError(message);
      // 会话错误以外的失败（如密码强度）也清掉 token，避免半登录状态
      setToken(null);
    } finally {
      setBusy(false);
    }
  };

  const isSetup = status?.requiresSetup ?? false;

  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center px-base py-loose">
      <div className="w-full max-w-[420px]">
        <div className="mb-comfortable text-center">
          <span className="text-5xl" aria-hidden>
            🐾
          </span>
          <h1 className="mt-base text-title-lg font-bold tracking-tight text-text-primary">RuaTrip</h1>
          <p className="mt-1 text-body-sm text-text-muted">
            {isSetup ? '第一次使用，先创建一个账号' : '登录后回到你的毛绒搭子身边'}
          </p>
        </div>

        <Card>
          {!isSetup ? (
            <div className="mb-base flex gap-snug">
              {(['login', 'register'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setError(null);
                  }}
                  className={clsx(
                    'rt-chip rt-tap-target flex-1 justify-center py-snug text-body-sm transition-transform active:scale-95',
                    mode === m && 'rt-chip-active',
                  )}
                >
                  {m === 'login' ? '登录' : '注册'}
                </button>
              ))}
            </div>
          ) : null}

          <div className="space-y-snug">
            <label className="block">
              <span className="rt-label">邮箱</span>
              <div className="mt-1 flex items-center gap-snug rounded-xl bg-surface-sunken px-base focus-within:ring-2 focus-within:ring-brand-primary/40">
                <Mail size={15} className="shrink-0 text-text-muted" aria-hidden />
                <input
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  className="w-full bg-transparent py-snug text-body-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void submit()}
                />
              </div>
            </label>

            {mode === 'register' ? (
              <label className="block">
                <span className="rt-label">昵称（可选）</span>
                <div className="mt-1 flex items-center gap-snug rounded-xl bg-surface-sunken px-base focus-within:ring-2 focus-within:ring-brand-primary/40">
                  <KeyRound size={15} className="shrink-0 text-text-muted" aria-hidden />
                  <input
                    className="w-full bg-transparent py-snug text-body-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                    placeholder="你想让它怎么称呼你"
                    maxLength={24}
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  />
                </div>
              </label>
            ) : null}

            <label className="block">
              <span className="rt-label">密码</span>
              <div className="mt-1 flex items-center gap-snug rounded-xl bg-surface-sunken px-base focus-within:ring-2 focus-within:ring-brand-primary/40">
                <ShieldCheck size={15} className="shrink-0 text-text-muted" aria-hidden />
                <input
                  type="password"
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  className="w-full bg-transparent py-snug text-body-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                  placeholder={mode === 'register' ? '至少 8 位，含字母和数字' : '请输入密码'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void submit()}
                />
              </div>
              {mode === 'register' ? (
                <span className="mt-1 block text-caption-sm text-text-muted">
                  至少 8 位，且需要同时包含字母与数字或符号。
                </span>
              ) : null}
            </label>
          </div>

          {error ? (
            <p className="mt-base rounded-card bg-state-danger/12 px-snug py-snug text-body-sm text-state-danger">
              {error}
            </p>
          ) : null}

          <Button block className="mt-base" onClick={() => void submit()} disabled={busy}>
            {busy ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : mode === 'register' ? (
              <UserPlus size={16} aria-hidden />
            ) : (
              <LogIn size={16} aria-hidden />
            )}
            {mode === 'register' ? (isSetup ? '创建账号并开始' : '注册') : '登录'}
          </Button>

          <p className="mt-snug text-caption text-text-muted">
            账号只用来隔离你自己的宠物与记忆。我们不会把你的数据给任何第三方；你也可以随时在「我的」里注销并删除全部数据。
          </p>
        </Card>
      </div>
    </div>
  );
}
