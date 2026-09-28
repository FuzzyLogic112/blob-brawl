#!/usr/bin/env bash
# 多项目 Docker 部署：吞吞大乱斗（必装）+ 筑账（可选）（Debian 11/12、Ubuntu 20.04+，国内服务器可用）
#
# 只装游戏（root 执行）：
#   curl -fsSL https://fuzzylogic112.github.io/blob-brawl/install-docker.sh | bash -s -- --game game.xwj0.cn [--email 你的邮箱]
# 以后加上筑账（游戏的设置会沿用）：
#   curl -fsSL https://fuzzylogic112.github.io/blob-brawl/install-docker.sh | bash -s -- --zhuzhang zhuzhang.xwj0.cn
# 更新到最新版本（域名会沿用上次的设置）：
#   curl -fsSL https://fuzzylogic112.github.io/blob-brawl/install-docker.sh | bash
#
# 做的事情：
#   1. 装筑账、内存小于 3G 且没有交换分区时，建一个 2G 交换文件（构建筑账网页时需要）
#   2. 从阿里云镜像站安装 Docker，配置多个 Docker Hub 镜像加速（一个失效会自动换下一个）
#   3. 下载项目的最新代码，构建镜像（构建失败时正在运行的网站不受影响）
#   4. 如果之前用 install.sh 装过（systemd + Nginx），停用它们，改由 Docker 运行
#   5. 启动 Caddy 网关，自动申请并续期各个域名的 HTTPS 证书
#
# 高级选项（环境变量）：
#   DOCKER_MIRRORS   Docker Hub 镜像加速地址，逗号分隔；设为 none 表示不配置（海外服务器）
#   NPM_REGISTRY     构建时使用的 npm 源，默认 https://registry.npmmirror.com
#   GITHUB_PROXY     拉取筑账源码时加在 GitHub 地址前面的代理前缀（GitHub 连不上时使用）
#   UPDATE_BASE=1    重新拉取 node / caddy 基础镜像（默认已存在就不再拉取）
#   SITES_DIR        安装目录，默认 /opt/sites
set -euo pipefail

SITES_DIR="${SITES_DIR:-/opt/sites}"
BASE_URL="${TUNTUN_BASE_URL:-https://fuzzylogic112.github.io/blob-brawl}"
PKG_SHA256="__PKG_SHA256__"
ZHUZHANG_GIT="${ZHUZHANG_GIT:-https://github.com/FuzzyLogic112/zhuzhang}"
ZHUZHANG_REF="${ZHUZHANG_REF:-main}"
GITHUB_PROXY="${GITHUB_PROXY:-}"
DOCKER_MIRRORS="${DOCKER_MIRRORS:-https://docker.1ms.run,https://docker.m.daocloud.io,https://docker.xuanyuan.me}"
DOCKER_CE_MIRROR="${DOCKER_CE_MIRROR:-https://mirrors.aliyun.com/docker-ce}"
BASE_IMAGES=(node:22-alpine caddy:2-alpine)

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }
valid_domain() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }

# ---------- 参数 ----------
GAME_DOMAIN=""; ZHUZHANG_DOMAIN=""; EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --game|--zhuzhang|--email)
      [ $# -ge 2 ] || die "$1 后面要跟一个值"
      case "$1" in --game) GAME_DOMAIN="$2";; --zhuzhang) ZHUZHANG_DOMAIN="$2";; --email) EMAIL="$2";; esac
      shift 2;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0;;
    *) die "不认识的参数：$1（用法：--game 游戏域名 [--zhuzhang 筑账域名] [--email 邮箱]）";;
  esac
done
if [ -f "$SITES_DIR/.env" ]; then   # 更新时沿用上次的设置
  # shellcheck disable=SC1091
  PREV_GAME="$(. "$SITES_DIR/.env"; echo "${GAME_DOMAIN:-}")"
  PREV_ZHUZHANG="$(. "$SITES_DIR/.env"; echo "${ZHUZHANG_DOMAIN:-}")"
  PREV_EMAIL="$(. "$SITES_DIR/.env"; echo "${ACME_EMAIL:-}")"
  PREV_NPM="$(. "$SITES_DIR/.env"; echo "${NPM_REGISTRY:-}")"
  GAME_DOMAIN="${GAME_DOMAIN:-$PREV_GAME}"; ZHUZHANG_DOMAIN="${ZHUZHANG_DOMAIN:-$PREV_ZHUZHANG}"; EMAIL="${EMAIL:-$PREV_EMAIL}"
fi
[ -n "$GAME_DOMAIN" ] || die "请带上游戏的域名，例如：bash -s -- --game game.xwj0.cn"
valid_domain "$GAME_DOMAIN" || die "游戏域名格式不对：$GAME_DOMAIN"
if [ -n "$ZHUZHANG_DOMAIN" ]; then
  valid_domain "$ZHUZHANG_DOMAIN" || die "筑账域名格式不对：$ZHUZHANG_DOMAIN"
  [ "$GAME_DOMAIN" != "$ZHUZHANG_DOMAIN" ] || die "两个项目需要用不同的域名"
fi
[ -z "$EMAIL" ] || [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "邮箱格式不对：$EMAIL"
NPM_REGISTRY="${NPM_REGISTRY:-${PREV_NPM:-https://registry.npmmirror.com}}"

[ "$(id -u)" -eq 0 ] || die "请用 root 用户执行（或在命令前加 sudo）"
command -v apt-get >/dev/null || die "这个脚本只支持 Debian / Ubuntu"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in debian|ubuntu) ;; *) die "这个脚本只支持 Debian / Ubuntu，当前系统：${PRETTY_NAME:-未知}";; esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------- 1. 内存 ----------
say "1/7 检查内存和磁盘"
MEM_MB=$(awk '/^MemTotal/{print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/^SwapTotal/{print int($2/1024)}' /proc/meminfo)
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
echo "内存 ${MEM_MB}MB，交换分区 ${SWAP_MB}MB，系统盘剩余 ${FREE_GB}GB"
[ "$FREE_GB" -ge 3 ] || die "系统盘剩余空间不足 3GB"
if [ -n "$ZHUZHANG_DOMAIN" ] && [ "$MEM_MB" -lt 3000 ] && [ "$SWAP_MB" -lt 500 ] && [ ! -e /swapfile ] && [ "$FREE_GB" -ge 8 ]; then
  if { fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; } \
     && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "已创建 2G 交换文件 /swapfile"
  else
    rm -f /swapfile; warn "交换文件创建失败，构建时内存可能偏紧"
  fi
fi

# ---------- 2. Docker ----------
say "2/7 安装 Docker"
export DEBIAN_FRONTEND=noninteractive
NEED_PKGS=()
for p in curl ca-certificates git python3 gnupg; do dpkg -s "$p" >/dev/null 2>&1 || NEED_PKGS+=("$p"); done
if [ ${#NEED_PKGS[@]} -gt 0 ]; then apt-get update -qq; apt-get install -y -qq "${NEED_PKGS[@]}" >/dev/null; fi
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "已安装：$(docker --version)，$(docker compose version)"
else
  if dpkg -s docker.io >/dev/null 2>&1; then
    die "系统装的是 Debian 自带的 docker.io，缺少 compose 插件。请先执行 apt-get remove -y docker.io 再重新运行本脚本"
  fi
  ARCH="$(dpkg --print-architecture)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "$DOCKER_CE_MIRROR/linux/$ID/gpg" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] $DOCKER_CE_MIRROR/linux/$ID ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker 安装失败"
  echo "已安装：$(docker --version)"
fi
docker info >/dev/null 2>&1 || systemctl start docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "Docker 服务没有运行（systemctl status docker 查看原因）"

# ---------- 3. 镜像加速 ----------
say "3/7 配置 Docker Hub 镜像加速"
if [ "$DOCKER_MIRRORS" = "none" ]; then
  echo "按设置跳过"
else
  mkdir -p /etc/docker
  set +e
  CHANGED="$(python3 - /etc/docker/daemon.json "$DOCKER_MIRRORS" <<'PY'
import json, os, sys
path, mirrors = sys.argv[1], [m.strip() for m in sys.argv[2].split(',') if m.strip()]
conf = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    try:
        conf = json.load(open(path))
    except Exception:
        sys.exit(3)
changed = False
if mirrors and not conf.get('registry-mirrors'):
    conf['registry-mirrors'] = mirrors; changed = True
if 'log-opts' not in conf and conf.get('log-driver', 'json-file') == 'json-file':
    conf['log-driver'] = 'json-file'; conf['log-opts'] = {'max-size': '10m', 'max-file': '3'}; changed = True
if changed:
    with open(path, 'w') as f:
        json.dump(conf, f, indent=2)
    print('changed')
PY
)"; RC=$?
  set -e
  if [ $RC -eq 3 ]; then
    warn "/etc/docker/daemon.json 格式有误，没有改动它"
  elif [ "$CHANGED" = "changed" ]; then
    systemctl restart docker || true
    for i in $(seq 1 15); do docker info >/dev/null 2>&1 && break; sleep 1; done
    docker info >/dev/null 2>&1 || die "Docker 重启失败（systemctl status docker 查看原因）"
    echo "已写入 /etc/docker/daemon.json 并重启 Docker"
  else
    echo "daemon.json 里已有镜像加速配置，保留不动"
  fi
fi

pull_base() {
  local img="$1" i
  if [ "${UPDATE_BASE:-0}" != "1" ] && docker image inspect "$img" >/dev/null 2>&1; then echo "$img 已存在"; return 0; fi
  for i in 1 2 3; do
    if docker pull -q "$img" >/dev/null; then echo "$img 下载完成"; return 0; fi
    warn "$img 第 $i 次下载失败，5 秒后重试"; sleep 5
  done
  return 1
}
for img in "${BASE_IMAGES[@]}"; do
  pull_base "$img" || die "基础镜像 $img 下载失败。国内的镜像加速地址经常变化，可以换一组再试：DOCKER_MIRRORS=地址1,地址2 bash install-docker.sh ...（先把 /etc/docker/daemon.json 里的 registry-mirrors 删掉）"
done

# ---------- 4. 代码 ----------
say "4/7 下载项目的最新代码"
mkdir -p "$SITES_DIR/src" "$SITES_DIR/build" "$SITES_DIR/sites"
ok=0
for i in 1 2 3; do
  if curl -fsSL --connect-timeout 15 --max-time 180 -o "$TMP/pkg.tar.gz" "$BASE_URL/tuntun-brawl.tar.gz?t=$(date +%s)"; then ok=1; break; fi
  warn "游戏代码第 $i 次下载失败，5 秒后重试"; sleep 5
done
[ "$ok" -eq 1 ] || die "游戏代码下载失败：$BASE_URL/tuntun-brawl.tar.gz"
if [ "$PKG_SHA256" != "__PKG_SHA256__" ]; then
  echo "$PKG_SHA256  $TMP/pkg.tar.gz" | sha256sum -c --quiet - || die "游戏代码校验失败（可能下载不完整），请重新执行"
fi
mkdir -p "$TMP/game" && tar -xzf "$TMP/pkg.tar.gz" -C "$TMP/game"
for f in Dockerfile server/server.js deploy/docker/docker-compose.yml deploy/docker/zhuzhang.Dockerfile deploy/docker/zhuzhang.Caddyfile; do
  [ -f "$TMP/game/$f" ] || die "游戏代码包不完整，缺少 $f"
done
GAME_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/game/package.json" | head -1)"
echo "吞吞大乱斗 $GAME_VERSION"

ZZ_OK=0
if [ -n "$ZHUZHANG_DOMAIN" ]; then
for i in 1 2 3; do
  rm -rf "$TMP/zz"
  # 只下载网页需要的文件，跳过安装包、安卓和桌面端（约 3MB，完整仓库约 29MB）
  # （git 版本太旧不支持时退回完整下载）
  if git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$ZHUZHANG_REF" "${GITHUB_PROXY}${ZHUZHANG_GIT}" "$TMP/zz" \
     && { git -C "$TMP/zz" sparse-checkout set --no-cone '/*' '!/installers/' '!/android/' '!/desktop/' '!/test-fixtures/' 2>/dev/null || true; } \
     && git -C "$TMP/zz" checkout --quiet "$ZHUZHANG_REF"; then ZZ_OK=1; break; fi
  warn "筑账代码第 $i 次下载失败，10 秒后重试"; sleep 10
done
if [ "$ZZ_OK" -eq 1 ] && [ -f "$TMP/zz/package-lock.json" ]; then
  echo "筑账 $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/zz/package.json" | head -1)（$(git -C "$TMP/zz" log -1 --format='%h %cd' --date=short)）"
elif [ -f "$SITES_DIR/src/zhuzhang/package.json" ]; then
  warn "连不上 GitHub，筑账继续使用上次下载的代码。GitHub 连不上时可以设置 GITHUB_PROXY 再试"
  ZZ_OK=0
else
  die "筑账代码下载失败（连不上 GitHub）。可以设置代理前缀后重试：GITHUB_PROXY=https://你的代理/ bash install-docker.sh ..."
fi
fi

rm -rf "$SITES_DIR/src/tuntun-brawl.new" && mv "$TMP/game" "$SITES_DIR/src/tuntun-brawl.new"
rm -rf "$SITES_DIR/src/tuntun-brawl" && mv "$SITES_DIR/src/tuntun-brawl.new" "$SITES_DIR/src/tuntun-brawl"
if [ "$ZZ_OK" -eq 1 ]; then
  rm -rf "$SITES_DIR/src/zhuzhang" && mv "$TMP/zz" "$SITES_DIR/src/zhuzhang"
fi
if [ -n "$ZHUZHANG_DOMAIN" ]; then
  cp "$SITES_DIR/src/tuntun-brawl/deploy/docker/zhuzhang.Dockerfile" "$SITES_DIR/src/zhuzhang/Dockerfile.sites"
  printf '.git\nnode_modules\nbuild\ntest-build\ninstallers\nandroid\ndesktop\n' > "$SITES_DIR/src/zhuzhang/.dockerignore"
fi

# ---------- 5. 配置 ----------
say "5/7 生成配置并构建镜像（第一次需要几分钟）"
cp "$SITES_DIR/src/tuntun-brawl/deploy/docker/docker-compose.yml" "$SITES_DIR/docker-compose.yml"
cp "$SITES_DIR/src/tuntun-brawl/deploy/docker/zhuzhang.Caddyfile" "$SITES_DIR/build/zhuzhang.Caddyfile"
{
  echo "# 由 install-docker.sh 生成。重新执行安装脚本时会沿用这里的设置"
  echo "GAME_DOMAIN=$GAME_DOMAIN"
  echo "ZHUZHANG_DOMAIN=$ZHUZHANG_DOMAIN"
  echo "ACME_EMAIL=$EMAIL"
  echo "NPM_REGISTRY=$NPM_REGISTRY"
  echo "# 启用的可选项目（docker compose 按这里决定启动哪些容器）"
  if [ -n "$ZHUZHANG_DOMAIN" ]; then echo "COMPOSE_PROFILES=zhuzhang"; else echo "COMPOSE_PROFILES="; fi
} > "$SITES_DIR/.env"
{
  echo "# 由 install-docker.sh 生成，重新执行安装脚本会覆盖本文件。"
  echo "# 自己加的网站请写在 $SITES_DIR/sites/ 目录下的 *.caddy 文件里，不会被覆盖。"
  if [ -n "$EMAIL" ]; then printf '{\n\temail %s\n}\n' "$EMAIL"; fi
  echo
  echo "# 吞吞大乱斗"
  printf '%s {\n\tencode zstd gzip\n\treverse_proxy tuntun:8080\n}\n\n' "$GAME_DOMAIN"
  if [ -n "$ZHUZHANG_DOMAIN" ]; then
    echo "# 筑账"
    printf '%s {\n\tencode zstd gzip\n\treverse_proxy zhuzhang:80\n}\n\n' "$ZHUZHANG_DOMAIN"
  fi
  echo "import sites/*.caddy"
} > "$SITES_DIR/Caddyfile"

cd "$SITES_DIR"
# 不给镜像附加构建记录，这样代码没变时镜像也不变，更新时不会无谓地重启游戏、踢掉正在玩的人
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
docker compose config -q || die "docker-compose.yml 检查没通过"
if ! docker compose build; then
  die "镜像构建失败（上面是原因）。正在运行的网站没有受影响，处理后重新执行本脚本即可"
fi

# ---------- 6. 切换 ----------
say "6/7 启动（之前用 install.sh 装过的话会先停用旧的部署）"
if [ -f /etc/systemd/system/tuntun-brawl.service ] && systemctl is-enabled --quiet tuntun-brawl 2>/dev/null; then
  systemctl disable --now tuntun-brawl >/dev/null 2>&1 && echo "已停用旧的 tuntun-brawl 系统服务（文件保留在 /opt/tuntun-brawl）"
fi
if systemctl is-active --quiet nginx 2>/dev/null; then
  OTHERS=""
  for f in /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
    [ -e "$f" ] || continue
    case "$f" in */conf.d/tuntun-brawl.conf|*/sites-enabled/default) ;; *) OTHERS="$OTHERS $f";; esac
  done
  if [ -n "$OTHERS" ]; then
    die "Nginx 上还有别的网站，没有停用它，以免影响这些网站：$OTHERS。需要把它们也迁到 Caddy（写进 $SITES_DIR/sites/），或者改用 install.sh 部署"
  fi
  systemctl disable --now nginx >/dev/null 2>&1 && echo "已停用 Nginx（80/443 端口改由 Docker 里的 Caddy 使用）"
fi
BUSY="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v -e docker-proxy -e '"caddy"' || true)"
[ -z "$BUSY" ] || die "80 或 443 端口被别的程序占用：$BUSY"

docker compose up -d --remove-orphans
# 网关的配置文件可能刚改过（比如新加了筑账），让正在运行的 Caddy 重新读取
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || docker compose restart caddy >/dev/null
for i in $(seq 1 30); do
  STATE="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q tuntun)" 2>/dev/null || echo starting)"
  [ "$STATE" = "healthy" ] && break
  sleep 2
done
[ "${STATE:-}" = "healthy" ] || { docker compose logs --tail 30 tuntun; die "游戏容器没有正常启动，上面是日志"; }
docker compose ps

# ---------- 7. 检查 ----------
say "7/7 检查网站和 HTTPS 证书"
PUBLIC_IP="$(curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)"
check_site() {  # 域名 路径 期望内容；0=正常 2=在运行但证书还不是正式的 1=访问不到
  local d="$1" p="$2" want="$3" i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 15 -o "$TMP/check" --resolve "$d:443:127.0.0.1" "https://$d$p" 2>/dev/null && grep -q "$want" "$TMP/check"; then return 0; fi
    sleep 3
  done
  if curl -fsSk --max-time 15 -o "$TMP/check" --resolve "$d:443:127.0.0.1" "https://$d$p" 2>/dev/null && grep -q "$want" "$TMP/check"; then return 2; fi
  return 1
}
ALL_OK=1
SITES_TO_CHECK=("$GAME_DOMAIN|/healthz|ok|吞吞大乱斗")
[ -z "$ZHUZHANG_DOMAIN" ] || SITES_TO_CHECK+=("$ZHUZHANG_DOMAIN|/|筑账|筑账")
for pair in "${SITES_TO_CHECK[@]}"; do
  IFS='|' read -r d p want label <<<"$pair"
  DNS_IP="$(getent ahostsv4 "$d" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  set +e; check_site "$d" "$p" "$want"; rc=$?; set -e
  if [ $rc -eq 0 ]; then
    echo "✓ $label：https://$d"
  else
    ALL_OK=0
    if [ $rc -eq 2 ]; then warn "$label 已在运行，但 $d 的正式证书还没签发下来"; else warn "$label 访问不到"; fi
    if [ -z "$DNS_IP" ]; then warn "  $d 还没有解析：去域名控制台添加 A 记录，指向本服务器的公网 IP ${PUBLIC_IP}"
    elif [ -n "$PUBLIC_IP" ] && [ "$DNS_IP" != "$PUBLIC_IP" ]; then warn "  $d 解析到 $DNS_IP，和本机公网 IP $PUBLIC_IP 不一致"; fi
  fi
done
if [ "$ALL_OK" -ne 1 ]; then
  echo; echo "Caddy 最近的日志："; docker compose logs --tail 15 caddy || true
  warn "常见原因：①域名解析还没生效（等几分钟）②安全组没放行 80、443 端口 ③域名不是在这家云服务商备案的，需要先做接入备案。处理好后不用重装，Caddy 会自动重试；也可以重新执行本脚本"
fi

docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=72h >/dev/null 2>&1 || true

echo
if [ "$ALL_OK" -eq 1 ]; then say "部署完成！"; else say "部署完成，但上面有需要处理的地方"; fi
echo "  吞吞大乱斗：https://$GAME_DOMAIN"
[ -z "$ZHUZHANG_DOMAIN" ] || echo "  筑账：      https://$ZHUZHANG_DOMAIN"
echo "常用命令（先 cd $SITES_DIR）：查看状态 docker compose ps ｜ 查看日志 docker compose logs -f ｜ 更新 重新执行本脚本"
