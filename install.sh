#!/usr/bin/env bash
# 吞吞大乱斗 · 服务器一键安装 / 更新脚本（Debian 11/12、Ubuntu 20.04+）
#
# 用法（在服务器上用 root 执行）：
#   curl -fsSL https://fuzzylogic112.github.io/blob-brawl/install.sh | bash -s -- 你的域名 [邮箱]
# 例如：
#   curl -fsSL https://fuzzylogic112.github.io/blob-brawl/install.sh | bash -s -- game.xwj0.cn
#
# 做的事情：
#   1. 用系统软件源安装 Node.js、Nginx、certbot（不访问 npm 和 GitHub 原站）
#   2. 下载游戏安装包到 /opt/tuntun-brawl（已内置依赖）
#   3. 注册 systemd 服务 tuntun-brawl：开机自启、崩溃自动重启，只监听本机 8080
#   4. 配置 Nginx 反向代理（含 WebSocket）
#   5. 申请 Let's Encrypt 免费 HTTPS 证书并自动续期
# 重复执行即可更新到最新版本，已有的证书和配置会保留。
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
BASE_URL="${TUNTUN_BASE_URL:-https://fuzzylogic112.github.io/blob-brawl}"
PKG_SHA256="0bdf1d4871edbdff979e8ded139023bb1dd3d053f10ce3a5ad363442ea9c8c85"
APP_DIR=/opt/tuntun-brawl
APP_USER=tuntun
PORT=8080
SERVICE=tuntun-brawl
NGINX_CONF=/etc/nginx/conf.d/tuntun-brawl.conf

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "请带上域名，例如：bash -s -- game.xwj0.cn"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "域名格式不对：$DOMAIN"
[ "$(id -u)" -eq 0 ] || die "请用 root 用户执行（或在命令前加 sudo）"
command -v apt-get >/dev/null || die "这个脚本只支持 Debian / Ubuntu"
command -v systemctl >/dev/null || die "系统没有 systemd，无法注册服务"

say "1/6 安装 Node.js、Nginx、certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs nginx certbot python3-certbot-nginx curl ca-certificates tar >/dev/null
NODE_BIN="$(command -v node || command -v nodejs || true)"
[ -n "$NODE_BIN" ] || die "Node.js 安装失败"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 版本太旧（$("$NODE_BIN" -v)），需要 18 以上"
echo "Node.js $("$NODE_BIN" -v)，Nginx $(nginx -v 2>&1 | sed 's/.*\///')"

say "2/6 下载游戏安装包"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok=0
for i in 1 2 3; do
  if curl -fsSL --connect-timeout 15 --max-time 180 -o "$TMP/pkg.tar.gz" "$BASE_URL/tuntun-brawl.tar.gz?t=$(date +%s)"; then ok=1; break; fi
  warn "第 $i 次下载失败，5 秒后重试"; sleep 5
done
[ "$ok" -eq 1 ] || die "安装包下载失败：$BASE_URL/tuntun-brawl.tar.gz"
if [ "$PKG_SHA256" != "__PKG_SHA256__" ]; then
  echo "$PKG_SHA256  $TMP/pkg.tar.gz" | sha256sum -c --quiet - || die "安装包校验失败（可能下载不完整），请重新执行"
fi
mkdir -p "$TMP/app" && tar -xzf "$TMP/pkg.tar.gz" -C "$TMP/app"
[ -f "$TMP/app/server/server.js" ] && [ -d "$TMP/app/node_modules/ws" ] || die "安装包内容不完整"
VERSION="$("$NODE_BIN" -p "require('$TMP/app/package.json').version")"
echo "版本 $VERSION"

say "3/6 安装到 $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$TMP/app" "$APP_DIR"
chown -R root:root "$APP_DIR" && chmod -R a+rX "$APP_DIR"

cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=TunTun Brawl game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=PER_IP=20
ExecStart=$NODE_BIN $APP_DIR/server/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null 2>&1
systemctl restart $SERVICE

say "4/6 检查游戏服务"
up=0
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
if [ "$up" -ne 1 ]; then
  journalctl -u $SERVICE -n 30 --no-pager || true
  if [ -d "$APP_DIR.old" ]; then
    warn "新版本没能启动，恢复上一个版本"
    rm -rf "$APP_DIR" && mv "$APP_DIR.old" "$APP_DIR" && systemctl restart $SERVICE
  fi
  die "游戏服务没有启动，上面是日志"
fi
echo "游戏服务运行正常：$(curl -fsS http://127.0.0.1:$PORT/status)"

say "5/6 配置 Nginx"
# 部分云服务器镜像关闭了 IPv6，这时 Nginx 不能监听 [::]，否则启动失败
if [ -f /proc/net/if_inet6 ]; then LISTEN6="listen [::]:80;"; else
  LISTEN6="# 本机没有 IPv6"
  for f in /etc/nginx/sites-enabled/*; do [ -f "$f" ] && sed -i 's/^\(\s*listen \[::\]:80.*\)$/# \1/' "$f"; done
fi
if [ -f "$NGINX_CONF" ] && grep -q "ssl_certificate" "$NGINX_CONF" && grep -q "server_name $DOMAIN;" "$NGINX_CONF"; then
  echo "已有 HTTPS 配置，保留不动"
else
  cat > "$NGINX_CONF" <<EOF
# 吞吞大乱斗（由 install.sh 生成）
map \$http_upgrade \$tuntun_conn_upgrade { default upgrade; '' close; }

server {
    listen 80;
    $LISTEN6
    server_name $DOMAIN;

    gzip on;
    gzip_types text/css application/javascript application/json;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$tuntun_conn_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
fi
nginx -t || die "Nginx 配置检查没通过，上面是原因"
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx 2>/dev/null || systemctl restart nginx

say "6/6 申请 HTTPS 证书"
PUBLIC_IP="$(curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
echo "域名解析到：${DNS_IP:-（还没有解析）}    本机公网 IP：${PUBLIC_IP:-（未获取到）}"
cert_ok=0
if [ -z "$DNS_IP" ]; then
  warn "域名 $DOMAIN 还没有解析到任何 IP，先跳过证书。去域名控制台加一条 A 记录后重新执行本脚本即可。"
else
  [ -n "$PUBLIC_IP" ] && [ "$DNS_IP" != "$PUBLIC_IP" ] && warn "域名解析的 IP 和本机公网 IP 不一致，证书可能申请失败"
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ] && grep -q "ssl_certificate" "$NGINX_CONF"; then
    echo "证书已存在，由系统自动续期"; cert_ok=1
  else
    if [ -n "$EMAIL" ]; then MAIL_ARGS=(-m "$EMAIL"); else MAIL_ARGS=(--register-unsafely-without-email); fi
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos "${MAIL_ARGS[@]}" --redirect; then
      cert_ok=1
    else
      warn "证书申请失败。常见原因：①域名解析还没生效（等几分钟）②云服务器安全组没放行 80 和 443 端口 ③域名的备案不是在这家云服务商做的，需要先做接入备案。处理后重新执行本脚本即可。"
    fi
  fi
fi

echo
if [ "$cert_ok" -eq 1 ]; then
  if curl -fsS --max-time 10 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    say "部署完成！打开 https://$DOMAIN 就能玩（版本 $VERSION）"
  else
    say "部署完成：https://$DOMAIN （本机访问自己的域名没通，通常是安全组没放行 443，从手机或电脑打开试试）"
  fi
else
  say "游戏已在运行，但 HTTPS 还没配好：现在可以先用 http://$DOMAIN 访问，配好证书后联机才能从 GitHub Pages 连上"
fi
echo "常用命令：查看状态 systemctl status $SERVICE ｜ 查看日志 journalctl -u $SERVICE -f ｜ 更新版本 重新执行本命令"
