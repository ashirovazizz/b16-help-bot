import { Cron } from 'croner';
import type { Logger } from './core/logger.js';
import type { RequestService } from './services/service.js';

export interface SchedulerOptions {
  tz: string;
  syncMinutes: number;
  log: Logger;
  alert: (text: string) => Promise<void>;
}

/**
 * Расписание: сверка с реестром, автоподтверждение и истечение черновиков,
 * ежедневная сводка во время из листа Settings.
 */
export async function startScheduler(service: RequestService, opts: SchedulerOptions) {
  const { tz, log } = opts;
  const failing = new Set<string>();

  const safe = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      if (failing.delete(name)) log.info(`Задача ${name} снова работает`);
    } catch (error) {
      log.error(`Сбой задачи ${name}`, { error });
      // тревога один раз, пока задача не восстановится
      if (!failing.has(name)) {
        failing.add(name);
        await opts.alert(`⚠️ Сбой задачи «${name}»: ${String(error)}`).catch(() => {});
      }
    }
  };

  const jobs: Cron[] = [
    new Cron(
      `*/${opts.syncMinutes} * * * *`,
      { timezone: tz, protect: true },
      safe('сверка с реестром', () => service.syncRegistry()),
    ),
    new Cron(
      '*/10 * * * *',
      { timezone: tz, protect: true },
      safe('таймеры заявок', () => service.tick()),
    ),
  ];

  let digest: Cron | undefined;
  let digestAt = '';
  const scheduleDigest = async () => {
    const time = await service.digestTime();
    if (time === digestAt && digest) return;
    const [hh = '10', mm = '00'] = time.split(':');
    digest?.stop();
    digest = new Cron(
      `${Number(mm)} ${Number(hh)} * * *`,
      { timezone: tz, protect: true },
      safe('ежедневная сводка', () => service.daily()),
    );
    digestAt = time;
    log.info('Сводка по расписанию', { time });
  };
  await safe('расписание сводки', scheduleDigest)();
  // время сводки берётся из Settings — раз в час проверяем, не поменяли ли его
  jobs.push(
    new Cron(
      '7 * * * *',
      { timezone: tz, protect: true },
      safe('расписание сводки', scheduleDigest),
    ),
  );

  return {
    stop() {
      for (const j of jobs) j.stop();
      digest?.stop();
    },
  };
}
