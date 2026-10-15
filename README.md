# RuaTrip

> 给无法养真宠物的人，一个可以用 3D 真实感形象云养、能真心聊天、能一起旅行打卡、还能自动帮你做手账的**毛绒搭子**。
>
> 本仓库是《[RuaTrip 产品详细说明书 v2.0](docs/RuaTrip产品详细说明书-v2.0.md)》的完整可运行实现。
> **电脑端与移动端同一份代码，响应式适配。所有 AI / 3D / 语音能力都可选接入，未配置时自动回落本地 Mock，功能不缺失。**

---

## ⚡ 30 秒跑起来

```bash
cd RUATRIP_BEST_PET_FRIENDS
npm install        # 首次约 3 分钟
npm run dev        # 后端 http://localhost:8787 ＋ 前端 http://localhost:5173
```

打开 <http://localhost:5173> → 走完 8 道问卷 → 看它孵化 → 进宠物舱。

```bash
npm run build      # 构建前端
npm start          # 生产模式：后端同源托管前端，只需 http://localhost:8787 一个地址
npm test           # 32 个单元测试
npm run typecheck  # 全量类型检查
```

> 桌面端请把浏览器窗口拉到 ≥ 1024px 宽，会切换成左侧栏 + 双栏布局；手机上直接打开 5173 端口即可（Vite 已开 `host: true`）。

---

## 🚨 实际上线前需接入api_key

**当前状态：全部能力运行在 Mock 模式 —— 网站完整可用，但不产生真实 3D 资产、不调用真实大模型、不合成真实照片。**

一键查看当前状态：启动后端后访问 `GET /api/integration`，或打开前端「**我的 → 能力接入**」面板（会列出每一项、依赖的环境变量、并支持一键复制模板）。

| # | 能力 | 配哪些 key | 改哪个文件 |
| --- | --- | --- | --- |
| 1 | 大模型对话（真心话小屋自由层） | **推荐国产**：`LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`（DeepSeek / 智谱 / 通义 / Kimi / 硅基流动，**可用支付宝微信付款**）；备选 `ANTHROPIC_API_KEY` | `apps/server/src/adapters/chat.ts` |
| 2 | 3D 形象生成（文/图 → 几何 + PBR） | `TRIPO_API_KEY`（主力）和/或 `MESHY_API_KEY`（双供应商备份） | `apps/server/src/adapters/mesh.ts` |
| 3 | 自动绑定骨骼 + 动物动画 | `ANYTHING_WORLD_API_KEY` | `apps/server/src/adapters/rigging.ts` |
| 4 | 语音合成（宠物专属音色） | `MINIMAX_API_KEY` + `MINIMAX_GROUP_ID`（首选）/ `ELEVENLABS_API_KEY` | `apps/server/src/adapters/tts.ts` |
| 5 | 语音识别（按住说话） | `ASR_API_KEY` + `ASR_BASE_URL`（浏览器有兜底） | `apps/server/src/adapters/tts.ts` §ASR |
| 6 | 图像合成（打卡同框 / 明信片） | `IMAGE_COMPOSER_API_KEY` + `IMAGE_COMPOSER_BASE_URL` | `apps/server/src/adapters/image.ts` |
| 7 | 支付与订阅 | `PAYMENT_*`（**尚未实现**） | `apps/server/src/index.ts` → `POST /api/subscribe` |
| 8 | 对象存储 + CDN | `STORAGE_*` / `CDN_BASE_URL`（**尚未实现**） | 需新增 `adapters/storage.ts` |
| 9 | 推送通知（想念值召回 / 生成完成） | `PUSH_*`（**尚未实现**） | 需新增 `adapters/push.ts` |
| 10 | 行为埋点（验证好感度曲线与留存） | `ANALYTICS_WRITE_KEY`（**尚未实现**） | 需新增 `adapters/analytics.ts` |

**完整接入手册（含请求示例、推荐服务商对比、失败回落策略、验收清单）→ [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md)**

```bash
cp .env.example .env    # 然后填 key
npm run dev:server      # 启动日志会打印当前的接入模式与真实通道数量
```

**换模型只需改 `.env` 三行，不用改代码**：

```bash
# 例如换成 DeepSeek（可用支付宝付款）
LLM_API_KEY=sk-你的key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
```

智谱 `https://open.bigmodel.cn/api/paas/v4` + `glm-4-flash`、通义 `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`、
Kimi `https://api.moonshot.cn/v1` + `moonshot-v1-8k` 同理。完整对照表见接入手册。

**三条必须守住的线**

1. **密钥只在服务端**。前端只访问 `/api`，永远拿不到任何第三方 key。
2. **任何真实通道失败都回落 Mock**，页面不白屏、不卡死，只在日志和接入面板标注降级。
3. **好感度不可购买**。`services/pet.ts` 的 `redeem()` 只扣好感度，商店里没有任何货币字段——这是产品价值观的锚点。

---

## 🧭 功能与说明书的对应关系

| 页面 | 说明书章节 | 已实现 |
| --- | --- | --- |
| **宠物舱**（首页） | 6.1 / 6.3 | 沉浸式展示区、呼吸/眨眼/摇尾动画、点左右/下巴/尾巴不同反应、长按亲密互动、双击撒娇、四项互动操作、情绪气泡、衣橱/场景/商店浮层、一键合影入口 |
| **真心话小屋** | 6.2 | 四层对话（即时/场景/自由/记忆）、性格档案卡展示、记忆回看、按住说话、语音朗读、前置过滤 + 后置审核、情绪关怀与现实支持渠道提示 |
| **旅途** | 7.3 | 宠物心愿单、城市剧情副本进度、旅途手账时间轴、明信片工坊 |
| **打卡探索** | 7.2 | 打卡地图、定位、实景照片上传、宠物出镜合成、徽章墙、城市限定皮肤、旅行盲盒、旅行时光机、出行前播报 |
| **时光胶囊** | 3.4 / 八 | 旧照上传、毛绒复原进度、纪念相册、写给它、明确的预期管理文案（「不是它本人」）、安静的次级入口列表 |
| **我的** | 十一 / 2.5 | 成长数据网格、宠物档案（资产母版信息）、订阅档位、云代养/双宠同行、未成年人限额设置、**能力接入面板** |
| **首次使用流程** | 八 | 8 题问卷 → 偏好画像确认与命名 → 孵化动效 → 首见引导 → 喂饭/真心话/打卡/首篇手账 |

**产品层面几条被刻意实现的设计**

- **首日必须交付完整体验**：问卷提交后立刻生成宠物 + 自动发放心愿单，不出现空状态。
- **好感度是双向的**：引入「想念值」，久不登录会下降、回来有重逢补偿与专属动画。
- **宠物性格必须有缺点**：每只宠物生成 3~4 个小毛病（起床气、怕水、爱讲道理……），系统提示词里明确要求保留。
- **已逝宠物复原不做推荐位**：只在时光胶囊里安静地放着，需要用户自己找到。
- **好感度不单向上涨**：单日收益上限 120，超出部分衰减并单独记录（`cappedGain`）。

---

## 🏗️ 技术栈与结构

React 18 + TypeScript(strict) + Vite 6 + Tailwind CSS 3 ｜ 后端 Node 内置 `node:http` + `tsx`（**零框架依赖**）｜ npm workspaces

```
RUATRIP_BEST_PET_FRIENDS/
├── docs/                     产品说明书、视觉规范、接入手册、架构文档、线框图
├── packages/
│   ├── shared/               前后端共用：领域模型 + 静态目录 + 规则 + API 契约
│   └── theme/                设计令牌唯一来源 → 生成 CSS 变量 + Tailwind preset
└── apps/
    ├── server/               API 服务（adapters 换供应商 / services 业务规则 / repositories 换数据库）
    └── web/                  前端（6 个页面 + 响应式外壳）
```

详细设计见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**（含数据流图、关键工程原则的落地位置、响应式策略、升级路径）。

**为什么后端不引框架**：静态资源也由后端同源托管，所以生产环境只需要一个端口、一个命令。整个 workspace 只有 171 个 npm 包，`npm install` 3 分钟完成——第一阶段要验证的是「用户是否愿意每天回来」，不应该先被脚手架拖住。

---

## 📱💻 移动端与电脑端

| | 移动端（< 768px） | 电脑端（≥ 768px） |
| --- | --- | --- |
| 导航 | 底部悬浮胶囊（宠物舱/小屋/旅途/打卡/我的 + 胶囊） | 左侧固定侧栏，含当前宠物卡与好感度进度 |
| 布局 | 单列沉浸，宠物展示区占 52dvh | 主内容双栏；≥1280px 额外显示宠物侧栏 |
| 弹层 | 从底部升起的 Sheet | 居中卡片式 Sheet |

其他适配：`dvh` 单位与 `env(safe-area-inset-*)` 处理移动端地址栏与刘海；所有可点元素 ≥ 44×44px；`prefers-reduced-motion` 下关闭全部呼吸/眨眼/摇尾动画。

---

## 🎨 视觉规范

严格按《[毛绒实木 (Plush x Birch Wood)](docs/视觉设计规范-毛绒实木.md)》实现：

- **配色**：燕麦白底 `hsl(36 33% 97%)` / 暖栗棕 `hsl(20 35% 40%)` / 珊瑚橘 `hsl(10 100% 70%)`，文字用深棕木色而非纯黑
- **字体**：西文 Quicksand（几何圆体），中文 jf open 粉圆 + 系统安全字体兜底
- **动效**：统一 Spring 曲线 `cubic-bezier(0.34, 1.56, 0.64, 1)`，点击是物理下沉（`scale-[0.94]`）而不是变暗
- **组件配方**：`.rt-card` / `.rt-button` / `.rt-input` 直接对应规范第 4 章的四条配方

改颜色请改 `packages/theme/src/tokens.ts`，然后 `npm run gen:theme` 重新生成 CSS 变量与 Tailwind preset。

---

## 🧪 测试

```bash
npm test
```

32 个单元测试分三组：

- **规则层（10 个）**：好感度数值口径（次数上限、衰减、单日上限）、等级曲线、想念值区间、情绪推导优先级
- **安全层（13 个）**：人格卡生成、跨物种说话风格差异、system prompt 完整性、四类内容安全过滤（自我认知/医疗/成人/高风险）、后置审核泄漏清理、即时层预设池完整性
- **模型接入层（9 个，集成测试）**：起一个本地假模型端点，验证「换个模型就能用」这条路真的通 —— 请求格式、`reasoning_content` 不被误读、401/402/404 翻译成可照做提示、空回复判定、失败必回落 Mock、改 `.env` 免重启生效

端到端行为已手工验证并记录在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 9 节。

---

## 📋 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/bootstrap` | 首屏聚合：用户 + 宠物 + 接入清单 + 场景 + 引导进度 |
| GET | `/api/integration` | **接入状态报告**（哪些是真实通道、哪些是 Mock） |
| GET | `/api/catalog` | 物种 / 问卷 / 目的地 / 商店 / 订阅 / 场景 / 规则 |
| GET | `/api/asset/pet.svg` | 本地降级宠物形象（Mock 形象母版 + 低端机降级通道） |
| GET/POST | `/api/survey` | 问卷题目 / 提交并返回偏好画像 |
| GET/POST/PATCH | `/api/pet` | 查询 / 创建并开始孵化 / 改名换装换场景 |
| GET | `/api/pet/generation/:jobId` | 生成进度轮询（孵化动效的数据源） |
| GET | `/api/pet/mood` | 当前情绪与可用动作 |
| POST | `/api/interact` | 喂饭 / 洗澡 / 陪玩（次数限制 + 好感度结算） |
| POST | `/api/interact/pet` | 抚摸（头 / 下巴 / 尾巴，点击 / 长按 / 双击） |
| GET | `/api/affection` | 好感度总览、今日余额、连续陪伴进度 |
| GET/POST | `/api/shop` `/api/shop/redeem` | 好感度商店与兑换（不可购买） |
| GET/POST | `/api/chat` | 小屋历史 / 发送消息（四层对话 + 安全过滤） |
| GET | `/api/chat/memories` | 记忆回看与容量 |
| POST | `/api/tts` | 语音合成（未接入时返回浏览器兜底标记） |
| GET | `/api/travel` | 目的地 / 心愿单 / 打卡记录 / 徽章 / 手账 / 明信片 |
| POST | `/api/travel/checkin` | 打卡（合成图 + 剧情 + 盲盒 + 手账 + 明信片） |
| GET/POST | `/api/journal` `/api/postcard` | 手账与明信片生成 |
| GET/POST | `/api/capsule` `/api/capsule/:id` | 时光胶囊项目与复原进度 |
| GET/POST | `/api/foster` | 云代养 |
| GET/PATCH | `/api/profile` | 成长数据 / 设置 |
| POST | `/api/subscribe` | 订阅（当前为模拟开通） |

---

## 📄 文档索引

- [RuaTrip 产品详细说明书 v2.0](docs/RuaTrip产品详细说明书-v2.0.md) — 需求唯一事实来源
- [视觉设计规范 · 毛绒实木](docs/视觉设计规范-毛绒实木.md) — 视觉唯一事实来源
- [API 接入手册](docs/API-INTEGRATION.md) — **需要你介入 API 的全部位置**
- [技术架构](docs/ARCHITECTURE.md) — 数据流、工程原则落地、升级路径、自测记录
- [确认的信息架构](docs/confirmed-ia.json) / [线框图](docs/wireframe.jpg)
