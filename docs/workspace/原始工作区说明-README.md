# Workspace Guide

本工作区只包含一个交付物：**[RUATRIP_BEST_PET_FRIENDS](./RUATRIP_BEST_PET_FRIENDS)**。

RuaTrip（Rua途）v2.0 —— 给无法养真宠物的人，一个可以云养、能真心聊天、能一起旅行打卡、
还会自动做手账的毛绒搭子。移动端与电脑端同一份代码，响应式适配。

```bash
cd RUATRIP_BEST_PET_FRIENDS
npm install
npm run dev        # 后端 http://localhost:8787 ＋ 前端 http://localhost:5173
```

- 产品说明书：`RUATRIP_BEST_PET_FRIENDS/docs/RuaTrip产品详细说明书-v2.0.md`
- 视觉设计规范：`RUATRIP_BEST_PET_FRIENDS/docs/视觉设计规范-毛绒实木.md`
- **需要介入 API 的位置**：`RUATRIP_BEST_PET_FRIENDS/docs/API-INTEGRATION.md`
- 技术架构：`RUATRIP_BEST_PET_FRIENDS/docs/ARCHITECTURE.md`

目录结构：`apps/server`（API 服务）、`apps/web`（前端）、`packages/shared`（共用领域模型）、
`packages/theme`（设计令牌）。
