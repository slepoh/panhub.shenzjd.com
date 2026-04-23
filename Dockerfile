# 构建阶段（无 native 依赖，用 Alpine 减小体积）
FROM node:20-alpine AS builder
WORKDIR /app

# 启用 Corepack 并使用 pnpm（与项目一致）
RUN corepack enable && corepack prepare pnpm@9 --activate

# 先复制依赖文件，利用层缓存
COPY package.json pnpm-lock.yaml ./

# 安装依赖（frozen-lockfile 确保与 pnpm-lock 完全一致）
# 使用 BuildKit cache mount 加速 pnpm store 复用
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 复制源码并构建
COPY . .
RUN NITRO_PRESET=node-server pnpm run build

# 运行阶段：Alpine 仅 ~50MB
FROM node:20-alpine AS runner
WORKDIR /app

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NITRO_LOG_LEVEL=info

EXPOSE 3000

# 从构建阶段复制所有必要文件
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/package.json ./

# 创建 data 目录（用于 JSON 热搜持久化）
RUN mkdir -p /app/data && chmod 777 /app/data

CMD ["node", "--enable-source-maps", ".output/server/index.mjs"]
