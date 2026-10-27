import { useState, type CSSProperties, type JSX } from 'react';
import { Select } from 'antd';

import { useAirports } from '@/api/catalog';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';

/**
 * Выбор аэропорта с поиском на сервере.
 *
 * В справочнике полторы тысячи аэропортов: список первых двухсот, отобранный
 * в браузере, просто не содержал бы нужного. Ищет сервер — по коду ICAO,
 * городу и наименованию.
 */
export function AirportSelect({
  value,
  onChange,
  allowClear,
  disabled,
  placeholder,
  style,
  'aria-label': ariaLabel,
}: {
  value?: string | null;
  onChange?: (value: string | undefined) => void;
  allowClear?: boolean;
  disabled?: boolean;
  placeholder?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}): JSX.Element {
  const localized = useLocalizedName();
  const [search, setSearch] = useState('');
  const airports = useAirports({ search, perPage: 30 });

  const options = (airports.data?.data ?? []).map((airport) => ({
    value: airport.icao,
    label: `${airport.icao} — ${airport.city || localized(airport.name)}`,
  }));
  // Выбранный аэропорт может не попасть в текущую выдачу поиска,
  // а поле должно показывать его код, а не пустоту.
  if (value && !options.some((option) => option.value === value)) {
    options.unshift({ value, label: value });
  }

  return (
    <Select<string>
      showSearch
      filterOption={false}
      onSearch={setSearch}
      loading={airports.isFetching}
      options={options}
      value={value ?? undefined}
      onChange={(next) => {
        onChange?.(next);
      }}
      onClear={() => {
        onChange?.(undefined);
      }}
      {...(allowClear ? { allowClear } : {})}
      {...(disabled ? { disabled } : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(style ? { style } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
    />
  );
}
