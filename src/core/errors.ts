/**
 * Ошибка, текст которой можно показать человеку: «заявку ведёт Вика»,
 * «ссылка устарела» и т. п. Всё остальное — внутренние ошибки.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function isUserError(e: unknown): e is UserError {
  return e instanceof UserError;
}
