#!/usr/bin/env bash
# Подтягивает свежую версию с GitHub и перезапускает Козю, если что-то изменилось.
set -e
DIR=/opt/kozya
export HOME="${HOME:-/root}"
G() { git -c safe.directory="$DIR" -C "$DIR" "$@"; }
G fetch -q origin main
if [ "$(G rev-parse HEAD)" != "$(G rev-parse origin/main)" ]; then
  G reset -q --hard origin/main
  chown -R kozya:kozya "$DIR"
  systemctl restart kozya.service
  echo "Обновлено до $(G rev-parse --short HEAD)"
else
  echo "Уже свежая версия $(G rev-parse --short HEAD)"
fi
