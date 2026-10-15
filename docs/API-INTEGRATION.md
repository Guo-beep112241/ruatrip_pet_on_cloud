# RuaTrip 需要接入 API 的位置清单（API-INTEGRATION）

> 适用版本：RuaTrip（Rua途）v2.0
> 当前状态：**全部能力运行在 Mock 模式**，网站功能完整可用，但不产生真实 3D 资产、不调用真实大模型、不合成真实照片。
> 本文档逐条说明：**要在哪里改、配哪些 key、请求长什么样、失败怎么办、怎么验收**。

---

## 0. 一分钟总览

| # | 能力 | 状态 | 代码位置 | 需要的环境变量 |
| --- | --- | --- | --- | --- |
| 1 | 大模型对话 | ⬜ 待接入 | `apps/server/src/adapters/chat.ts` | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`（推荐国产）/ `ANTHROPIC_API_KEY`（备选） |
| 2 | 3D 形象生成 | ⬜ 待接入 | `apps/server/src/adapters/mesh.ts` | `TRIPO_API_KEY` 或 `MESHY_API_KEY` |
| 3 | 自动绑定骨骼 | ⬜ 待接入 | `apps/server/src/adapters/rigging.ts` | `ANYTHING_WORLD_API_KEY` |
| 4 | 语音合成 TTS | ⬜ 待接入 | `apps/server/src/adapters/tts.ts` | `MINIMAX_API_KEY` / `ELEVENLABS_API_KEY` |
| 5 | 语音识别 ASR | ⬜ 待接入（前端有浏览器兜底） | `apps/server/src/adapters/tts.ts` §ASR | `ASR_API_KEY` + `ASR_BASE_URL` |
| 6 | 图像合成 | ⬜ 待接入 | `apps/server/src/adapters/image.ts` | `IMAGE_COMPOSER_API_KEY` + `IMAGE_COMPOSER_BASE_URL` |
| 7 | 支付与订阅 | ⬜ 未实现 | `apps/server/src/index.ts` → `POST /api/subscribe` | `PAYMENT_*` |
| 8 | 对象存储 + CDN | ⬜ 未实现 | 新增 `apps/server/src/adapters/storage.ts` | `STORAGE_*` / `CDN_BASE_URL` |
| 9 | 推送通知 | ⬜ 未实现 | 新增 `apps/server/src/adapters/push.ts` | `PUSH_*` |
| 10 | 行为埋点 | ⬜ 未实现 | 新增 `apps/server/src/adapters/analytics.ts` | `ANALYTICS_WRITE_KEY` |

**统一约定**

- 所有密钥**只写在服务端** `.env`（复制 `.env.example`）。前端只拿到 `/api`，永远不会接触任何第三方密钥。
- 每个能力都是「Provider 数组 + `configured` 标记 + 回落」的结构。加一个供应商 = 加一个 class + push 进数组，**不需要改任何业务代码**。
- 任何真实通道失败都会**回落 Mock**，页面不会白屏、不会卡死，只在服务端日志和「我的 → 能力接入」面板标注降级。
- 接入进度可通过 `GET /api/integration` 或前端「我的 → 能力接入」实时查看。

---

## 1. 大模型对话（真心话小屋「自由层」）

**为什么需要**
说明书 6.2 要求：同一句用户输入，布偶猫和水豚的回答语气必须完全不同。这靠「性格档案卡 → system prompt → 大模型」实现。不接入时由 `MockLlmProvider` 用档案卡字段（口头禅 / 喜好 / 回避话题）拼装回复，人设成立但不够灵活。

**改哪里**
`apps/server/src/adapters/chat.ts`（一般不需要改代码，只改 `.env`）

### 1.1 三行配置切换任意供应商

通道叫「OpenAI 兼容」——只要厂商提供 OpenAI 格式的 `/chat/completions`，就能挂上。
**推荐用国产平台：可用支付宝/微信付款，不需要海外信用卡。**

```bash
LLM_API_KEY=你复制的 key
LLM_BASE_URL=<见下表>
LLM_MODEL=<见下表>
```

| 供应商 | `LLM_BASE_URL` | `LLM_MODEL` 示例 | 付款方式 | 取 key 位置 |
| --- | --- | --- | --- | --- |
| **DeepSeek**（性价比最好） | `https://api.deepseek.com` | `deepseek-flash` | 支付宝/微信 | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) |
| **智谱 GLM**（有免费档） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 支付宝/微信 | [bigmodel.cn](https://open.bigmodel.cn/) →  API Keys |
| **通义千问**（新用户免费额度大） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 支付宝 | [阿里云百炼控制台](https://bailian.console.aliyun.com/) → API-KEY 管理 |
| **Kimi** | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 支付宝/微信 | [platform.moonshot.cn](https://platform.moonshot.cn/console/api-keys) |
| **硅基流动**（部分模型 ¥0） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-8B` | 支付宝（需实名） | [cloud.siliconflow.cn/account/ak](https://cloud.siliconflow.cn/account/ak) |
| Anthropic Claude（备选，需海外卡） | `https://api.anthropic.com` | `claude-sonnet-4-5` | 海外信用卡 | 用 `ANTHROPIC_API_KEY`，不走本通道 |
| 自建 vLLM / Ollama | `http://localhost:8000/v1` | 你的模型名 | 免费 | 本地部署 |

**优先级**：`LLM_*` > `ANTHROPIC_*` > 本地 Mock。所以你配了国产模型就会立即生效，不会被残留的 Claude key 抢走。
`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 仍然可用，是 `LLM_*` 的向后兼容别名。

### 1.2 关于成本

以说明书描述的宠物对话为例，每轮约 800~1500 tokens。

- DeepSeek `deepseek-flash`：高峰时段 输入 ¥2 / 百万 tokens、输出 ¥8；**空闲时段（含周末与法定节假日全天）价格减半**。折算下来一轮对话不到 ¥0.01，充 ¥10 可以聊上千轮。
- 智谱 `glm-4-flash`、硅基流动的部分小模型是 ¥0 档（硅基流动需要中国/港澳台证件实名认证）。
- 想完全不花钱：先用免费档验证产品体验，需要长上下文或稳定高并发时再切付费档，只改 `.env` 一行。

### 1.3 实际请求

```
POST {LLM_BASE_URL}/chat/completions
Authorization: Bearer <LLM_API_KEY>

{
  "model": "deepseek-flash",
  "max_tokens": 300,
  "temperature": 1,
  "messages": [
    { "role": "system", "content": "<由人格档案卡自动拼装，见 services/persona.ts buildSystemPrompt>" },
    { "role": "user", "content": "今天有点累" }
  ]
}
```

**system prompt 是怎么来的**
`services/persona.ts` 的 `buildSystemPrompt()` 会把档案卡（物种、性格标签、说话节奏、口头禅、喜好、回避、小毛病）、关系状态（好感度等级、想念值）、**记忆锚点**、当下情境（时间/天气/地点）拼成规则化提示词，并内置 7 条说话规则（长度 ≤60 字、不承认自己是 AI、回避话题含糊带过、不给医疗建议、情绪低落时先安静陪伴等）。**不要手写 prompt**，改规则请改这个函数（说明书 3.2-6 的模板化要求）。

**注意 reasoning_content**：部分国产模型（含 DeepSeek 的思考模式）会先返回 `reasoning_content` 再返回 `content`。适配层只取 `content`，避免把内部思考念给用户；如果模型只返回思考内容而不给 `content`，会被判为空回复并回落 Mock。

### 1.4 失败怎么表现

错误会被翻译成「你能照着做」的提示，写在服务端日志与 `GET /api/integration` 的 `lastError` 里：

| 情况 | 错误码 | 提示 |
| --- | --- | --- |
| 密钥无效/无权限 | `LLM_AUTH_FAILED` | 检查 `.env` 里的 `LLM_API_KEY` |
| 余额不足 | `LLM_NO_BALANCE` | 去厂商控制台充值 |
| 模型名或地址不对 | `LLM_MODEL_NOT_FOUND` | 检查 `LLM_BASE_URL` 与 `LLM_MODEL` |
| 返回空内容 | `LLM_EMPTY_RESPONSE` | 视为失败，回落 Mock |

**任何失败都会回落 Mock，对话永不中断**，宠物照常回话，只是风格退回模板。

### 1.5 成本控制（说明书 3.2-5）

- 对话分四层：`instant` / `scene` 走本地预设池，**不上模型**；只有 `free` 层才调用接口。
- `services/chat.ts` 的 `sendMessage()` 里 `layer: 'auto'` 会自动判定。
- 记忆摘要有容量上限（免费 40 / Plus 120 / Pro 300 条），超出按重要性淘汰。
- 后置审核 `screenModelOutput()` 会拦掉「我是 AI / 语言模型」这类泄漏并回退成宠物口吻。

**验收**：连问三轮「今天有点累 / 我好喜欢你 / 你是不是 AI」，第三句必须被温柔带过；宠物回复不超过 3 句。
改完 `.env` **不需要重启服务端**（配置是惰性读取的），直接再问一次即可看到新模型生效。

## 2. 3D 形象生成（文字/图片 → 几何 + PBR 贴图）

**为什么需要**
说明书第四章的核心。当前 Mock 只登记资产母版元数据，前端用 `/api/asset/pet.svg` 渲染一个会呼吸的 2D 形象（这也是低端机的降级通道）。

**改哪里**
`apps/server/src/adapters/mesh.ts`

**推荐服务商**

| 供应商 | 环境变量 | 说明 |
| --- | --- | --- |
| Tripo AI（主力推荐） | `TRIPO_API_KEY` | 一次调用走完「文/图生 3D → 贴图 → 自动绑定」，链路短、成本低，适合 MVP |
| Meshy AI（双供应商备份） | `MESHY_API_KEY` | 工程成熟、有企业级合规；用来规避单点风险 |

**实际请求**

```
POST {TRIPO_BASE_URL}/task
Authorization: Bearer <TRIPO_API_KEY>

{
  "type": "text_to_model",            // 有参考图时 → "image_to_model"
  "model_version": "v2.5-20250123",
  "face_limit": 6000,                 // 移动端面数预算，按体型/订阅档位计算
  "texture": true,
  "pbr": true,
  "text_to_model": { "prompt": "<buildMeshPrompt() 的输出>" }
}
→ { "code": 0, "data": { "task_id": "..." } }

GET {TRIPO_BASE_URL}/task/{task_id}
→ { "data": { "status": "running", "progress": 42, "output": { "pbr_model": "https://..." } } }
```

Meshy 走 `POST /openapi/v2/text-to-3d` + `GET /openapi/v2/text-to-3d/{id}`，字段映射已经写好。

**提示词是怎么拼的**
`adapters/mesh.ts` 的 `buildMeshPrompt()`：物种 + 体型 + 毛感 + 配色 + 性格表情 + 风格约束（暖色午后光、无锐利高光、PBR、低面数、单一材质图集）。这是纯业务逻辑，不依赖任何外部服务（说明书 5.3 映射表）。

**必须守住的工程约束（说明书 3.2-1、第十章原则）**
1. **资产母版唯一化**：生成一次，写入 `pet.asset.masterId`，之后所有场景从母版派生，**禁止重新生成**。
2**生成全异步**：接口只返回 `jobId`，前端轮询 `GET /api/pet/generation/:jobId`，用「孵化」动画掩盖等待。
3. **面数/贴图/降级**：`triangleBudget()` 按体型与订阅档位限制面数；背景用预渲染图 + 轻量动态元素；低端机可切回 `/api/asset/pet.svg`。

**接入后前端要做什么**
把 `apps/web/src/components/PetStage.tsx` 里的 `<img>` 替换为 Three.js / React Three Fiber 渲染器，加载 `pet.asset.meshUrl`。建议保留 `<img>` 作为 `prefers-reduced-motion` 与低端机的降级路径。

**验收**：孵化平均耗时 < 90s；同一 `masterId` 在宠物舱、打卡合成、手账里外观一致；中端机 30fps 以上。

---

## 3. 自动绑定骨骼与动画

**为什么需要**
说明书 4.3 的明确风险：物种一旦超出猫狗，自动绑定失败率明显上升。

**改哪里**
`apps/server/src/adapters/rigging.ts`

**推荐服务商**

| 供应商 | 环境变量 | 说明 |
| --- | --- | --- |
| Anything World（关键推荐） | `ANYTHING_WORLD_API_KEY` | 专门面向非人形对象，覆盖大量动物，匹配「物种不限于猫狗」 |

**实际请求**

```
POST {ANYTHING_WORLD_BASE_URL}/api/v2/rig
Authorization: Bearer <ANYTHING_WORLD_API_KEY>

{ "model_url": "<meshUrl>", "auto_rig": true, "animations": ["idle-breathe", "eat-happy", ...] }
→ { "rigged": true, "skeleton": "quadruped", "animations": [...] }
```

**兜底策略（必须保留）**
`FallbackRigProvider` 会在绑定失败/超时/未接入时，按物种自动套用通用骨架（四足 / 双足 / 鸟类）与通用动作集，`job.stage = 'fallback_used'`。前端会把这件事诚实地告诉用户（「动作集略少，但体验不中断」），而不是假装成功。

**动作集**
`DEFAULT_ANIMATION_LIBRARY` 定义了 19 个动作 key（待机呼吸/眨眼/摇尾、进食、洗澡、陪玩、对话、情绪、重逢）。前端动画状态机按 key 播放；接入后请把这些 key 映射到你实际拿到的动画资源名。

**验收**：猫、狗、兔、水豚四类都能绑定成功；绑定失败时必须走兜底而不是报错中断。

---

## 4. 语音合成 TTS（宠物专属音色）

**为什么需要**
说明书 3.3-3：「声音是真实感的放大器」。每只宠物按性格分配音色。

**改哪里**
`apps/server/src/adapters/tts.ts`

**推荐服务商**

| 供应商 | 环境变量 | 说明 |
| --- | --- | --- |
| MiniMax（首选） | `MINIMAX_API_KEY`、`MINIMAX_GROUP_ID` | 中文情绪表现好 |
| ElevenLabs（备选） | `ELEVENLABS_API_KEY` | 准确率与速度优秀 |
| 浏览器 Web Speech（已实现兜底） | 无 | 零成本，但音色一般 |

**音色映射**（`VOICE_PRESETS`）：`lazy-bass` 慵懒低音 / `lively-treble` 活泼高音 / `soft` 软糯 / `husky` 沙哑。由性格标签自动推导（例如傲娇/高冷 → 低音，疯疯的 → 高音）。

**实际请求**

```
POST {MINIMAX_BASE_URL}/t2a_v2
Authorization: Bearer <MINIMAX_API_KEY>

{
  "model": "speech-02-hd",
  "text": "本喵恩准了",
  "stream": false,
  "voice_setting": { "voice_id": "male-qn-qingse", "speed": 0.86, "pitch": 0.85, "vol": 1 },
  "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "format": "mp3" }
}
```
MiniMax 返回 hex 编码音频，服务端已转成 `data:audio/mpeg;base64,...` 直接给前端播放。

**接口**：`POST /api/tts { petId, text }` → `{ audioUrl, useBrowserTts, voiceProfile, durationMsEstimate }`。

**验收**：`useBrowserTts: false` 且 `audioUrl` 非空；四只不同性格的宠物音色可区分。

---

## 5. 语音识别 ASR（按住说话）

**当前实现**：前端优先用浏览器 `SpeechRecognition`（零成本、低延迟），失败时提示「可在能力接入里配服务端 ASR」。
**什么时候需要服务端 ASR**：方言、口音容错，或浏览器不支持（iOS Safari 对 Web Speech 支持有限）。
**改哪里**：新增 `apps/server/src/adapters/asr.ts`，在 `POST /api/chat` 支持 `audioBase64` 字段；环境变量 `ASR_API_KEY` / `ASR_BASE_URL` / `ASR_MODEL`。
**验收**：录音 → 转写 → 走同一套对话分层逻辑，转写文本能正确进入前置安全过滤。

---

## 6. 图像合成（打卡同框 / AR 合影 / 明信片出图）

**为什么需要**
说明书 7.2-③⑧ 与 7.3：宠物要出现在你的实景照片里，并且**不能换脸**。

**改哪里**
`apps/server/src/adapters/image.ts`

**约定契约**（`POST {IMAGE_COMPOSER_BASE_URL}/compose`，可对接即梦 / 通义万相 / 自建 SD 服务）

```
Authorization: Bearer <IMAGE_COMPOSER_API_KEY>
{
  "scene_photo_url": "data:image/jpeg;base64,...",     // 用户现场拍的照片
  "character_reference_url": "<母版 baseColor 贴图或降级图>",
  "character_lock_id": "<masterId>",                   // ★ 角色锁定的关键
  "intent": "checkin-photo | ar-group-photo | postcard",
  "prompt": "Place the same 布偶猫 named 汤圆 into this scene. Scene: 三亚. Light direction 170°, ambient ..."
}
→ { "image_url": "https://..." }
```

**角色锁定的要求**：请求必须带 `masterId` 与母版参考图；服务端不得重新生成角色，只做「放到场景里 + 光影跟随」。换场景时 `lightAngle` / `ambient` 会跟着变（说明书 3.3-4），否则宠物会像贴上去的。

**未接入时的兜底**：`LocalComposeFallback` 用 SVG 按场景色板合成一张「宠物出镜照」，构图与文案真实、像素不真实，`degraded: true` 会透传。

**验收**：同一只宠物连续 3 次合成，毛色/花纹/体型比例肉眼一致；合成图的光影方向与场景一致。

---

## 7. 支付与订阅

**当前实现**：`POST /api/subscribe` 只写订阅状态、**不扣款**，响应里 `simulated: true`，前端会明确告知「模拟开通」。

**上线前必须做**
1. 接入 App Store / 微信支付 / 支付宝，校验收据；
2. 补未成年人保护：`user.minorGuardEnabled` + `user.monthlySpendLimit` 必须在支付前置校验；
3. **价值观红线**：好感度不可购买。任何新增的支付入口都不能绕过这一点（`services/pet.ts` 的 `redeem()` 只扣好感度）。

**代码位置**：`apps/server/src/index.ts` 的 `router.post('/api/subscribe', ...)`。

---

## 8. 对象存储与 CDN

**当前实现**：用户上传的照片以 data URL 存进本地 JSON（`.data/ruatrip.json`），只适合演示。
**上线前必须做**：接对象存储（S3 / OSS / COS / R2）保存用户照片、母版 GLB、PBR 贴图、合成图，并用 CDN + 版本号分发（`asset.version` 已预留）。
**需要的环境变量**：`STORAGE_ENDPOINT`、`STORAGE_BUCKET`、`STORAGE_ACCESS_KEY`、`STORAGE_SECRET_KEY`、`CDN_BASE_URL`。
**同时要做**：说明书 3.4-4 的「授权范围与删除通道」——用户必须能彻底删除上传的照片与生成结果。

---

## 9. 推送通知

**为什么需要**：说明书 3.1-2 的「想念值」机制要产生召回；异步 3D 生成完成也要通知。
**环境变量**：`PUSH_PROVIDER`、`PUSH_SERVER_KEY`。Web 端可先用 Notification API 做基础版。
**触发点（已在数据层预留）**：`pet.longing` 低于阈值、`job.stage === 'ready'`、连续陪伴里程碑、好友代养结束。

---

## 10. 行为埋点

**为什么需要**：说明书 2.5 风险 3 明确要求「好感度的数值曲线与实际留存数据挂钩，需要首版埋点验证」。
**环境变量**：`ANALYTICS_WRITE_KEY`。
**建议埋点**：问卷完成率、生成耗时与失败率、D1/D3/D7 回访、四项互动频次、好感度日收益分布、兑换点击到完成率、打卡转化、手账分享率。

---

## 11. 数据层替换（可选但推荐）

当前数据存在 `apps/server/src/db/store.ts`（原子写入的 JSON 文件），全部读写集中在 `apps/server/src/repositories/index.ts`。
替换为 Postgres / Supabase 时**只需重写 repositories 的 22 个方法**，services 与 routes 完全不用动。表结构对应 `StoreSchema` 的 15 个集合。

---

## 12. 接入后的自检清单

```bash
# 1. 复制并填写环境变量
cp .env.example .env

# 2. 启动后端，控制台会打印当前的接入模式与真实通道数
npm run dev:server

# 3. 查看完整清单（哪些已接入 / 哪些是 Mock）
curl -s localhost:8787/api/integration | python3 -m json.tool

# 4. 逐条验收
#    - 对话：连问三轮，看人设是否漂移、是否承认自己是 AI
#    - 3D：孵化耗时、资产母版一致性、低端机降级
#    - 绑定：非猫狗物种是否走兜底
#    - TTS：audioUrl 是否非空、音色是否可区分
#    - 图像合成：同一 masterId 三次出图外观一致
#    - 支付：是否仍然「好感度不可购买」
```

前端「我的 → 能力接入」面板会同步显示同样的状态，并支持一键复制环境变量模板。
