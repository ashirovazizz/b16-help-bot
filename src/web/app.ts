import { randomBytes } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isUserError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { LinkRole } from '../core/tokens.js';
import { FIELDS, type FieldKey, PHOTO_RULES } from '../domain/fields.js';
import type { Links } from '../services/links.js';
import type { FormInput, RequestService } from '../services/service.js';
import { formPage, messagePage } from './views.js';

type Env = { Variables: { nonce: string } };

const BAD_LINK = 'Ссылка недействительна или устарела. Откройте свежую ссылку из сообщения бота.';

/**
 * Веб-форма заявки. Доступ — только по подписанной ссылке из бота:
 * `?t=` определяет заявку и роль (заявитель или редактор).
 */
export function createWebApp(deps: { service: RequestService; links: Links; log: Logger }) {
  const { service, links, log } = deps;
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const nonce = randomBytes(16).toString('base64');
    c.set('nonce', nonce);
    await next();
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' https: blob: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  app.get('/healthz', (c) => c.text('ok'));
  app.get('/', (c) =>
    c.html(messagePage('Бот DH-центра', 'Откройте форму по ссылке из бота.', c.get('nonce'))),
  );

  const fail = (
    c: Context<Env>,
    status: 403 | 404 | 409 | 413 | 500,
    title: string,
    text: string,
  ) => c.html(messagePage(title, text, c.get('nonce')), status);

  const role = (c: Context<Env>): { id: string; role: LinkRole; token: string } | undefined => {
    const id = c.req.param('id') ?? '';
    const token = c.req.query('t') ?? '';
    const r = links.verify(id, token);
    return r ? { id, role: r, token } : undefined;
  };

  const photoUrl = (id: string, token: string) => (which: 'new' | 'current') =>
    `/r/${encodeURIComponent(id)}/photo?t=${encodeURIComponent(token)}&v=${which}`;

  const handleError = (c: Context<Env>, e: unknown) => {
    if (isUserError(e)) return fail(c, 409, 'Не получилось', e.message);
    log.error('Ошибка веб-формы', { path: c.req.path, error: e });
    return fail(
      c,
      500,
      'Что-то пошло не так',
      'Попробуйте ещё раз чуть позже. Мы уже знаем об ошибке.',
    );
  };

  app.get('/r/:id', async (c) => {
    const access = role(c);
    if (!access) return fail(c, 403, 'Ссылка не работает', BAD_LINK);
    try {
      const model = await service.openForm(access.id, access.role);
      return c.html(
        formPage({
          model,
          nonce: c.get('nonce'),
          photoUrl: photoUrl(access.id, access.token),
          saved: c.req.query('saved') === '1',
        }),
      );
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post(
    '/r/:id',
    bodyLimit({
      maxSize: PHOTO_RULES.maxBytes + 2 * 1024 * 1024,
      onError: (c) =>
        c.html(
          messagePage('Файл слишком большой', 'Загрузите фото до 20 МБ.', c.get('nonce')),
          413,
        ),
    }),
    async (c) => {
      const access = role(c);
      if (!access) return fail(c, 403, 'Ссылка не работает', BAD_LINK);
      try {
        const body = await c.req.parseBody();
        const fields: Partial<Record<FieldKey, string>> = {};
        for (const def of FIELDS) {
          const v = body[`f_${def.key}`];
          if (typeof v === 'string') fields[def.key] = v;
        }
        const input: FormInput = { fields };
        const photo = body.photo;
        if (photo instanceof File && photo.size > 0) {
          input.photo = new Uint8Array(await photo.arrayBuffer());
        }
        if (typeof body.comment === 'string') input.comment = body.comment;

        const result =
          access.role === 'editor'
            ? await service.saveEditorForm(access.id, input)
            : await service.submitForm(access.id, input);
        if (result.ok) {
          return c.redirect(
            `/r/${encodeURIComponent(access.id)}?t=${encodeURIComponent(access.token)}&saved=1`,
            303,
          );
        }
        return c.html(
          formPage({
            model: result.model,
            nonce: c.get('nonce'),
            photoUrl: photoUrl(access.id, access.token),
            errors: result.errors,
            ...(input.comment !== undefined ? { comment: input.comment } : {}),
          }),
          422,
        );
      } catch (e) {
        return handleError(c, e);
      }
    },
  );

  app.get('/r/:id/photo', async (c) => {
    const access = role(c);
    if (!access) return c.text('Forbidden', 403);
    const which = c.req.query('v') === 'current' ? 'current' : 'new';
    try {
      const photo = await service.photo(access.id, which);
      if (!photo) return c.text('Not found', 404);
      if (!photo.stored) {
        // фото со старого сайта лежит по внешней ссылке
        return /^https:\/\//.test(photo.ref)
          ? c.redirect(photo.ref, 302)
          : c.text('Not found', 404);
      }
      c.header('Content-Type', photo.stored.mimeType);
      c.header('Cache-Control', 'private, max-age=300');
      if (c.req.query('download') === '1') {
        const ext = photo.stored.mimeType.split('/')[1] ?? 'jpg';
        c.header('Content-Disposition', `attachment; filename="${access.id}.${ext}"`);
      }
      return c.body(photo.stored.data as Uint8Array<ArrayBuffer>);
    } catch (e) {
      if (isUserError(e)) return c.text('Not found', 404);
      log.error('Ошибка выдачи фото', { error: e });
      return c.text('Error', 500);
    }
  });

  return app;
}
