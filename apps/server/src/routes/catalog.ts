/**
 * catalog 域路由。
 *
 * 审计 M6：原 index.ts 已 1849 行，按业务域拆分后每个文件只关心自己的接口。
 * 所有依赖通过 svc 注入（见 index.ts 的 buildServices），
 * 这样路由模块与全局单例之间是显式依赖，而不是隐式引用。
 */
import { DESTINATIONS, PREFERENCE_QUESTIONS, SCENE_PRESETS, SHOP_ITEMS, SPECIES_CATALOG, SUBSCRIPTION_PLANS } from '../../../../packages/shared/src/catalog.ts';
import { AFFECTION_RULES, DAILY_AFFECTION_CAP } from '../../../../packages/shared/src/rules.ts';
import { activeLlmProvider } from '../adapters/chat.ts';
import { integrationReport } from '../adapters/registry.ts';
import { config } from '../config.ts';
import { VOICE_PRESETS } from '../services/adapters-bridge.ts';
import { nowIso } from '../services/growth.ts';
import { renderPetSvg, safePalette, safeSpecies } from '../services/petArt.ts';
import { check, SCHEMAS } from './schemas.ts';
import type { Router } from '../http/router.ts';
import type { RouteServices } from './services.ts';

export function registerCatalogRoutes(router: Router, svc: RouteServices): void {
  const {
    SESSION_SECRET,
    activePet,
    analytics,
    authOf,
    care,
    currentUser,
    enforceDailyQuota,
    imageRefPrefixes,
    migration,
    persistenceChoice,
    push,
    repos,
    requirePet,
    requireValidImageRef,
    storage,
    store,
    touchCounters,
  } = svc;
/* -------- 引导与基础数据 -------- */
/**
 * 健康检查（审计 M5）。
 *
 * 旧版只回 `{status:'up'}`，即使数据源或对象存储已经坏掉也报健康，
 * 平台不会重启、告警也不会响。
 *
 * 现在真实探测依赖，并且区分两种语义：
 *   - status: 'ok'       —— 全部正常
 *   - status: 'degraded' —— 核心可用但依赖异常（仍返回 200，避免被平台误杀）
 *   - status: 'error'    —— 核心不可用（返回 503，让平台重启或摘流量）
 */
  router.get('/api/health', async () => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. 持久化：能否正常读写
  try {
    const ok = await persistenceChoice.driver.healthy();
    checks.persistence = {
      ok,
      detail: `${persistenceChoice.description}${ok ? '' : '（不可用）'}`,
    };
  } catch (error) {
    checks.persistence = { ok: false, detail: String(error).slice(0, 120) };
  }

  // 2. 最近一次落盘是否失败
  const writeError = store.writeError;
  checks.lastWrite = writeError
    ? { ok: false, detail: writeError.message.slice(0, 120) }
    : { ok: true };

  // 3. 对象存储
  try {
    const ok = await storage.healthy();
    checks.storage = { ok, detail: `${storage.driver} 驱动${ok ? '' : '（不可用）'}` };
  } catch (error) {
    checks.storage = { ok: false, detail: String(error).slice(0, 120) };
  }

  // 4. 大模型通道（只报是否配置，不实际调用 —— 健康检查不该花钱）
  const llmProvider = activeLlmProvider();
  checks.llm = {
    ok: true,
    detail: llmProvider.meta.id === 'mock' ? 'Mock 模式（未配 key）' : `已接入 ${llmProvider.meta.id}`,
  };

  const persistenceOk = checks.persistence?.ok !== false;
  const storageOk = checks.storage?.ok !== false;
  const writeOk = checks.lastWrite?.ok !== false;
  const status = !persistenceOk || !writeOk ? 'error' : storageOk ? 'ok' : 'degraded';

  const body = {
    ok: true,
    data: {
      status,
      time: nowIso(),
      env: config.env,
      uptimeSec: Math.round(process.uptime()),
      driver: store.driverKind,
      /** 数据规模，用于发现异常膨胀（例如图片又被塞进 JSON） */
      dataBytes: store.sizeBytes(),
      checks,
    },
  };

  // 核心不可用时返回 503：平台会据此重启或摘掉流量
  return status === 'error' ? { __status: 503, __body: body } : body;
});

  router.get('/api/bootstrap', (ctx) => {
  const auth = authOf(ctx.req);
  const user = auth.account.profile;
  const pet = activePet(undefined, auth.userId);
  const steps = [
    { step: 'survey', done: Boolean(repos.getAnswers()) },
    { step: 'generate-pet', done: Boolean(pet) },
    { step: 'first-feed', done: Boolean(repos.lastInteractionAt(pet?.id ?? '', 'feed')) },
    { step: 'first-chat', done: Boolean(pet && repos.listConversations(pet.id).length) },
    { step: 'first-checkin', done: Boolean(pet && repos.listCheckins(pet.id).length) },
    { step: 'first-journal', done: Boolean(pet && repos.listJournals(pet.id).length) },
  ];
  return {
    ok: true,
    data: {
      user,
      pet,
      integration: integrationReport().items,
      scenes: SCENE_PRESETS,
      onboarding: steps,
    },
  };
});

  router.get('/api/integration', () => ({ ok: true, data: integrationReport() }));

  router.get('/api/catalog', () => ({
  ok: true,
  data: {
    species: SPECIES_CATALOG,
    questions: PREFERENCE_QUESTIONS,
    destinations: DESTINATIONS,
    shop: SHOP_ITEMS,
    plans: SUBSCRIPTION_PLANS,
    scenes: SCENE_PRESETS,
    affectionRules: AFFECTION_RULES,
    dailyCap: DAILY_AFFECTION_CAP,
    voicePresets: VOICE_PRESETS,
  },
}));

/**
 * 本地降级宠物形象：Mock 模式下的形象母版，也是低端机降级通道。
 *
 * 安全：species / palette 一律走白名单（safeSpecies / safePalette），
 * name 在渲染函数内部转义并截断长度。响应额外加 CSP，即使有人找到
 * 绕过路径也没法执行脚本。
 */
  router.get('/api/asset/pet.svg', (ctx) => {
  const species = safeSpecies(ctx.query.get('species'));
  const palette = safePalette((ctx.query.get('palette') ?? '').split(',').filter(Boolean));
  const name = ctx.query.get('name') ?? '宠物';
  const svg = renderPetSvg({ species, palette, name });
  ctx.res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=86400',
    // SVG 是唯一能「承载脚本的图片格式」，所以单独给它上锁
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'x-content-type-options': 'nosniff',
  });
  ctx.res.end(svg);
  return null;
});

/* ------------------------------------------------------------------ */
}
