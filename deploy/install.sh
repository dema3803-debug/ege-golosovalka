#!/usr/bin/env bash
# Установка Кози на свой сервер (Ubuntu 24.04). Запуск от root:
#   curl -fsSL https://raw.githubusercontent.com/dema3803-debug/ege-golosovalka/main/deploy/install.sh | bash -s -- ваш-домен.ru
set -euo pipefail
DOMAIN="${1:-}"
REPO="https://github.com/dema3803-debug/ege-golosovalka.git"
DIR=/opt/kozya
say() { printf "\n\033[1;35m▶ %s\033[0m\n" "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запусти от root"; exit 1; }
[ -n "$DOMAIN" ] || { echo "Укажи домен: ... | bash -s -- kozya-ege.ru"; exit 1; }

say "1/6 Ставлю программы (Node.js, Redis, Caddy, git)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl nodejs redis-server caddy >/dev/null
node -v

say "2/6 Скачиваю Козю с GitHub"
id kozya >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin kozya
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin main && git -C "$DIR" reset -q --hard origin/main
else git clone -q "$REPO" "$DIR"; fi
chown -R kozya:kozya "$DIR"
git config --global --add safe.directory "$DIR"

say "3/6 Пароли"
if [ ! -f /etc/kozya.env ]; then
  read -r -p "Пароль ADMIN_KEY (тот же, что в Vercel): " ADMIN_KEY </dev/tty
  read -r -p "Ключ GIGACHAT_KEY (Authorization key из кабинета Сбера): " GIGACHAT_KEY </dev/tty
  umask 077
  cat > /etc/kozya.env <<ENV
PORT=3000
LOCAL_REDIS_URL=redis://127.0.0.1:6379
ADMIN_KEY=$ADMIN_KEY
GIGACHAT_KEY=$GIGACHAT_KEY
ENV
  chown root:kozya /etc/kozya.env; chmod 640 /etc/kozya.env
else echo "Пароли уже записаны в /etc/kozya.env — оставляю"; sed -i 's#^REDIS_URL=#LOCAL_REDIS_URL=#' /etc/kozya.env; fi

say "4/6 База данных (сохраняется на диск)"
sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
grep -q '^appendonly yes' /etc/redis/redis.conf || echo 'appendonly yes' >> /etc/redis/redis.conf
systemctl enable -q redis-server && systemctl restart redis-server

say "5/6 Запускаю Козю и автообновление с GitHub"
cat > /etc/systemd/system/kozya.service <<UNIT
[Unit]
Description=Kozya EGE app
After=network-online.target redis-server.service
Wants=network-online.target
[Service]
User=kozya
WorkingDirectory=$DIR
EnvironmentFile=/etc/kozya.env
ExecStart=/usr/bin/node deploy/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/kozya-update.service <<UNIT
[Unit]
Description=Kozya: pull updates from GitHub
[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/bin/bash $DIR/deploy/update.sh
UNIT
cat > /etc/systemd/system/kozya-update.timer <<UNIT
[Unit]
Description=Kozya: check GitHub every 2 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q --now kozya.service kozya-update.timer
systemctl restart kozya.service

say "6/6 Сайт по адресу https://$DOMAIN (сертификат получится сам)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN, www.$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl enable -q caddy && systemctl restart caddy

sleep 3
if curl -fsS http://127.0.0.1:3000/api/results >/dev/null; then
  printf "\n\033[1;32m✅ Козя запущена!\033[0m\n"
else
  printf "\n\033[1;31m❌ Козя не отвечает. Пришли вывод команды: journalctl -u kozya -n 30\033[0m\n"
fi
echo "Проверь в браузере (без VPN): https://$DOMAIN/api/giga-test?key=ТВОЙ_ПАРОЛЬ"
echo "Если домен только что купили, первые минуты сайт может не открываться — это нормально."
