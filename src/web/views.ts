import { FIELDS, type FieldKey, PHOTO_LABEL, PHOTO_RULES } from '../domain/fields.js';
import { REQUEST_TYPE_LABELS, STATUS_LABELS } from '../domain/model.js';
import type { FormErrorKey } from '../domain/validation.js';
import type { FormModel } from '../services/service.js';

export function h(s: string | number | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a66;--line:#dedbd3;--card:#fff;--accent:#1f5eff;--err:#b3261e;--ok:#1e7a3c;--note:#fff6d6}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a3a19b;--line:#34332f;--card:#1f1f1d;--accent:#7aa2ff;--err:#ff8a80;--ok:#7fd49a;--note:#3a331b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
.brand{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
h1{font-size:26px;line-height:1.2;margin:6px 0 4px}
.who{color:var(--muted);margin:0 0 20px}
.box{border-radius:10px;padding:12px 14px;margin:0 0 20px;background:var(--note)}
.box.ok{background:transparent;border:1px solid var(--ok);color:var(--ok)}
.box.err{background:transparent;border:1px solid var(--err);color:var(--err)}
.field{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 14px}
label{display:block;font-weight:600}
.req{color:var(--err)}
.hint{color:var(--muted);font-size:14px;margin:2px 0 8px}
textarea,input[type=text]{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px}
textarea{min-height:7em;resize:vertical}
textarea:focus,input:focus{outline:2px solid var(--accent);outline-offset:1px}
.meta{display:flex;justify-content:space-between;gap:8px;font-size:13px;color:var(--muted);margin-top:4px}
.error{color:var(--err);font-size:14px;margin:6px 0 0}
.value{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;min-height:2.5em}
details{margin-top:8px;font-size:14px}
details .value{margin-top:6px}
.photos{display:flex;gap:12px;flex-wrap:wrap;margin:6px 0 10px}
.photos figure{margin:0;font-size:13px;color:var(--muted)}
.photos img{display:block;max-width:180px;max-height:220px;border-radius:8px;border:1px solid var(--line)}
button,.copy{font:inherit;cursor:pointer;border-radius:8px}
button[type=submit]{background:var(--accent);color:#fff;border:0;padding:12px 20px;font-weight:600;width:100%}
button[type=submit][disabled]{opacity:.6}
.copy{background:none;border:1px solid var(--line);color:var(--muted);padding:2px 10px;font-size:13px}
footer{color:var(--muted);font-size:13px;margin-top:28px}
`;

const SCRIPT = `
for (const el of document.querySelectorAll('[data-count]')) {
  const out = document.getElementById(el.dataset.count);
  const upd = () => { out.textContent = el.value.length + ' / ' + el.maxLength; };
  el.addEventListener('input', upd); upd();
}
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    const src = document.getElementById(b.dataset.copy);
    const text = 'value' in src ? src.value : src.textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Скопировано'; }
    catch { b.textContent = 'Не удалось'; }
    setTimeout(() => { b.textContent = 'Копировать'; }, 1500);
  });
}
for (const img of document.querySelectorAll('.photos img:not(#preview)')) {
  const hide = () => { img.closest('figure').hidden = true; };
  if (img.complete && img.naturalWidth === 0) hide();
  else img.addEventListener('error', hide);
}
const photo = document.getElementById('photo');
if (photo) photo.addEventListener('change', () => {
  const f = photo.files && photo.files[0];
  const img = document.getElementById('preview');
  if (f && img) { img.src = URL.createObjectURL(f); img.closest('figure').hidden = false; }
});
const form = document.querySelector('form');
if (form) form.addEventListener('submit', () => {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Отправляем…';
});
`;

function page(title: string, body: string, nonce: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${h(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<div class="brand">DH-центр ИТМО · персональная страница</div>
${body}
<footer>Ссылка личная, не пересылайте её. Вопросы — администратору центра.</footer>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

export function messagePage(title: string, text: string, nonce: string): string {
  return page(title, `<h1>${h(title)}</h1><p>${h(text)}</p>`, nonce);
}

export interface FormPageOptions {
  model: FormModel;
  nonce: string;
  photoUrl: (which: 'new' | 'current') => string;
  errors?: Partial<Record<FormErrorKey, string>>;
  saved?: boolean;
  comment?: string;
}

function titleOf(m: FormModel): string {
  const r = m.request;
  if (m.role === 'editor') return `Заявка ${r.requestId}`;
  if (r.type === 'create') return 'Анкета для страницы на сайте';
  if (r.type === 'update') return 'Обновление страницы';
  return 'Снятие страницы';
}

function fieldBlock(opts: FormPageOptions, key: FieldKey): string {
  const { model, errors } = opts;
  const def = FIELDS.find((f) => f.key === key)!;
  const r = model.request;
  const value = model.values[key];
  const id = `f_${key}`;
  const required = r.type === 'create' && def.requiredForCreate;
  const current = model.current?.fields[key] ?? '';
  const changed = r.type === 'update' && r.fields[key] !== undefined;
  const label = `<label for="${id}">${h(def.label)}${required ? ' <span class="req">*</span>' : ''}${
    model.role === 'editor' && changed ? ' · <span class="req">изменено</span>' : ''
  }</label>`;
  const copy =
    model.role === 'editor'
      ? `<button type="button" class="copy" data-copy="${id}">Копировать</button>`
      : '';

  let control: string;
  if (model.editable) {
    const common = `id="${id}" name="${id}" maxlength="${def.maxLength}" data-count="${id}_n"`;
    control = def.multiline
      ? `<textarea ${common} rows="${key === 'about' ? 10 : 5}">${h(value)}</textarea>`
      : `<input type="text" ${common} value="${h(value)}">`;
    control += `<div class="meta"><span id="${id}_n"></span>${copy}</div>`;
  } else {
    control = `<div class="value" id="${id}">${h(value) || '—'}</div>${copy ? `<div class="meta"><span></span>${copy}</div>` : ''}`;
  }
  const was =
    model.role === 'editor' && changed
      ? `<details><summary>Сейчас на сайте</summary><div class="value">${h(current) || '—'}</div></details>`
      : '';
  const err = errors?.[key] ? `<p class="error">${h(errors[key])}</p>` : '';
  return `<div class="field">${label}<p class="hint">${h(def.hint)}</p>${control}${err}${was}</div>`;
}

function photoBlock(opts: FormPageOptions): string {
  const { model, errors } = opts;
  const r = model.request;
  const figures: string[] = [];
  if (model.hasCurrentPhoto) {
    figures.push(
      `<figure><img src="${h(opts.photoUrl('current'))}" alt="Текущее фото">Сейчас на сайте</figure>`,
    );
  }
  if (model.hasNewPhoto) {
    figures.push(
      `<figure><img src="${h(opts.photoUrl('new'))}" alt="Новое фото">Новое, из заявки</figure>`,
    );
  }
  if (model.editable) figures.push('<figure hidden><img id="preview" alt="">Выбранное</figure>');
  const required =
    r.type === 'create' &&
    PHOTO_RULES.requiredForCreate &&
    !model.hasNewPhoto &&
    !model.hasCurrentPhoto;
  const input = model.editable
    ? `<input type="file" id="photo" name="photo" accept="${PHOTO_RULES.mimeTypes.join(',')}">
<p class="hint">JPEG, PNG или WebP, не меньше ${PHOTO_RULES.minSide} пикселей по короткой стороне, до ${Math.round(PHOTO_RULES.maxBytes / 1024 / 1024)} МБ. Отправляйте оригинал, без сжатия.</p>`
    : '';
  const download =
    model.role === 'editor' && model.hasNewPhoto
      ? `<p><a href="${h(opts.photoUrl('new'))}&download=1">Скачать новое фото в оригинале</a></p>`
      : '';
  const err = errors?.photo ? `<p class="error">${h(errors.photo)}</p>` : '';
  if (!figures.length && !input) return '';
  return `<div class="field"><label for="photo">${PHOTO_LABEL}${required ? ' <span class="req">*</span>' : ''}</label>
<div class="photos">${figures.join('')}</div>${input}${download}${err}</div>`;
}

export function formPage(opts: FormPageOptions): string {
  const { model, errors } = opts;
  const r = model.request;
  const title = titleOf(model);
  const parts: string[] = [
    `<h1>${h(title)}</h1>`,
    `<p class="who">${[
      r.fullName,
      model.role === 'editor' ? '' : r.requestId,
      REQUEST_TYPE_LABELS[r.type],
      STATUS_LABELS[r.status],
    ]
      .filter(Boolean)
      .map(h)
      .join(' · ')}</p>`,
  ];
  if (opts.saved) {
    parts.push(
      `<div class="box ok">${
        model.role === 'editor'
          ? 'Правки сохранены.'
          : 'Готово! Заявка у редактора. Бот напишет, когда страница будет обновлена.'
      }</div>`,
    );
  }
  if (model.notice) parts.push(`<div class="box">${h(model.notice)}</div>`);
  if (errors?.form) parts.push(`<div class="box err">${h(errors.form)}</div>`);
  else if (errors && Object.keys(errors).length) {
    parts.push('<div class="box err">Проверьте поля, отмеченные ниже.</div>');
  }
  if (model.current?.pageUrl) {
    parts.push(
      `<p>Страница сейчас: <a href="${h(model.current.pageUrl)}" rel="noreferrer" target="_blank">${h(model.current.pageUrl)}</a></p>`,
    );
  }

  if (r.type !== 'archive') {
    const blocks = FIELDS.map((f) => fieldBlock(opts, f.key)).join('\n') + photoBlock(opts);
    if (model.editable) {
      const comment =
        model.role === 'requester'
          ? `<div class="field"><label for="comment">Комментарий редактору</label>
<p class="hint">Необязательно. Например, что поменять в первую очередь или ответ на вопрос редактора.</p>
<textarea id="comment" name="comment" rows="3" maxlength="1000">${h(opts.comment ?? r.requesterNote ?? '')}</textarea></div>`
          : '';
      const button = model.role === 'editor' ? 'Сохранить правки' : 'Отправить редактору';
      parts.push(
        `<form method="post" enctype="multipart/form-data">${blocks}${comment}<button type="submit">${button}</button></form>`,
      );
    } else {
      parts.push(blocks);
      if (model.role === 'editor' && r.requesterNote) {
        parts.push(
          `<div class="field"><label>Комментарий заявителя</label><div class="value">${h(r.requesterNote)}</div></div>`,
        );
      }
    }
  }
  return page(title, parts.join('\n'), opts.nonce);
}
