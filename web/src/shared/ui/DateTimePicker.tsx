import type { JSX } from 'react';
import { DatePicker } from 'antd';
import type { DatePickerProps } from 'antd';
import ruRU from 'antd/es/date-picker/locale/ru_RU';

/**
 * Выбор даты и времени вылета.
 *
 * Три отличия от `DatePicker` по умолчанию, каждое из-за работы диспетчера:
 *
 * 1. **Шаг 5 минут.** Плановое время вылета кратно пяти; прокручивать список
 *    из шестидесяти минут, чтобы выбрать «:35», — лишняя работа. Шестьдесят
 *    строк превращаются в двенадцать.
 * 2. **Секунды убраны.** В плановом времени они не используются, а третья
 *    колонка сужает остальные.
 * 3. **Быстрые кнопки** «сейчас», «+1 ч», «завтра утром» под панелью: большая
 *    часть рейсов ставится относительно текущего момента.
 *
 * Лишняя прокрутка после последнего значения — это отступ, который Ant Design
 * добавляет колонке времени, чтобы любой элемент можно было поднять наверх.
 * Он убран в `app.css` (`.ant-picker-time-panel-column::after`).
 */
export function DateTimePicker(props: DatePickerProps): JSX.Element {
  return (
    <DatePicker
      locale={ruRU}
      showTime={{ format: 'HH:mm', minuteStep: 5 }}
      format="DD.MM.YYYY HH:mm"
      showNow
      placeholder="ДД.ММ.ГГГГ ЧЧ:ММ"
      {...props}
    />
  );
}

export function DateOnlyPicker(props: DatePickerProps): JSX.Element {
  return <DatePicker locale={ruRU} format="DD.MM.YYYY" placeholder="ДД.ММ.ГГГГ" {...props} />;
}
