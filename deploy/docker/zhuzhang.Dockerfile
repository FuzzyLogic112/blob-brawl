# 筑账网页版（https://github.com/FuzzyLogic112/zhuzhang）
# 第一步用 Node 从源码构建出 docs/ 静态网页（含 PDF 识别所需的 pdf/ 资源），
# 第二步只把网页文件放进 Caddy 镜像，最终镜像里没有 Node 和源码。
FROM node:22-alpine AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY . .
RUN npm run build \
 && test -s docs/index.html \
 && test -f docs/pdf/pdf.worker.min.mjs

FROM caddy:2-alpine
COPY --from=build /src/docs /srv
