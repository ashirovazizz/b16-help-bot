import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { createWebApp } from '../src/web/app.js';
import { fakePng, profiles, setup, vika } from './helpers.js';

async function prepared(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  const app = createWebApp({ service: s.service, links: s.links, log: silentLogger });
  const start = await s.service.startUpdate(501);
  const id = start.request.requestId;
  const url = (role: 'requester' | 'editor') => {
    const full = s.links.form(id, role);
    return full.slice('https://forms.example.org'.length);
  };
  return { ...s, app, id, url };
}

function formData(fields: Record<string, string>, photo?: Uint8Array) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (photo)
    fd.set('photo', new File([photo as Uint8Array<ArrayBuffer>], 'me.png', { type: 'image/png' }));
  return fd;
}

describe('веб-форма', () => {
  it('отвечает на проверку здоровья', async () => {
    const { app } = await prepared();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('без подписи и с чужой подписью не пускает', async () => {
    const { app, id, url } = await prepared();
    expect((await app.request(`/r/${id}`)).status).toBe(403);
    const token = url('requester').split('?t=')[1];
    expect((await app.request(`/r/R-9999?t=${token}`)).status).toBe(403);
  });

  it('открывает анкету с текущим текстом и защитными заголовками', async () => {
    const { app, url } = await prepared();
    const res = await app.request(url('requester'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Обновление страницы');
    expect(html).toContain('>Старый текст</textarea>');
    expect(html).toContain('name="comment"');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const csp = res.headers.get('Content-Security-Policy')!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(html).toContain(`<script nonce="${nonce}">`);
  });

  it('принимает анкету с фото и не даёт отправить её дважды', async () => {
    const { app, url, repo, id } = await prepared();
    const res = await app.request(url('requester'), {
      method: 'POST',
      body: formData(
        {
          f_title: 'координатор',
          f_about: 'Новый текст',
          f_projects: '',
          f_courses: '',
          f_contacts: '',
          f_channel: '',
        },
        fakePng(),
      ),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toContain('saved=1');
    const r = await repo.getRequest(id);
    expect(r?.status).toBe('with_editor');
    expect(r?.fields).toEqual({ about: 'Новый текст' });
    expect(r?.photo).toBeDefined();

    const again = await app.request(url('requester'), {
      method: 'POST',
      body: formData({ f_about: 'Ещё' }),
    });
    expect(again.status).toBe(409);

    const view = await (await app.request(`${url('requester')}&saved=1`)).text();
    expect(view).toContain('Заявка у редактора');
  });

  it('показывает ошибки и сохраняет введённое', async () => {
    const { app, url } = await prepared();
    const res = await app.request(url('requester'), {
      method: 'POST',
      body: formData({ f_title: 'а'.repeat(250), f_about: 'Текст' }),
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('250 из 200');
    expect(html).toContain(`value="${'а'.repeat(250)}"`);
  });

  it('экранирует то, что ввёл человек', async () => {
    const { app, url, repo, id } = await prepared();
    await app.request(url('requester'), {
      method: 'POST',
      body: formData({ f_about: '<script>alert(1)</script>' }),
    });
    expect((await repo.getRequest(id))?.fields.about).toBe('<script>alert(1)</script>');
    const html = await (await app.request(url('editor'))).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('редактор видит, что изменилось, копирует и правит текст', async () => {
    const { app, url, repo, id, service } = await prepared();
    await service.submitForm(id, { fields: { about: 'Текст , с ошибкой' }, photo: fakePng() });
    const html = await (await app.request(url('editor'))).text();
    expect(html).toContain('Сохранить правки');
    expect(html).toContain('data-copy="f_about"');
    expect(html).toContain('изменено');
    expect(html).toContain('Сейчас на сайте');
    expect(html).toContain('Скачать новое фото');

    const res = await app.request(url('editor'), {
      method: 'POST',
      body: formData({ f_title: 'координатор', f_about: 'Текст, без ошибки' }),
    });
    expect(res.status).toBe(303);
    expect((await repo.getRequest(id))?.fields.about).toBe('Текст, без ошибки');

    // после публикации форма редактора только для чтения
    await service.publish(id, vika);
    const after = await (await app.request(url('editor'))).text();
    expect(after).not.toContain('<form');
  });

  it('ссылка заявителя не открывает режим редактора', async () => {
    const { app, url, id, service } = await prepared();
    await service.submitForm(id, { fields: { about: 'Новый текст' } });
    const html = await (await app.request(url('requester'))).text();
    expect(html).not.toContain('Сохранить правки');
    expect(html).not.toContain('<form');
  });

  it('отдаёт фото из заявки и перенаправляет на фото со старого сайта', async () => {
    const { app, url, id, service } = await prepared({
      profiles: [{ ...profiles.aziz!, photo: 'https://static.tildacdn.com/aziz.jpg' }],
    });
    await service.submitForm(id, { fields: { about: 'Новый текст' }, photo: fakePng() });
    const token = url('editor').split('?t=')[1];
    const fresh = await app.request(`/r/${id}/photo?t=${token}&v=new`);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('Content-Type')).toBe('image/png');
    const old = await app.request(`/r/${id}/photo?t=${token}&v=current`);
    expect(old.status).toBe(302);
    expect(old.headers.get('Location')).toBe('https://static.tildacdn.com/aziz.jpg');
    expect((await app.request(`/r/${id}/photo?t=bad&v=new`)).status).toBe(403);
  });
});
