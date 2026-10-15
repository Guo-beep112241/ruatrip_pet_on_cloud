import { useEffect } from 'react';
import { useApp, type Screen } from '../store/app';

const SCREEN_HASH: Record<Screen, string> = {
  onboarding: '#/welcome',
  cabin: '#/cabin',
  hut: '#/hut',
  travel: '#/travel',
  checkin: '#/checkin',
  capsule: '#/capsule',
  profile: '#/profile',
};

const HASH_SCREEN: Record<string, Screen> = Object.fromEntries(
  Object.entries(SCREEN_HASH).map(([screen, hash]) => [hash.replace('#/', ''), screen as Screen]),
) as Record<string, Screen>;

/** 极简 hash 路由：可分享、可前进后退，零依赖 */
export function useHashRouter(): void {
  const screen = useApp((s) => s.screen);
  const navigate = useApp((s) => s.navigate);

  useEffect(() => {
    const apply = () => {
      const key = window.location.hash.replace(/^#\/?/, '');
      const target = HASH_SCREEN[key];
      if (target && target !== useApp.getState().screen) navigate(target);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [navigate]);

  useEffect(() => {
    const hash = SCREEN_HASH[screen];
    if (hash && window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [screen]);
}

export function goTo(screen: Screen): void {
  useApp.getState().navigate(screen);
}
