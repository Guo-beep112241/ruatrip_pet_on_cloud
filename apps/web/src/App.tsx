import { useEffect } from 'react';
import { useApp } from './store/app';
import { useHashRouter } from './hooks/useHashRouter';
import { Auth } from './pages/Auth';
import { Onboarding } from './pages/Onboarding';
import { PetCabin } from './pages/PetCabin';
import { TruthHut } from './pages/TruthHut';
import { TravelJournal } from './pages/TravelJournal';
import { CheckinMap } from './pages/CheckinMap';
import { TimeCapsule } from './pages/TimeCapsule';
import { Profile } from './pages/Profile';

export function App() {
  const bootstrap = useApp((s) => s.bootstrap);
  const ready = useApp((s) => s.ready);
  const pet = useApp((s) => s.pet);
  const screen = useApp((s) => s.screen);
  const authRequired = useApp((s) => s.authRequired);

  useHashRouter();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 会话不可用 → 先登录（审计 B2）
  if (authRequired) return <Auth />;

  // 没有宠物时，无论 hash 指向哪，都先走孵化流程（首日必须交付完整体验）
  if (!ready) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-base text-text-muted">
        <span className="animate-pulse-soft text-5xl" aria-hidden>
          🐾
        </span>
        <p className="text-body-sm">正在把毛绒玩具摆好……</p>
      </div>
    );
  }

  if (!pet) return <Onboarding />;

  switch (screen) {
    case 'hut':
      return <TruthHut />;
    case 'travel':
      return <TravelJournal />;
    case 'checkin':
      return <CheckinMap />;
    case 'capsule':
      return <TimeCapsule />;
    case 'profile':
      return <Profile />;
    case 'onboarding':
      return <Onboarding />;
    case 'cabin':
    default:
      return <PetCabin />;
  }
}
