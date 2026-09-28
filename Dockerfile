# 吞吞大乱斗 · 联机服务器镜像
#   构建：docker build -t tuntun-brawl .
#   运行：docker run -d -p 8080:8080 --restart unless-stopped tuntun-brawl
# 国内服务器默认用 npmmirror 安装依赖；海外可加 --build-arg NPM_REGISTRY=https://registry.npmjs.org
FROM node:22-alpine

ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY . .
# 从安装包构建时已经带了依赖，就不再联网安装
RUN if [ ! -d node_modules/ws ]; then \
      npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" && npm cache clean --force; \
    fi \
 && node -e "require('ws')"

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/server.js"]
