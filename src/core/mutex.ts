/**
 * Все изменения идут через один замок: сообщения бота, отправка формы и
 * таймеры не должны одновременно читать и переписывать одни и те же строки таблицы.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
