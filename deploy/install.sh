#!/usr/bin/env bash
# Установка и обновление бота DH-центра на сервере (Ubuntu или Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/ashirovazizz/b16-help-bot/refs/heads/claude/optimize-personnel-updates-eu31gv/deploy/install.sh | sudo bash
#
# Повторный запуск обновляет бота; настройки в /opt/b16-help-bot/.env сохраняются.
set -euo pipefail

REPO="https://github.com/ashirovazizz/b16-help-bot.git"
BRANCH="${BRANCH:-claude/optimize-personnel-updates-eu31gv}"
DIR="${DIR:-/opt/b16-help-bot}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }
set_env() { # set_env KEY VALUE — заменить или дописать строку в .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

[ "$(id -u)" -eq 0 ] || die "запустите через sudo"

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Устанавливаю Docker…"
  if ! curl -fsSL https://get.docker.com | sh; then
    say "Официальный установщик Docker недоступен, ставлю из репозитория системы…"
    apt-get update
    apt-get install -y docker.io docker-compose-v2 \
      || apt-get install -y docker.io docker-compose-plugin \
      || die "не получилось установить Docker"
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "нет плагина docker compose"

# 2. Код
command -v git >/dev/null 2>&1 || { apt-get update && apt-get install -y git; }
if [ -d "$DIR/.git" ]; then
  say "Обновляю код в $DIR…"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
  say "Скачиваю код в $DIR…"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

# 3. Настройки: токен спрашиваем, код для /setup придумываем
[ -f .env ] || { cp .env.example .env; chmod 600 .env; }
if ! grep -q '^TELEGRAM_BOT_TOKEN=..*' .env; then
  printf '\nВставьте токен бота от @BotFather и нажмите Enter: '
  read -r TOKEN < /dev/tty
  [[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || die "это не похоже на токен бота"
  set_env TELEGRAM_BOT_TOKEN "$TOKEN"
fi
if ! grep -q '^SETUP_CODE=..*' .env; then
  set_env SETUP_CODE "$(tr -dc 'a-z0-9' < /dev/urandom | head -c 10 || true)"
fi
CODE="$(grep '^SETUP_CODE=' .env | cut -d= -f2-)"

# 4. Если Docker Hub недоступен — берём базовый образ из зеркала
if ! grep -q '^NODE_IMAGE=' .env && ! docker pull -q node:22-alpine >/dev/null 2>&1; then
  say "Docker Hub недоступен, беру образ из зеркала"
  set_env NODE_IMAGE mirror.gcr.io/library/node:22-alpine
fi

# 5. Сборка и запуск
say "Собираю и запускаю бота (первый раз — пара минут)…"
docker compose up -d --build

BOT=""
for _ in $(seq 1 45); do
  BOT="$(docker compose logs bot 2>/dev/null | grep -o '"bot":"[^"]*"' | tail -1 | cut -d'"' -f4 || true)"
  [ -n "$BOT" ] && break
  sleep 2
done
if [ -z "$BOT" ]; then
  docker compose logs --tail 20 bot || true
  die "бот не запустился — посмотрите журнал выше (частая причина: неверный токен или сервер не видит api.telegram.org)"
fi

say "Готово! Бот @$BOT работает."
cat <<EOF

Дальше в Telegram:
  1. Добавьте @$BOT в рабочий чат.
  2. В теме, куда должны приходить заявки, отправьте:
       /setup@$BOT $CODE
  3. Напишите боту в личку /start и отправьте тестовую заявку.

Полезное:
  журнал       cd $DIR && sudo docker compose logs -f
  перезапуск   cd $DIR && sudo docker compose restart
  обновление   запустите эту же команду установки ещё раз
  настройки    sudo nano $DIR/.env, затем перезапуск
EOF
