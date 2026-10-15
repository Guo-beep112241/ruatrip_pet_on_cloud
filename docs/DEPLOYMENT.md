# RuaTrip 上线部署指南（国内可直连）

> 目标：让别人**不用挂梯子**就能打开你的网站。
> 本文所有连通性结论都来自实测（2026-10，中国移动网络，单次采样）。不同运营商/地区会有差异，建议上线前自己复测一次。

---

## 1. 先看结论：为什么不推荐 Vercel

实测各平台**真实应用域名**的连通性（平台官网能开 ≠ 你的应用能开）：

| 域名类型 | 实测结果 | 说明 |
| --- | --- | --- |
| `*.vercel.app` | ❌ **建连 0 秒、10 秒超时（HTTP 000）** — 测了 3 个全部失败 | DNS 能解析（31.13.68.169），但 TCP 连不上。**这就是你必须挂梯子的原因** |
| `*.onrender.com` | ⚠️ 建连成功（1.1s），但返回 503 | 网络通；503 是免费实例休眠了，要冷启动 |
| `*.pages.dev` | ⚠️ 建连成功但返回 522 | Cloudflare 自己报源站连接失败 |
| `*.netlify.app` | ✅ HTTP 200，最快 0.23s | 可用 |
| `*.github.io` | ✅ HTTP 200，最快 0.38s | 可用 |
| 腾讯云 / 阿里云 | ✅ 0.11s / 0.17s | 国内最快 |

**结论**：`vercel.app` 在国内是被墙的，且**这一层限制无法通过配置绕过**——即使绑定自己的域名，Vercel 的 CDN 边缘节点仍会被干扰。所以不要在这上面花时间。

---

## 2. 推荐的两条路线

### 路线 A：国内云服务器 + Docker（最推荐，最便宜）

**为什么最推荐**：国内访问 0.1 秒级、没有跨域问题、没有休眠、一年几十到一百多块。

```bash
# 1. 买一台国内轻量应用服务器（腾讯云 / 阿里云 / 华为云都行）
#    配置：2核2G 足够；系统选 Ubuntu 22.04；带宽 3M 起步

# 2. 装 Docker
curl -fsSL https://get.docker.com | sh

# 3. 拉代码并构建
git clone <你的仓库地址> ruatrip && cd ruatrip
docker build -t ruatrip .

# 4. 启动（.env 里填你的 API key）
docker run -d --name ruatrip \
  -p 80:8787 \
  -v /opt/ruatrip-data:/app/.data \
  --env-file .env \
  --restart unless-stopped \
  ruatrip
```

现在 `http://你的服务器IP` 就能直接打开了。

**再做两件让体验完整的事**：

1. **绑域名**：买个 `.com` 域名（腾讯云/阿里云注册，约 ¥60/年，需实名认证 1~3 个工作日），在云厂商控制台加一条 A 记录指向服务器 IP。
2. **开 HTTPS（免费）**：
   ```bash
   # 用 Caddy 反向代理，自动申请并续期 Let's Encrypt 证书
   docker run -d --name caddy -p 443:443 -p 80:80 \
     -v /opt/caddy:/data caddy \
     caddy reverse-proxy --from 你的域名.com --to host.docker.internal:80
   ```

> ⚠️ **ICP 备案**：如果服务器是**中国大陆**的，域名必须完成 ICP 备案才能通过域名访问（用 IP 直接访问不受限，但有些省份会拦截）。备案免费，通过云厂商代提交，一般 7~20 个工作日。想省这一步就走路线 B。

---

### 路线 B：前端走免费静态托管 + 后端走 Render（免备案）

**适合**：先快速上线试水、不想买服务器、不想备案。

**分工**：

| 部分 | 放哪 | 为什么 |
| --- | --- | --- |
| 前端（静态产物） | **Netlify / GitHub Pages**（实测可直连） | 免费、快、免备案 |
| 后端 API | **Render**（实测网络可达） | 你的项目需要一个长驻 Node 进程，静态托管放不了 |

**步骤**：

1. **前端部署到 Netlify**
   ```bash
   cd apps/web
   npm ci && npm run build
   # 把 dist/ 拖到 https://app.netlify.com/drop 即可（最快）
   # 或者连 Git 仓库，配置：
   #   Base directory: apps/web
   #   Build command:  npm run build
   #   Publish dir:    dist
   ```
   构建时**必须**设置环境变量，否则前端会去请求自己的 `/api`：
   ```
   VITE_API_BASE_URL = https://你的后端.onrender.com/api
   ```

2. **后端部署到 Render**
   - 控制台 → New → **Blueprint** → 选你的仓库（会自动读 `render.yaml`）
   - 在环境变量里填 `CORS_ORIGIN = https://你的前端.netlify.app`
   - 部署完访问 `https://你的后端.onrender.com/api/health` 应返回 `{"ok":true,...}`

3. **如果你更想用 GitHub Pages 放前端**
   本项目是纯静态产物 + hash 路由（`#/cabin` 这种），**天然适合 GitHub Pages**，不需要额外配置 SPA fallback（hash 部分不发给服务器）。
   ```bash
   cd apps/web
   VITE_API_BASE_URL=https://你的后端.onrender.com/api npm run build
   # 把 dist/ 推到 gh-pages 分支
   npx gh-pages -d dist
   ```
   ⚠️ GitHub Pages 是**项目页**时地址形如 `https://用户名.github.io/仓库名/`，需要在 `vite.config.ts` 里设 `base: '/仓库名/'`，否则 JS/CSS 会 404。用自定义域名或用 `用户名.github.io` 仓库名可避免这个问题。

**路线 B 的已知短板**：

- ⚠️ **跨域**：前端和后端不同域，必须正确设置 `CORS_ORIGIN`，且前端要带完整后端地址。
- ⚠️ **Render 免费实例 15 分钟休眠**：第一个访问的人要等 ~50 秒冷启动。想避免就得升 `plan: starter`（约 $7/月）。
- ⚠️ **数据不持久**：见下一节，这是**必须解决**的问题。

---

## 3. 上线前必须解决的技术问题

### 3.1 🔴 数据会丢（最严重）

现在数据存在 `apps/server/src/db/store.ts` 写的单个 JSON 文件里。云平台的容器是**临时的**：

| 平台 | 后果 |
| --- | --- |
| Render 免费实例 | 每次重新部署 → 数据全丢 |
| Render 付费 + 挂载磁盘 | 可以持久（`render.yaml` 里已配好 disk） |
| Vercel / Netlify Functions | **完全不可用**，函数无状态且文件系统只读 |
| 国内云服务器 + Docker 挂卷 | ✅ 可以持久（路线 A 的命令里已带 `-v`） |

**真正该做的**：把 `apps/server/src/repositories/index.ts` 的 22 个方法改为读写数据库。这是唯一需要改动的文件，上层 service 和路由都不用动。

推荐方案（都有免费额度）：

- **Neon**（Serverless Postgres）— 免费 0.5GB，国内可连
- **Supabase**（Postgres）— 免费 500MB，自带管理后台
- **Turso**（SQLite 边缘）— 免费 9GB，适合这个数据量
- **腾讯云 / 阿里云 MySQL** — 如果你走路线 A，同机房内网连接最快

### 3.2 🔴 用户上传的照片会撑爆数据

现在打卡照片、旧照复原都是 **data URL 直接存进 JSON**。一张手机照片 base64 后有 3~5MB，存十几张文件就几十 MB，读写会明显变慢。

**上线前必须**：接对象存储（腾讯云 COS / 阿里云 OSS / Cloudflare R2），只把 URL 存进数据库。见 `docs/API-INTEGRATION.md` 第 8 节。

### 3.3 🟡 没有登录系统 = 所有人共用一个账号

现在 `currentUser()` 永远返回同一个本地用户。任何人打开你的网址，都会看到**同一只宠物、同一份好感度、同一批打卡记录**。

想真正对外发布，需要：
- 加登录（手机号验证码 / 微信登录 / 邮箱），把 `currentUser()` 换成会话用户
- 所有 repository 方法加 `userId` 过滤
- 加鉴权中间件，`/api/*` 校验身份

### 3.4 🟡 API 没有限流，会被刷爆钱包

`/api/chat` 每次都调用大模型。公开上线后如果有人写脚本狂刷，你的额度会瞬间归零。

**建议加**：
- 按 IP / 用户限流（如每分钟 20 次）
- 每用户每日对话次数上限（产品里已有「对话每日上限」的好感度规则，可以复用来做硬闸门）
- 在厂商控制台设置**用量告警和硬性预算上限**（DeepSeek、智谱都支持）

### 3.5 🟡 微信内置浏览器兼容性

你的用户大概率从微信点开链接。微信 WebView 对以下能力支持有限，建议实测：

- `SpeechRecognition`（按住说话）— 不能用，需要服务端 ASR 兜底
- `geolocation` 定位 — 需要 HTTPS，且可能被拒
- `<input capture="camera">` 拍照上传 — 一般可用，但表现和系统浏览器不同

### 3.6 🟡 国内网络调海外 API 会慢

- Anthropic / Tripo / Anything World 都在海外，国内访问延迟高、可能超时
- **建议**：对话用国内模型（DeepSeek / 智谱，见 `docs/API-INTEGRATION.md` 第 1 节），3D 生成如果 Tripo 太慢就考虑国内替代或降低生成频率

### 3.7 ⚪ 内容合规

公开提供生成式 AI 对话服务在国内涉及备案与内容安全要求。产品里已经做了前置/后置内容过滤（`services/persona.ts`），但正式运营前建议确认是否需要额外资质。**这是原则性提醒，不是法律意见，请咨询专业人士。**

---

## 4. 部署检查清单

```bash
# 1. 本地跑通全量检查
npm run typecheck && npm test && npm run build

# 2. 用生产模式本地验证一次（模拟线上）
PORT=8080 npm start
curl -s localhost:8080/api/health        # 应返回 {"ok":true,...}
# 浏览器打开 http://localhost:8080 走一遍完整流程

# 3. 确认 .env 没被提交
git status --porcelain | grep -q "\.env$" && echo "⚠️ .env 被跟踪了！" || echo "✓ .env 未被跟踪"

# 4. 部署后验证
curl -s https://你的地址/api/health
curl -s https://你的地址/api/integration | python3 -m json.tool   # 看能力接入状态
curl -s https://你的地址/ | head -5                               # 看前端是否正常返回

# 5. 手机实测（用流量，不要用 WiFi，才接近真实用户体验）
#    - 能否打开、加载多久
#    - 问卷 → 孵化 → 互动 → 打卡 → 手账，全链路走一遍
#    - 微信里点开链接再走一遍
```

---

## 5. 成本与选择建议

| 方案 | 月成本 | 国内速度 | 备案 | 数据持久 | 适合 |
| --- | --- | --- | --- | --- | --- |
| **国内轻量服务器 + Docker**（路线 A） | ¥30~80/年付更便宜 | ⚡ 0.1s | 要（用 IP 可免） | ✅ 挂卷 | **正式上线，首选** |
| Render 免费 + Netlify（路线 B） | ¥0 | 🐢 冷启动 50s | 免 | ❌ 需接数据库 | 先试水、给朋友看 |
| Render 付费 + 磁盘 | $7 | 🐢 海外延迟 | 免 | ✅ | 没时间折腾服务器 |
| Vercel | — | ❌ **被墙** | — | — | **不要用** |

**我的建议**：如果你只是想给几十个朋友看，走**路线 B** 就行，但一定要先把数据和图片从 JSON 里搬出去（3.1、3.2）。
如果你打算认真做、甚至以后让别人付费订阅，直接走**路线 A**——一年不到一百块，换来的是「打开就秒开」这个最基本的体验，比你花时间优化代码划算得多。
