#!/usr/bin/env bash
# Подтягивает свежую версию с GitHub и перезапускает Козю, если что-то изменилось.
set -e
DIR=/opt/kozya
cd "$DIR"
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  chown -R kozya:kozya "$DIR"
  systemctl restart kozya.service
  echo "Обновлено до $(git rev-parse --short HEAD)"
fi
