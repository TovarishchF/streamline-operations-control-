import type { JSX } from 'react';
import { DatePicker } from 'antd';
import type { DatePickerProps } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { useTranslation } from 'react-i18next';

import { useClockStore } from '@/shared/clock/useClock';

dayjs.extend(utc);

/**
 * Выбор даты и времени **в UTC** (`CLAUDE.md § 3` п. 2, § 10).
 *
 * Панель `DatePicker` работает в зоне браузера: диспетчер в Москве,
 * выбрав «12:00» в поле с подписью UTC, отправил бы 09:00Z. Поэтому
 * значение показывается панели «настенным» временем UTC, а выбранное
 * возвращается моментом UTC с тем же временем на циферблате.
 *
 * Два отличия от `DatePicker` по умолчанию, каждое из-за работы диспетчера:
 *
 * 1. **Шаг 5 минут.** Плановое время вылета кратно пяти; прокручивать список
 *    из шестидесяти минут, чтобы выбрать «:35», — лишняя работа.
 * 2. **«Сейчас» — по часам сервера.** Кнопка панели взяла бы часы браузера,
 *    а модельное время может быть сдвинуто (ADR-014).
 *
 * Лишняя прокрутка после последнего значения — это отступ, который Ant Design
 * добавляет колонке времени, чтобы любой элемент можно было поднять наверх.
 * Он убран в `app.css` (`.ant-picker-time-panel-column::after`).
 */

const WALL = 'YYYY-MM-DDTHH:mm:ss.SSS';

/**
 * Очищенное поле отдаёт `null`: объявление `DatePicker` об этом молчит,
 * и без явного типа проверка на пустое значение выглядела бы лишней.
 */
type UtcPickerProps = Omit<DatePickerProps, 'onChange'> & {
  onChange?: (value: Dayjs | null, text: string) => void;
};

/** Момент UTC → то же время на циферблате в зоне браузера, для панели. */
function toWall(value: Dayjs | null | undefined): Dayjs | null | undefined {
  return value ? dayjs(dayjs(value).utc().format(WALL)) : value;
}

/** Выбранное на панели → момент UTC с тем же временем на циферблате. */
function fromWall(value: Dayjs | null): Dayjs | null {
  return value ? dayjs.utc(value.format(WALL)) : null;
}

export function DateTimePicker({ value, onChange, ...props }: UtcPickerProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <DatePicker
      showTime={{ format: 'HH:mm', minuteStep: 5 }}
      // Показывается с подписью зоны; ввод принимается и без неё.
      format={['DD.MM.YYYY HH:mm[Z]', 'DD.MM.YYYY HH:mm']}
      showNow={false}
      placeholder={t('common.dateTimeUtcPlaceholder')}
      // Пресет, а не своя кнопка: выбор пресета панель принимает и закрывает
      // сама, как штатное «Сейчас». Значение берётся в момент выбора.
      presets={[
        {
          label: t('common.nowUtc'),
          value: () => toWall(dayjs.utc(useClockStore.getState().nowUtc).second(0).millisecond(0)) as Dayjs,
        },
      ]}
      {...props}
      value={toWall(value)}
      onChange={(picked) => {
        const next = fromWall(picked);
        onChange?.(next, next ? next.format('DD.MM.YYYY HH:mm') : '');
      }}
    />
  );
}

/** Дата без времени: полночь UTC выбранного дня. */
export function DateOnlyPicker({ value, onChange, ...props }: UtcPickerProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <DatePicker
      format="DD.MM.YYYY"
      placeholder={t('common.datePlaceholder')}
      {...props}
      value={toWall(value)}
      onChange={(picked) => {
        const next = fromWall(picked);
        onChange?.(next, next ? next.format('DD.MM.YYYY') : '');
      }}
    />
  );
}
