# RuaTrip（Rua途）v2.0 — 技术架构

> 目标：把《RuaTrip 产品详细说明书 v2.0》的六大核心模块落成一个**可运行、可扩展、Mock 模式也完整**的 Web 应用。
> 移动端与电脑端共用同一套代码，通过响应式布局适配。

---

## 1. 技术选型与理由

| 层 | 选型 | 为什么是它 |
| --- | --- | --- |
| 前端框架 | React 18 + TypeScript（strict） | 说明书 4.4 推荐的 Three.js 体系在 React 生态里最成熟（React Three Fiber + Drei），后续接 3D 不用换栈 |
| 构建 | Vite 6 | 起服务与构建都在秒级，改样式即时生效 |
| 样式 | Tailwind CSS 3 + 设计令牌 | 视觉规范第 4 章的组件配方本身就是原子类组合，直接落地 |
| 状态 | zustand | 跨页面共享的状态很少（用户/宠物/接入清单），不需要 Redux 那套 |
| 后端 | Node 内置 `node:http` + `tsx` | **零框架依赖**：只有 shared 一个 workspace 包，`npm install` 171 个包、3 分钟就能跑起来 |
| 校验 | TypeScript 类型即契约 | 前后端共用 `packages/shared`，没有第二份接口定义 |
| 数据 | 原子写入的 JSON 文件 | 演示零配置；换 Postgres 只需重写 repositories 的 22 个方法 |

**为什么不上 Next.js / Nest / Prisma**
这份说明书的第一阶段目标是「验证用户是否愿意每天回来和它相处」。为了验证一件事先引入三套框架和一套 ORM，会显著抬高试错成本。当前结构在需要时都能平滑升级：JSON → Postgres、`node:http` → Fastify、Vite SPA → Next.js。

---

## 2. 目录结构与职责

```
RUATRIP_BEST_PET_FRIENDS/
├── docs/
│   ├── RuaTrip产品详细说明书-v2.0.md   ← 需求唯一事实来源
│   ├── 视觉设计规范-毛绒实木.md          ← 视觉唯一事实来源
│   ├── API-INTEGRATION.md              ← ★ 需要接入 API 的完整清单
│   ├── ARCHITECTURE.md                 ← 本文
│   └── confirmed-ia.json / wireframe.jpg
├── packages/
│   ├── shared/          # 前后端共用：领域模型 + 静态目录 + 规则 + API 契约
│   │   └── src/{index,catalog,rules,api}.ts
│   └── theme/           # 设计令牌唯一来源 → 生成 CSS 变量 + Tailwind preset
│       ├── src/tokens.ts
│       └── scripts/build-tokens.mjs
├── apps/
│   ├── server/          # API 服务
│   │   └── src/
│   │       ├── config.ts              # 环境变量 + 能力可用性判断
│   │       ├── db/store.ts            # 原子写入的持久层
│   │       ├── repositories/index.ts  # ★ 换数据库只改这里
│   │       ├── adapters/              # ★ 换外部供应商只改这里
│   │       │   ├── chat.ts  mesh.ts  rigging.ts  tts.ts  image.ts
│   │       │   ├── registry.ts        # 接入清单汇总
│   │       │   └── types.ts
│   │       ├── services/              # 业务规则
│   │       │   ├── inference.ts  # 问卷 → 偏好向量 → 形象参数
│   │       │   ├── persona.ts    # 人格档案卡 / system prompt / 内容安全 / 预设池
│   │       │   ├── growth.ts     # 好感度、想念值、连续陪伴、情绪
│   │       │   ├── memory.ts     # 记忆摘要、关键事件、容量淘汰
│   │       │   ├── chat.ts       # 四层对话编排
│   │       │   ├── travel.ts     # 打卡、心愿单、徽章、盲盒、时光机
│   │       │   ├── content.ts    # 手账 / 明信片 / 剧情文案引擎
│   │       │   ├── pet.ts        # 生成编排 + 商店兑换
│   │       │   └── petArt.ts     # 降级形象（本地 SVG）
│   │       └── http/{router,static}.ts
│   └── web/             # 前端（移动端 + 电脑端同一份代码）
│       └── src/
│           ├── api/{client,types}.ts
│           ├── store/app.ts
│           ├── hooks/
│           ├── components/{AppShell,PetStage,InteractionDock,ui}.tsx
│           ├── pages/{Onboarding,PetCabin,TruthHut,TravelJournal,CheckinMap,TimeCapsule,Profile}.tsx
│           └── styles/{global.css,tokens.css(生成)}
├── .env.example
└── package.json         # npm workspaces
```

---

## 3. 依赖方向（单向，无环）

```
apps/web ──▶ packages/shared ◀── apps/server
apps/web ──▶ packages/theme  ◀── (Tailwind preset)
```

`apps/server/src/index.ts` 以外的服务端文件统一用相对路径引用 shared，这样服务端只依赖 `tsx` 一个开发依赖即可运行（不依赖 workspace 链接解析），降低了环境差异导致的启动失败。

---

## 4. 数据流

### 4.1 首次使用

```
问卷答案 ──▶ services/inference.ts
             ├─ 归一化 → PreferenceVector（缺失维度用相似画像补全并标注 inferred）
             ├─ species/personality → personality card（services/persona.ts）
             └─ vector → buildMeshPrompt() → 3D 生成提示词
                        │
                        ▼
        POST /api/pet  → 立即返回 pet + jobId（pet.stage = 'egg'）
                        │
                        ├─ 异步 runGeneration()：queued → generating_mesh → texturing → rigging → ready
                        │   （真实 provider 走 submit + poll；Mock 走时间线）
                        │
                        └─ 前端轮询 GET /api/pet/generation/:jobId，用「孵化」动画掩盖等待
```

### 4.2 好感度循环

```
互动请求 ──▶ advanceStreak()（连续陪伴/重逢）
          ──▶ canPerform()（当日次数上限）
          ──▶ computeGain()（超限衰减 + 单日总上限 120）
          ──▶ applyGain()：写 AffectionLogEntry + 更新 pet.affection/level
          ──▶ refreshPetState()：想念值 → 情绪 → 情绪气泡
```

### 4.3 对话四层

```
用户输入 ──▶ screenUserInput()  前置安全过滤（命中 → 人设化挡回，不上模型）
          ──▶ 分层判定 layer='auto'
              ├─ instant → INSTANT_POOL 本地预设池（零延迟零成本）
              ├─ scene   → 时间/天气/地点模板填充
              └─ free    → buildSystemPrompt(档案卡+记忆+关系) → adapters/chat.ts → 大模型
          ──▶ screenModelOutput() 后置审核
          ──▶ 每 2/6 条消息提炼记忆摘要 + 关键事件
          ──▶ 好感度低收益累积
```

### 4.4 打卡链路

```
POST /api/travel/checkin
  ├─ adapters/image.ts compose()（带 masterId 角色锁定）
  ├─ 旅行盲盒抽签（按 petId+destination 确定性哈希）
  ├─ 时光机：上一次到访的回忆对比
  ├─ 剧情章节推进
  ├─ content.ts 生成手账 + 宠物视角明信片
  ├─ 好感度 +30（每地点一次）
  ├─ 心愿单解锁 + 城市限定皮肤解锁
  └─ memory.rememberEvent()（写记忆锚点，之后对话会主动提起）
```

---

## 5. 关键工程原则的落地位置（说明书第十章）

| 原则 | 落地位置 |
| --- | --- |
| 1. 资产母版唯一化 | `services/pet.ts` 只生成一次并写 `pet.asset.masterId`；`adapters/image.ts` 请求必带 `character_lock_id` |
| 2. 生成全异步 | `POST /api/pet` 立即返回 `jobId`；`runGeneration()` 后台推进；前端轮询 + 孵化动效 |
| 3. 对话分层 | `services/chat.ts` 的 `layer` 判定 + `INSTANT_POOL` 本地池，能本地解决的绝不上模型 |
| 4. 渲染可降级 | `PetStage.tsx` 用 `/api/asset/pet.svg`；`triangleBudget()` 按机型/档位限面数；`prefers-reduced-motion` 全局降级 |
| 5. 接口可替换 | `adapters/*` 的「Provider 数组 + configured + 回落」结构 |
| 追加：好感度不可购买 | `services/pet.ts` 的 `redeem()` 只扣好感度；`/api/shop` 无任何货币字段 |

---

## 6. 响应式策略（移动端 + 电脑端）

同一份组件树，两套排布：

| 断点 | 导航 | 布局 |
| --- | --- | --- |
| < 768px | 底部悬浮胶囊（宠物舱/小屋/旅途/打卡/我的 + 胶囊） | 单列沉浸；宠物展示区占 `52dvh`；Sheet 从底部升起 |
| ≥ 768px | 左侧固定侧栏（含当前宠物卡、好感度、接入状态） | 主内容双栏（`lg:grid-cols-cabin`）；≥ 1280px 额外显示宠物侧栏 |
| ≥ 1024px | 同上 | 内容区最大 1180px，避免超宽屏阅读困难 |

其他适配点：
- `dvh` 单位 + `env(safe-area-inset-bottom)` 处理移动端地址栏与刘海。
- 所有可点元素 ≥ 44×44px（视觉规范第 6 章第 4 条），用 `.rt-tap-target` 强制。
- `prefers-reduced-motion` 下关闭全部呼吸/眨眼/摇尾动画。
- 地图用 SVG 等距圆柱投影手绘，不引地图 SDK；接真实底图时只替换 `MapCanvas`。

---

## 7. 设计令牌流水线

```
packages/theme/src/tokens.ts        （唯一事实来源：色彩/圆角/字号/间距/阴影/动效/关键帧）
        │  node packages/theme/scripts/build-tokens.mjs
        ├─▶ packages/theme/src/tokens.json              （供设计工具消费）
        └─▶ apps/web/src/styles/tokens.css              （CSS 变量：hsl 三元组 + keyframes）
                    │
                    └─▶ packages/theme/src/tailwind-preset.cjs
                        （bg-surface-base / text-brand-secondary / ease-spring ...）
```

颜色统一输出 **hsl 三元组**（`36 33% 97%`），因此既支持 `bg-surface-base`，也支持 `bg-brand-primary/20` 的透明度修饰。

改颜色请改 `tokens.ts` 后跑 `npm run gen:theme`，不要手改 `tokens.css`。

---

## 8. 已知取舍与后续升级路径

| 现在的做法 | 什么时候必须换 | 换的成本 |
| --- | --- | --- |
| JSON 文件存储 | 并发写入 / 多用户 | 重写 repositories 22 个方法 |
| 单用户本地档案（无鉴权） | 上线 | 加鉴权中间件，把 `currentUser()` 换成会话用户 |
| 手绘 SVG 地图 | 需要真实底图与 POI | 替换 `MapCanvas` 组件 |
| SVG 降级形象 | 接入 3D 生成 | 替换 `PetStage` 的渲染层 |
| 无支付 | 商业化 | 实现 `/api/subscribe` 的真实通道 + 未成年人限额前置校验 |
| data URL 存图 | 上线 | 接对象存储 + CDN，补删除通道 |

---

## 9. 已验证的行为（自测记录）

```
✓ 问卷 8 题 → 偏好向量（confidence 计算、inferred 维度标注）
✓ 孵化流水线：22% → 51% → 77% → 100%，阶段文案随进度推进
✓ 好感度：喂饭 +8、洗澡 +12、陪玩 +15，第 4 次陪玩被拦（每日上限 3）
✓ 单日上限 120，超出部分 cappedGain 单独记录
✓ 连续陪伴里程碑（第 3/7/14/30 天）与重逢补偿
✓ 对话四层：instant 命中预设池、free 走人格模板
✓ 前置过滤：你是AI吗 / 你是不是机器人 → 人设化挡回，modelUsed = false
✓ 高风险：不想活了 → 触发支持渠道提示（showSupportResources = true）
✓ 回避话题：提到「洗澡」→ 含糊带过并拉回喜好话题
✓ 记忆：第 2 条消息起提炼摘要，容量上限 40（免费档）
✓ 打卡：+30 好感度、解锁徽章/皮肤/盲盒、生成剧情章节 + 手账 + 明信片
✓ 时光机：再次到访生成「上次来隔了 N 天」的对比回忆
✓ 时光胶囊：uploaded → analyzing → restoring → done，附带预期管理文案
✓ 云代养：托付记录 + 回来后的台词
✓ 订阅：模拟开通，price 按月/年正确
✓ 静态托管 + SPA 回退：/ 、/hut、hash 深链均 200
```

---

## 10. 本地开发速查

```bash
npm install                # 安装依赖（首次约 3 分钟）
npm run dev                # 同时起后端(8787) + 前端(5173)
npm run dev:server         # 只起后端
npm run dev:web            # 只起前端（/api 自动代理到 8787）

npm run typecheck          # 全量类型检查
npm run build              # 构建前端到 apps/web/dist
npm run gen:theme          # 重新生成设计令牌
npm start                  # 生产模式：后端同源托管前端构建产物
npm test                   # 运行单元测试
```
