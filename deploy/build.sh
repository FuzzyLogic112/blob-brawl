#!/usr/bin/env bash
# 生成服务器安装包：dist/tuntun-brawl.tar.gz（内置 ws 依赖，服务器不用联网装 npm 包）
# 以及填好校验值的 dist/install.sh。两者发布到 gh-pages 分支根目录。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules/ws ] || npm install --omit=dev
rm -rf dist && mkdir -p dist/stage
cp -r public server package.json LICENSE README.md dist/stage/
mkdir -p dist/stage/node_modules && cp -r node_modules/ws dist/stage/node_modules/
rm -f dist/stage/public/.nojekyll
tar -C dist/stage -czf dist/tuntun-brawl.tar.gz --owner=0 --group=0 --sort=name --mtime='2026-01-01' .
SHA="$(sha256sum dist/tuntun-brawl.tar.gz | awk '{print $1}')"
sed "s/__PKG_SHA256__\"$/$SHA\"/" deploy/install.sh > dist/install.sh
grep -q "PKG_SHA256=\"$SHA\"" dist/install.sh
rm -rf dist/stage
echo "dist/tuntun-brawl.tar.gz  $(du -h dist/tuntun-brawl.tar.gz | cut -f1)  sha256=$SHA"
