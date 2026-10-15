# ============================================================
# RuaTrip（Rua途）v2.0 — 生产镜像
#
# 一个镜像同时提供前端页面与 API：前端构建产物由 Node 服务同源托管，
# 所以线上只需要「一个服务 + 一个端口」，没有跨域问题。
#
# 构建： docker build -t ruatrip .
# 运行： docker run -p 8787:8787 --env-file .env ruatrip
# ============================================================

# ---------- 构建阶段：装依赖 + 构建前端 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷清单，利用层缓存：依赖没变就不会重复安装
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/theme/package.json ./packages/theme/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm ci --no-audit --no-fund

# 再拷源码并构建前端
COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 数据目录容器内路径；要持久化就挂载卷到这里（见 docs/DEPLOYMENT.md）
ENV DATA_DIR=./.data

# 只搬运行期真正需要的：node_modules、代码、前端构建产物
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json

# 数据卷：JSON 存储落在这里（云平台挂载点）
RUN mkdir -p /app/.data
VOLUME ["/app/.data"]

# 非 root 运行
USER node

EXPOSE 8787
# 云平台会注入 PORT，服务端已按 PORT 环境变量监听
CMD ["npm", "start"]
