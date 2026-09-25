/**
 * Получение GOOGLE_REFRESH_TOKEN для аккаунта центра.
 *
 * Запускать там, где есть браузер (или через проброс порта по SSH):
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npm run google:auth
 * Войти аккаунтом центра и разрешить доступ. Токен появится в терминале —
 * впишите его в .env на сервере. В чат и в репозиторий его не отправляйте.
 */
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_SCOPES } from '../google/auth.js';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const port = Number(process.env.OAUTH_PORT ?? 53682);

if (!clientId || !clientSecret) {
  console.error(
    'Задайте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET (OAuth-клиент типа «Desktop app»).',
  );
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${port}`;
const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
const url = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: GOOGLE_SCOPES,
});

const server = http.createServer(async (req, res) => {
  const params = new URL(req.url ?? '/', redirectUri).searchParams;
  const code = params.get('code');
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Нет кода авторизации: ${params.get('error') ?? 'неизвестная ошибка'}`);
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Готово. Вернитесь в терминал.');
    if (!tokens.refresh_token) {
      console.error(
        '\nGoogle не выдал refresh token. Уберите доступ приложения в настройках аккаунта и повторите.',
      );
    } else {
      console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\nВпишите строку выше в .env на сервере. Никому её не пересылайте.');
    }
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Не удалось получить токен, подробности в терминале.');
    console.error(e);
  } finally {
    server.close();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('1. Откройте ссылку в браузере и войдите аккаунтом центра:\n');
  console.log(url);
  console.log(`\n2. После согласия браузер вернётся на ${redirectUri} — токен появится здесь.`);
});
