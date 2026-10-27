/**
 * Пресеты фильтров и настройка колонок суточного плана (`SPEC.md § 4.2`).
 *
 * Хранятся в браузере через localforage (G-20, ADR-015): это настройки
 * рабочего места, а не данные системы. Ключ — пользователь: на одном
 * компьютере диспетчеры сменяются, и чужие пресеты в списке — помеха.
 *
 * Прочитанное проверяется схемой: хранилище браузера — внешние данные
 * (`CLAUDE.md § 3` п. 15), там может лежать запись прошлой версии.
 */
import localforage from 'localforage';
import { z } from 'zod';

import { flightStatusSchema } from '@/api/flights';

const store = localforage.createInstance({ name: 'soc', storeName: 'schedule' });

export const tableFiltersSchema = z.object({
  search: z.string().default(''),
  /** Период по дате вылета, дни UTC `YYYY-MM-DD`. */
  from: z.string().optional(),
  to: z.string().optional(),
  statuses: z.array(flightStatusSchema).default([]),
  clientId: z.string().optional(),
  aircraftId: z.string().optional(),
  aircraftTypeId: z.string().optional(),
  type: z.string().optional(),
  airport: z.string().optional(),
  unconfirmed: z.enum(['any', 'yes', 'no']).default('any'),
  /** «Маржа ниже N %» — десятичная строка, как в контракте. */
  marginBelow: z.string().optional(),
});

export type TableFilters = z.infer<typeof tableFiltersSchema>;

export const EMPTY_FILTERS: TableFilters = { search: '', statuses: [], unconfirmed: 'any' };

const presetsSchema = z.array(z.object({ name: z.string().min(1), filters: tableFiltersSchema }));

export type SchedulePreset = z.infer<typeof presetsSchema>[number];

const columnsSchema = z.array(z.string());

export async function loadPresets(userId: string): Promise<SchedulePreset[]> {
  const parsed = presetsSchema.safeParse(await store.getItem(`presets:${userId}`));
  return parsed.success ? parsed.data : [];
}

export async function savePresets(userId: string, presets: SchedulePreset[]): Promise<void> {
  await store.setItem(`presets:${userId}`, presets);
}

/** Скрытые колонки таблицы. `null` — настройку не меняли. */
export async function loadHiddenColumns(userId: string): Promise<string[] | null> {
  const parsed = columnsSchema.safeParse(await store.getItem(`hidden-columns:${userId}`));
  return parsed.success ? parsed.data : null;
}

export async function saveHiddenColumns(userId: string, keys: string[]): Promise<void> {
  await store.setItem(`hidden-columns:${userId}`, keys);
}
