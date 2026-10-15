/**
 * 路由层的依赖集合（审计 M6）。
 *
 * 为什么用「一个大的 svc 对象」而不是给每个路由模块单独声明依赖：
 *   - 路由模块有 12 个，逐个声明会让 index.ts 的接线代码比路由本身还长
 *   - 这里的每一项都来自本项目的 service / adapter / shared 目录，
 *     没有外部注入需求，所以显式参数化只增加噪音
 *
 * 代价是类型不精确（部分是具体类型，部分是 any）。折中做法：
 * 把最常用、最容易传错的（repos / store / storage / check）标成具体类型，
 * 其余保留 any 并在注释里说明。等模块稳定后可逐项收紧。
 */
import type { Repositories } from '../repositories/index.ts';
import type { Store } from '../db/store.ts';
import type { AuthContext } from '../http/auth.ts';
import type { Pet, UserProfile } from '../../../../packages/shared/src/index.ts';
import type { IncomingMessage } from 'node:http';

export interface RouteServices {
  /* ---- appContext：全局单例与请求级辅助 ---- */
  SESSION_SECRET: string;
  activePet: (petId?: string | null, userId?: string) => Pet | null;
  analytics: any;
  authOf: (req: IncomingMessage) => AuthContext;
  care: any;
  currentUser: (req: IncomingMessage) => UserProfile;
  enforceDailyQuota: (kind: string, userId: string) => void;
  imageRefPrefixes: () => string[];
  migration: { migrated: boolean; userId?: string };
  persistenceChoice: any;
  push: any;
  repos: Repositories;
  requirePet: (petId: string | null | undefined, userId: string) => Pet;
  requireValidImageRef: (input: unknown, field: string) => string;
  storage: any;
  store: Store;
  touchCounters: Map<string, number>;

  /* ---- 校验 ---- */

  /* ---- 本域服务（来自 services / adapters / shared） ---- */
  [key: string]: any;
}

/** 路由注册函数签名 */
export type RouteRegistrar = (router: import('../http/router.ts').Router, svc: RouteServices) => void;
