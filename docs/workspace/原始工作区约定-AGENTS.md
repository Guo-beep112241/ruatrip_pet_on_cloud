# Workspace Agent Contract

## Mission

本工作区的唯一交付物是 `RUATRIP_BEST_PET_FRIENDS/`：RuaTrip（Rua途）v2.0 的可运行 Web 实现。

## Runtime Path Model

- 仓库根：`RUATRIP_BEST_PET_FRIENDS/`
- 后端：`RUATRIP_BEST_PET_FRIENDS/apps/server/src`
- 前端：`RUATRIP_BEST_PET_FRIENDS/apps/web/src`
- 共用领域模型：`RUATRIP_BEST_PET_FRIENDS/packages/shared/src`
- 设计令牌：`RUATRIP_BEST_PET_FRIENDS/packages/theme/src`
- 文档（含产品说明书）：`RUATRIP_BEST_PET_FRIENDS/docs`

## Boundaries

- 需求唯一事实来源：`docs/RuaTrip产品详细说明书-v2.0.md`。与代码冲突时以说明书为准，并更新代码。
- 视觉唯一事实来源：`docs/视觉设计规范-毛绒实木.md`。改颜色请改 `packages/theme/src/tokens.ts`
  后运行 `npm run gen:theme`，不要手改 `apps/web/src/styles/tokens.css`。
- 外部能力一律走 `apps/server/src/adapters/*`，业务代码不得直接 `fetch` 第三方接口。
- 数据读写一律走 `apps/server/src/repositories/*`，服务层不得直接操作存储。

## Invariants（不可破坏）

1. **密钥只在服务端**。前端只访问 `/api`，任何第三方 key 不得进入前端产物。
2. **任何真实通道失败都回落 Mock**，页面不得白屏或卡死，且必须如实标注降级。
3. **好感度不可购买**。商店与订阅不得绕过这一点。
4. **资产母版唯一化**。同一只宠物只生成一次，后续场景从母版派生，禁止重新生成。
5. **已逝宠物复原不做推荐位**，并且必须保留「不是它本人」的预期管理文案。
6. 所有可点元素热区 ≥ 44×44px；移动端与电脑端都要验证。

## Quality Gates

```bash
npm run typecheck   # 全部 workspace
npm test            # 23 个单元测试
npm run build       # 前端构建
npm start           # 生产模式：后端同源托管前端，验证 http://localhost:8787
```

改动完成后同时验证移动端（<768px）与电脑端（≥1024px）。

## Execution Style

- 小批量改动，每个功能切片一个 commit，commit message 用中文写清「做了什么 + 为什么」。
- 新增外部能力时，同步更新 `docs/API-INTEGRATION.md` 与前端「我的 → 能力接入」面板。
