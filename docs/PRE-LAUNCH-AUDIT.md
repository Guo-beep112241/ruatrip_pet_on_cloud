# RuaTrip 上线前优化清单（审计结果 + 执行计划）

> 审计日期：2026-10
> 审计方式：逐项读代码 + 对运行中的服务发真实请求验证，不凭印象。
> 状态图例：`[ ]` 待做 ｜ `[x]` 已完成 ｜ `[-]` 本次不适用（需要商业决策或资质）

---

## 一、审计发现的真实缺陷

### 🔴 P0 —— 安全漏洞（公网暴露即被利用）

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| S1 | **SVG 注入** | `GET /api/asset/pet.svg?species=</text><script>alert(1)</script>` 能注入成功（已实测确认） | XSS；`image/svg+xml` 被浏览器当文档打开时执行脚本 |
| S2 | **CORS 白名单形同虚设** | `index.ts` 里 origin 不匹配时回落 `Access-Control-Allow-Origin: *`，同时带 `Allow-Credentials: true` | 任何站点都能带凭证调用你的 API；且 `*` + credentials 本身违反 CORS 规范 |
| S3 | **`.env` / `.git/config` 返回 200** | 实测 `/.env`、`/.git/config`、`/Dockerfile` 全部 200。内容虽是 index.html（源码在 `WEB_DIST` 外读不到），但**探测者无法区分「存在」与「不存在」** | 资产暴露面探测、CDN 缓存污染、被收录垃圾路径 |
| S4 | **无任何安全响应头** | 没有 CSP / X-Content-Type-Options / Referrer-Policy / X-Frame-Options | 点击劫持、MIME 嗅探、Referrer 泄漏 |
| S5 | **无限流** | `/api/chat` 每次都调大模型，无频率限制 | 被脚本刷爆模型额度（直接经济损失） |

### 🔴 P0 —— 上线阻塞（不改就无法对外发布）

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| B1 | **数据存在单个 JSON 文件** | `db/store.ts` 写 `ruatrip.json` | 云平台容器重启/重新部署 → 用户养了一个月的宠物全丢 |
| B2 | **无登录系统** | `currentUser()` 永远返回同一个 `user-local` | 所有访客共用一只宠物、同一份好感度、同一批打卡记录 |
| B3 | **照片以 data URL 存进 JSON** | 打卡照片、旧照复原都是 base64 | 一张手机照片 3~5MB，十几张就把 JSON 撑到几十 MB，读写迅速变慢 |
| B4 | **写入是同步阻塞的** | `Store.update()` 每次 `writeFileSync` 全量落盘 | JSON 越大越卡；几十 MB 时每次互动都卡住事件循环 |

### 🟠 P1 —— 会影响体验或维护成本

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| M1 | **无输入校验** | 15 处 `ctx.body as {...}` 直接强转 | 类型不符的值会一路流到业务层，产生难排查的错 |
| M2 | **上传体积与客户端校验不一致** | 服务端限 12MB JSON，客户端允许 6MB 文件（base64 后约 8MB + 包装） | 边界情况下用户会看到「上传内容太大」 |
| M3 | **无优雅退出** | 没有 SIGTERM 处理 | 部署滚动更新时可能丢最后一次写入 |
| M4 | **启动不校验配置** | 密钥填错只在第一次调用时才暴露 | 部署后才发现问题 |
| M5 | **无健康检查深度** | `/api/health` 只回 `{status:'up'}` | 存储不可用时平台仍认为服务健康 |
| M6 | **`index.ts` 708 行** | 路由与业务混在一起 | 维护成本；后续加鉴权会更容易出错 |
| M7 | **前端重复的 loading/error 处理** | 各页面各写一份 `try/catch` + toast | 改动容易漏 |

### 🟡 P2 —— 功能缺口（产品说明书要求但未实现）

| # | 问题 | 说明书位置 |
| --- | --- | --- |
| F1 | 支付与订阅（当前是模拟开通） | 十一 |
| F2 | 推送通知（想念值召回、生成完成） | 3.1-2 / 3.2-2 |
| F3 | 行为埋点（验证好感度曲线与留存） | 2.5 风险 3 |
| F4 | 情绪关怀的高强度使用检测（长时间停留、频繁提及离世） | 3.4-2 |
| F5 | 用户照片的删除通道（授权范围与删除） | 3.4-4 |
| F6 | 未成年人消费限额的实际校验（当前只存字段） | 2.5-7 |
| F7 | 语音对话的口型/表情同步 | 6.2 |
| F8 | 双宠同行的实际联网交互（当前只有托付记录） | 7.2-⑤ |
| F9 | 微信内置浏览器兼容（按住说话不可用、定位受限） | — |
| F10 | AR 同框合影（当前是后期合成） | 7.2-③ |

### ⚪ P3 —— 工程与运维

| # | 问题 |
| --- | --- |
| O1 | 缺 E2E 测试（页面交互只有手工验证记录） |
| O2 | 缺 CI（每次提交自动跑 typecheck + test + build） |
| O3 | 缺监控与错误上报（线上出问题只能看日志） |
| O4 | 缺数据备份策略 |
| O5 | 缺 `.nvmrc` / engines 严格约束 |

---

## 二、执行计划（分阶段，每阶段可独立验收）

### 阶段 1：安全加固 —— P0 漏洞（S1~S5）

- [x] **S1** SVG 注入：`species` / `palette` 白名单校验 + 文本插值全转义 + SVG 响应加 CSP
- [x] **S2** CORS：改为严格白名单，不匹配就不设 ACAO 头；去掉 `*` + credentials 的非法组合
- [x] **S3** 静态托管：拦掉点开头路径与敏感文件，返回 404 而不是 index.html
- [x] **S4** 安全响应头：CSP / X-Content-Type-Options / Referrer-Policy / X-Frame-Options / Permissions-Policy
- [x] **S5** 限流：滑动窗口限流中间件，对 `/api/chat`、`/api/travel/checkin` 等昂贵接口单独放宽/收紧

### 阶段 2：数据层与持久化（B1、B3、B4）

- [x] **B4** 写入改为「合并 + 防抖异步落盘」，并用临时文件+rename 保证原子性
- [x] **B1** 可插拔持久化驱动：SQLite（Node 内置，默认）/ Postgres / JSON 文件；落盘改为**按记录增量写入**（不再整文件重写）
- [x] **B3** 抽出 `Storage` 接口，实现本地磁盘与 S3 兼容（含 Cloudflare R2 / 腾讯云 COS）适配器；上传接口改为 multipart，不再往 JSON 塞 base64

### 阶段 3：账号体系与数据隔离（B2、F6）

- [x] **B2** 登录（邮箱/密码 + token）、`userId` 贯穿所有 repository 方法、鉴权中间件
- [x] **F6** 未成年人消费限额的实际校验点
- [x] **F5** 数据删除通道（账号注销 / 照片删除）

### 阶段 4：健壮性与可维护性（M1~M7）

- [x] **M1** 请求体校验：轻量 schema 校验器（零依赖），所有路由走校验
- [x] **M2** 上传限流与体积对齐（服务端 25MB、客户端 4MB，并给出明确提示）
- [x] **M3** SIGTERM/SIGINT 优雅退出，退出前 flush 数据
- [x] **M4** 启动时校验配置，密钥格式不对直接警告
- [x] **M5** `/api/health` 增加数据源与存储的真实探测
- [x] **M6** 拆分 `index.ts` 为按域的路由模块
- [x] **M7** 前端抽出统一的 `useApi` 数据请求 hook

### 阶段 5：产品功能补齐（F2、F3、F4、F9）

- [x] **F2** 推送通道抽象 + Web Notification 实现 + 想念值/生成完成触发点
- [x] **F3** 埋点抽象 + 本地缓冲实现 + 关键事件埋点
- [x] **F4** 情绪关怀：高强度使用检测与休息提示
- [x] **F9** 微信兼容：能力探测、降级提示、服务端 ASR 兜底路径

### 阶段 6：工程化与运维（O1~O5）

- [x] **O2** GitHub Actions CI（typecheck + test + build）
- [x] **O1** 关键链路的 E2E 冒烟测试（脚本化，非浏览器）
- [x] **O3** 错误上报抽象 + 结构化日志
- [x] **O4** 数据备份：JSON 导出接口 + 定时备份脚本说明
- [x] **O5** `.nvmrc` + engines 收紧

> **不做（需要商业决策或资质，不在本次范围）**：
> F1 真实支付通道（需要商户资质）、F7 口型同步（需要 3D 资源）、F8 双宠同行联网（需要真实的社交后端）、
> F10 真 AR（需要 WebXR + 原生能力）、ICP 备案与内容合规资质（需要你本人办理）。

---

## 三、验收标准

每个阶段完成后必须同时满足：

```bash
npm run typecheck   # 4 个 workspace 全绿
npm test            # 全部用例通过（含新增的回归测试）
npm run build       # 前端构建通过
npm start           # 生产模式端到端可用
```

并且阶段 1 的每个漏洞都要有**对应的自动化测试**，防止回归。

---

## 四、进度记录

| 阶段 | 状态 | 提交 |
| --- | --- | --- |
| 审计 | ✅ 完成 | — |
| 1 安全加固（S1~S5） | ✅ 完成 | `fix(security): 修复 SVG 注入、CORS 通配、敏感路径探测；加入安全头与双层限流` |
| 2 数据层与持久化（B1、B3、B4） | ✅ 完成 | `feat(persistence): 可插拔持久化驱动` + `feat(storage): 对象存储适配` |
| 3 账号体系（B2、F5、F6） | ✅ 完成 | `feat(auth)` + `feat(billing): 消费限额与宠物位配额` |
| 4 健壮性（M1~M7） | ✅ 完成 | `refactor(server): 路由拆分 + 启动校验` + `feat(web): useApi` |
| 5 产品功能补齐（F2、F3、F4、F9） | ✅ 完成 | `feat: 推送、埋点、情绪关怀、微信兼容` |
| 6 工程化（O1~O5） | ✅ 完成 | `chore(ci)` + `feat(observability): 结构化日志与错误上报` |

> 本表在每阶段完成后更新，并附上对应的 commit hash。

### 阶段 4/6 补充证据（M7 / O3）

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| M7 useApi | Profile 页改用 `useApi('/profile')` | loading/error/data 三态统一；卸载后不再 setState；请求竞态取最新一次 |
| O3 脱敏 | 传 `{password, LLM_API_KEY, text, content, photoUrl, nested:{text}}` | 全部替换为 `[redacted]`，嵌套层也生效；长字符串截断到 200 字符 |
| O3 JSON Lines | `NODE_ENV=production` 启动 | 输出可 `JSON.parse` 的单行 JSON，含 `level/time/msg/requestId/path/status/ms` |
| O3 开发可读 | 开发环境启动 | 输出 `! [reqId] message  path=/api/x` 而非 JSON |
| O3 请求串联 | 请求任意接口 | 响应带 `x-request-id`，访问日志与错误日志共用同一个 id |
| O3 错误分级 | 四类业务错误 | 400 / 404 / 404 / 403，服务端 **0 条 500 级日志** |
| O3 未登记告警 | 抛一个未登记的错误码 | 打警告提示补进 `http/errors.ts`，避免悄悄退化成 500 |
| O3 前端上报 | `POST /api/client-error` | 合法上报 200 并落日志；非法上报（缺崩溃信息）400 |

**修掉的两个问题**：
1. `DESTINATION_NOT_FOUND` 最初被归进 400 组，实测应为 **404**（资源类），
   已移到 NOT_FOUND 组 —— 这类归类错误会让前端拿到错误的状态码做错分支。
2. 前端上报字段原本叫 `message`，被日志脱敏规则命中而显示 `[redacted]`，
   真正的崩溃原因看不到。已改用专用字段名 `errorMessage`，
   既保住「`message` 可能含对话内容所以脱敏」这条规则，又能看到崩溃信息。

### 阶段 6 证据（O1 / O2 / O4 / O5）

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| O1 E2E 冒烟 | `apps/server/tests/e2e.test.ts` 15 个用例 | 覆盖说明书第八节完整主路径：注册 → 问卷（含跳题补全）→ 孵化 → 四项互动（含超限拦截）→ 对话四层（含安全拦截与记忆）→ 打卡 → 复访时光机 → 手账 → 好感度 → 商店 → 云代养/胶囊 → 订阅限额 → 通知/埋点 → 注销清数据 |
| O2 CI | `.github/workflows/ci.yml` | Node 22/24 双版本矩阵；typecheck → test → build → **生产模式冒烟**（真起服务并请求接口，能抓到「类型与测试都过但服务起不来」） |
| O4 备份 | `scripts/backup.mjs` | 实测产出 188K 备份（SQLite checkpoint + db/wal/shm + uploads），支持轮转保留 N 份；Postgres 走 pg_dump 的说明写在脚本头部 |
| O5 版本约束 | `.nvmrc` + `engines` | 收紧到 `node >= 22.5`（`node:sqlite` 的下限），避免在 22.5 以下静默回落文件驱动 |

**本轮修掉一个会误导用户与告警的真实缺陷**：
`services` 层抛业务错误时只写错误码（如 `new Error('NOT_ENOUGH_AFFECTION')`），
没带 status 的会被错误处理当成 **500**。后果有两层：
用户看到「服务器错误」而实际是「好感度不够」这种可理解的业务提示；
500 还会进错误日志与监控告警，把业务规则误报成系统故障。

已新增 `apps/server/src/http/errors.ts` 做集中映射（400/401/403/404/409/429/502），
并在错误处理里对**未登记的错误码**打警告，避免将来悄悄退化成 500。
实测四类业务错误现在分别是 400 / 404 / 404 / 403，服务端 0 条 500 级日志。

### 阶段 4 补充证据（M2 / M4 / M6）

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| M4 开发环境 | 缺 SESSION_SECRET 启动 | 打警告但正常启动（Mock 模式不受影响） |
| M4 生产环境 | `NODE_ENV=production` 启动 | **拒绝启动**，并一次列出全部问题（缺密钥 + CORS 留 localhost + 未配对象存储），而不是逐个试错 |
| M2 体积对齐 | 原始体上限改为「图片上限×2 + 1MB」 | 图片超限由 decodeImage 给出精确提示，而不是粗粒度的 payload too large |
| M2 客户端预检 | 新增 precheckImage | 非图片类型与超限提前拦下并说明 |
| M6 拆分 | `wc -l` | index.ts **1849 → 610 行**；路由拆为 12 个域模块（合计 1802 行）+ appContext（220 行） |
| M6 回归 | 全量测试 + 逐域接口连通 | 175 个测试全绿；8 个域接口全部正常响应 |

**M6 重构过程中暴露并修正的两处问题**：
1. 路由文件自动生成的导入路径少了一层 `../`（文件在 `src/routes/` 下），
   导致 `Cannot find module './config.ts'` 之类的连锁错误。
2. 生成脚本把原 index.ts 里位于 auth 区块**末尾**的 `SCHEMAS` 与 `check` 定义
   一并搬进了 `routes/auth.ts`，形成重复定义。已在 `routes/schemas.ts` 里统一提供。

### 阶段 5 的验证证据（F2 / F3 / F4 / F9）

`apps/server/tests/care-analytics.test.ts`（21 个）+ 真实 HTTP 验证：

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| F4 高强度提示 | 连点摸头 | 第 80 次触发 `intense`，文案为宠物口吻 |
| F4 不唠叨 | 触发后再点 40 次 | 重复提示 0 次（同信号一天只一次） |
| F4 悲伤优先 | 连续 3 次提及离世话题 | 触发 `care.support_resources`，附现实支持渠道 |
| F3 隐私 | 检查导出事件 | 只有事件名 + 时间 + userId + 白名单 props，无对话内容/照片/名字 |
| F3 白名单 | 传 `{message:'...'}` | 被过滤掉（自由文本进不了埋点） |
| F2 生成完成通知 | 孵化完成后查通知列表 | 收到「汤圆准备好了」，通道标注为 local |
| F2 不假装投递 | 未配真实通道 | `channel: 'local'` + 明确说明「离开应用收不到」 |
| F9 能力探测 | 微信 UA / 非 HTTPS | 列出各能力的实际状态与降级方式 |
| F9 非 HTTPS 警告 | 非安全上下文 | 明确提示定位/麦克风/摄像头会被禁用 |

**修复过程中发现的一个设计冲突**：
关怀阈值原本设 120 次/30 分钟，而速率限流是 120 次/分钟 ——
**限流永远会先拦住用户，关怀代码成为永远触发不到的死代码**。
已把阈值改为 80 次/30 分钟（对正常使用仍是很高的量），
并补了断言「阈值必须低于限流上限」防止将来再次出现这个错配。

**另外修掉**：`actionCount` 最初取的是「单个动作的计数」而不是「今日总活动量」，
导致无论怎么连点都到不了阈值（每次只 +1 到各自的计数器）。

### 阶段 4 的验证证据（M1 / M3 / M5）

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| M1 类型不符被拒 | `{petId: 123}`、`{action:'drop-table'}`、`{lat:999}` | 全部 400，并说明具体字段与原因 |
| M1 非对象请求体 | 传字符串 `"just a string"`、数组 `[1,2,3]` | 400「请求体必须是一个 JSON 对象（收到 string/array）」 |
| M1 权限提升防线 | `PATCH /api/profile {tier:'pro', petSlots:99, nickname:'正常'}` | 200，但 tier 仍为 free、petSlots 仍为 1，只有 nickname 生效 |
| M1 校验优先级 | `POST /api/chat` 传超长文本 + 不存在的 petId | 报「内容不能超过 500 个字符」而不是「宠物不存在」 |
| M3 优雅退出 | 建宠物后立即发 SIGTERM | 日志显示「数据已落盘，驱动已关闭」，进程退出 |
| M3 落盘完整性 | 重启后登录 | 宠物「优雅」仍在 —— 证明 SIGTERM 时确实 flush 了防抖中的数据 |
| M5 健康检查 | `GET /api/health` | 返回 driver、dataBytes、以及 persistence/lastWrite/storage/llm 四项探测结果；核心不可用时返回 503 |

**本次修掉的一处真实缺陷**：
`validate` 最初把非对象请求体当成空对象处理，导致 `POST /api/chat` 传字符串时
必填校验被绕过（报的是「缺少 petId」而不是「请求体格式错」）。已改为直接拒绝。

### 阶段 3 的验证证据（F5 / F6 部分）

`apps/server/tests/billing.test.ts`（20 个）+ `isolation.test.ts` 的真实 HTTP 用例：

| 验证项 | 结果 |
| --- | --- |
| 未成年人单笔上限 ¥50 | 年付 Pro（¥398）被拒 `MINOR_SINGLE_PURCHASE_LIMIT` |
| 未成年人月限额硬封顶 | 把限额设成 99999 也会被钳到 ¥500 |
| 月限额累计 | 连续续订，剩余额度从 ¥175 递减到 ¥75 |
| 免费档只能养 1 只 | 第 2 只被拒 `PET_SLOT_LIMIT`，并提示订阅 Plus |
| 档位配额不可被脏数据放大 | `recordedSlots=99` 时仍按档位取上限 |
| 降级保护 | 已有 2 只时降到免费档被拒 `TIER_DOWNGRADE_BLOCKED` |
| 未接支付 | `simulated: true` 明确透传，且**不绕过**限额校验 |
| 好感度兑换 | 金额 0，不占消费额度 |

**修复过程中发现的一个真实死锁**：免费档用户被 `TIER_NOT_ALLOWED` 挡住，
**永远无法订阅升级**。已给 `checkSpend` 增加 `action` 语义：
`subscribe`（升级，免费档也放行）与 `purchase`（买单品，免费档拒绝）。

**顺带修掉的两个误导**：
1. 「宠物位已满」被每日闸门（2 次/天）抢先拦成「今天次数用完」，
   明天的结果还会是失败 —— 已调整校验顺序为「配额优先」，并把
   `petCreate` 每日上限提到 6（真正的约束是宠物位，日限额只防异常刷量）。
2. `DAILY_QUOTA_EXCEEDED` 之前没有 detail，用户只看到「今天的额度用完了」
   却不知道是哪个额度 —— 现在会说明具体是什么、上限多少、何时重置。

### 阶段 3 的验证证据（B2 部分）

用真实 HTTP 请求在随机端口验证（`apps/server/tests/isolation.test.ts`，13 个用例）：

| 验证项 | 结果 |
| --- | --- |
| 匿名访问受保护接口 | 全部 401 `AUTH_REQUIRED` |
| 伪造/篡改 token | 全部 401 `INVALID_SESSION` |
| 越权读（8 个读接口带别人的 petId） | 全部 404 `PET_NOT_FOUND` |
| 越权写（9 个写接口针对别人的宠物） | 全部 404/400 被拒 |
| 越权访问他人时光胶囊 | 404 |
| 受害者数据未被篡改 | 宠物名、好感度不变 |
| 攻击者空间独立 | 看不到任何宠物 |
| 改密码后旧 token | 401 `SESSION_REVOKED` |
| 注销账号 | 需确认串 + 密码，数据清空，邮箱可再次注册 |

**修复过程中发现的两个真实 bug**：
1. `sqliteFile` 的默认路径写死成 `REPO_ROOT/.data/ruatrip.db`，
   **完全忽略了 `DATA_DIR`** —— 意味着测试会污染真实数据库，
   生产上把数据放到挂载盘也不生效。已改为跟随 `DATA_DIR`。
2. 认证的匿名回落原本是「库里只有 1 个账号就放行」，
   这会让「刚注册第一个用户的真实部署」被匿名访问。
   已收紧为「仅遗留占位账号（@legacy.local）且在 AUTH_MODE=optional 下」。
   `AUTH_MODE` 默认值也从 optional 改为 **required**。
3. `DELETE` 请求的 body 之前未被解析，导致注销接口拿不到确认串。

### 阶段 2 的验证证据

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| B3 对象存储 | `POST /api/upload` 传 PNG，再用返回 URL 取回 | 200，`cmp` 逐字节一致 |
| B3 不再内嵌 base64 | 清空数据后重跑打卡 | 数据文件 **316 字节**（修复前：13.5MB，其中 13.5MB 全是内嵌图片） |
| B3 堵住绕过口 | 直接向 `/api/travel/checkin` 塞 200KB data URL | 400 拒绝，提示改用 `/api/upload` |
| B3 拒绝伪装文件 | 上传文本文件并谎称 `image/jpeg` | 400，按魔数识别为非图片 |
| B3 拒绝超限 | 上传 5MB PNG | 400，提示压缩到 4MB 以内 |
| B4 防抖合并 | 连续 20 次变更 | 只触发一次落盘，最后一次值正确 |
| B4 原子写入 | 检查 `.tmp` | 无残留；50KB 数据完整读回 |
| B4 不崩 | 删除数据目录后再写 | 不再产生 unhandledRejection（Node 下会终止进程） |

### 阶段 2 补充：B1 的验证证据

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| 重启不丢数据 | 建宠物 + 打卡 → 杀进程 → 重启 | 宠物 ID、好感度 30、打卡/手账/明信片/徽章/记忆全部一致 |
| 增量写入 | 检查 diff 计算 | 只写变化的记录；未变化的集合不产生写入 |
| SQLite 事务 | 一批变更写入 | BEGIN/COMMIT 包裹，失败回滚 |
| 驱动优先级 | auto 模式判定 | `postgres://` → Postgres；`file:` 或无 → SQLite；Node < 22.5 → 回落文件 |
| 密码不外泄 | 检查启动日志描述 | 连接串里的密码被替换为 `***` |

**修掉一个会在重启后导致接口 500 的 bug**：
SQLite 的单例表（`meta`）在还没有数据时，`load()` 返回 `meta: null`。
原来的 `{...emptyStore(), ...loaded}` 展开运算会用这个 null 覆盖掉默认的 `{}`，
导致 `getMeta()` 读 `null.streakDays` 直接抛异常 —— 也就是**每次重新部署后
所有涉及 meta 的接口都会 500**。已改为显式的 `mergeSchema()`：逐字段校验形态，
null/非法类型一律回落默认值，并为每个集合保证是数组。

**本次修复过程中发现的连带问题**：
- `void this.flush()` 在防抖定时器里失败会变成 **unhandledRejection**，Node 默认终止进程。
  容器关闭时数据目录消失正好触发这个路径 → 已改为在定时器内 catch，并区分 ENOENT 与真实错误。
- `buildKey` 拼接前缀时产生双斜杠（`pets/checkin` → `petscheckin/`），
  且本地 URL 与读取路由路径不一致（`/uploads/...` vs `/api/uploads/:owner/:file`）→ 已统一为
  键格式 `<ownerId>/<random>.<ext>`，URL 与路由一一对应。

### 阶段 1 的验证证据

每条缺陷都补了自动化回归测试（`apps/server/tests/security.test.ts`，18 个用例），
并且对**运行中的服务发了真实请求**验证：

| 缺陷 | 验证方式 | 修复后结果 |
| --- | --- | --- |
| S1 SVG 注入 | `?species=</text><script>alert(1)</script>` | script 标签数 = 0；白名单外一律回落默认形象 |
| S2 CORS 通配 | 带 `Origin: https://evil.example.com` 请求 | 不返回任何 `Access-Control-*` 通配头（浏览器自行拦截） |
| S3 敏感路径 | 遍历 `/.env`、`/.git/config`、`/Dockerfile`、`/backup.sql` | 全部 404；前端路由与静态资源不受影响 |
| S4 安全头 | 检查响应头 | nosniff / DENY / Referrer-Policy / Permissions-Policy / CSP 全部就位 |
| S5 限流 | 连打 `/api/chat` 25 次 | 第 21 次返回 429（额度 20/分钟），带 `Retry-After` 与额度头 |

**加 CSP 时发现并修复的两个连带问题**（这类问题只有真在浏览器里跑才会暴露）：
1. Google Fonts 的样式表被 `style-src` 拦掉 → 放行 `fonts.googleapis.com`
2. 我最初写的 `onload="this.media='all'"` 内联事件被 CSP 拦掉 → 改为由 `main.tsx` 切换 media，
   避免为此放开 `script-src 'unsafe-inline'`（那等于给 XSS 开后门）

顺手修掉的兼容性问题：Node 的类型剥离模式不支持 TS「构造函数参数属性」，
全项目 3 处已改为显式字段声明（否则 `npm test` 一 import 就报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
