# Запуск на сервере центра

Порядок: Telegram → Google → книга → сервер → реестр. Все секреты вписываются прямо в `.env` на сервере; в чат, почту и репозиторий их не отправляйте.

## 1. Telegram

1. В [@BotFather](https://t.me/BotFather) с аккаунта центра: `/newbot`, имя — например «DH-центр: страницы». Токен сохраните в `TELEGRAM_BOT_TOKEN`.
2. Privacy mode оставьте включённым (так по умолчанию). Администратором чата бота не делайте: ему достаточно писать сообщения.
3. Добавьте бота в рабочий чат. В теме «Сайт» отправьте `/id@имя_бота`. Бот ответит `chat_id` и `topic_id` — это `OPS_CHAT_ID` и `OPS_TOPIC_ID`.
4. Для технических тревог можно завести отдельную тему и так же узнать её ID (`ALERT_CHAT_ID`, `ALERT_TOPIC_ID`). Без них тревоги придут в тему «Сайт».

## 2. Google (аккаунт центра)

1. [console.cloud.google.com](https://console.cloud.google.com) → войти аккаунтом центра → создать проект, например `dh-bot`.
2. «APIs & Services → Library»: включить **Google Sheets API** и **Google Drive API**.
3. «Google Auth Platform» (раньше — «OAuth consent screen»):
   - Branding: название приложения, почта поддержки;
   - Audience: тип **External**, затем **Publish app → In production**. В режиме Testing доступ отваливается через 7 дней;
   - Data Access: scope `https://www.googleapis.com/auth/drive.file` (бот видит только созданные им файлы).
4. «Clients → Create client», тип **Desktop app**. Client ID и secret → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
5. На компьютере с браузером и Node.js 22:

   ```bash
   git clone https://github.com/ashirovazizz/b16-help-bot && cd b16-help-bot && npm ci
   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npm run google:auth
   ```

   Откройте ссылку, войдите **аккаунтом центра** и разрешите доступ. В терминале появится `GOOGLE_REFRESH_TOKEN`.

   На сервере без браузера: `ssh -L 53682:127.0.0.1:53682 сервер`, запустить скрипт там, ссылку открыть у себя.

Если консоль Google Cloud недоступна аккаунту центра, остановитесь и напишите: есть запасной вариант.

## 3. Книга и папка для фото

С заполненными `GOOGLE_*` в `.env`:

```bash
docker compose run --rm bot node dist/scripts/setup-workbook.js
# или локально: npm run setup:workbook
```

Скрипт создаст книгу «DH-бот: персональные страницы» с листами People, Profiles, Requests, History, Settings и закрытую папку для фото. Напечатанные `SPREADSHEET_ID` и `PHOTOS_FOLDER_ID` впишите в `.env`.

Доступ к книге (редактирование) выдайте через «Настройки доступа» в Google Таблице: администратору реестра, редактору, стажёру. Папку с фото — только тем, кому нужны оригиналы: редактор скачивает их из формы.

Повторный запуск скрипта безопасен: он проверит листы и допишет недостающие колонки справа, не трогая данные.

## 4. Сервер

Нужно:

- Docker с плагином Compose;
- домен или поддомен для формы с A-записью на сервер и открытые порты 80 и 443;
- исходящий доступ к `api.telegram.org`, `*.googleapis.com`, `oauth2.googleapis.com`, `dh.itmo.ru`.

```bash
git clone https://github.com/ashirovazizz/b16-help-bot && cd b16-help-bot
cp .env.example .env    # заполнить
openssl rand -base64 48 # → LINK_SECRET
docker compose --profile https up -d --build
```

Профиль `https` поднимает Caddy: сертификат для `DOMAIN` выпускается сам. Если на сервере уже есть nginx, запускайте без профиля и проксируйте на `127.0.0.1:3000` с `client_max_body_size 25m`.

Если Docker Hub недоступен, соберите образ из зеркала: `NODE_IMAGE=mirror.gcr.io/library/node:22-alpine` в `.env`.

Проверка:

```bash
curl https://ваш-домен/healthz        # ok
docker compose logs -f bot            # «Бот запущен»
```

В теме «Сайт» — `/sync@имя_бота`: бот ответит итогом сверки с реестром.

Обновление: `git pull && docker compose --profile https up -d --build`.

Резервные копии: данные лежат в Google (у Таблицы есть история версий). На сервере хранится только `.env`.

## 5. Реестр и приглашения

1. Заполните People по итогам сверки: ФИО, Категория, Должность в центре, Статус «работает», Публикуем на сайте «да»/«нет». ID бот проставит сам.
2. Заполните Profiles для тех, у кого страница уже есть: ID, ФИО, Адрес страницы, Публикация «опубликована» и тексты блоков.
3. В течение 5 минут бот выдаст ссылки-приглашения в колонке «Ссылка-приглашение». Отправьте каждому его ссылку лично: она одноразовая и привязывает Telegram человека к его строке.

## Если что-то не работает

| Симптом | Причина |
|---|---|
| в журнале «Не удалось связаться с Telegram» | неверный токен или сервер не видит `api.telegram.org` |
| тревога «invalid_grant» от Google | refresh token отозван или истёк (приложение в режиме Testing): повторите `npm run google:auth` |
| «На листе … нет колонок» | переименовали заголовок: верните название или запустите setup-скрипт |
| кнопки в чате не отвечают | бот не в том чате, или `OPS_CHAT_ID` указан неверно (проверьте `/id@имя_бота`) |
