import { useMemo, type JSX } from 'react';
import { Select } from 'antd';
import { useTranslation } from 'react-i18next';

import countries from '@shared/reference/countries.json';

/**
 * Выбор страны по коду ISO 3166-1 alpha-2.
 *
 * Названия берутся из ICU браузера (`Intl.DisplayNames`) на языке
 * интерфейса, а не хранятся в словаре: так они совпадают с системными,
 * не требуют перевода двухсот строк и не устаревают. Коды приходят
 * из общего справочника — того же, по которому сервер проверяет ввод.
 */
export function CountrySelect({
  value,
  onChange,
  placeholder,
  style,
}: {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  const { i18n } = useTranslation();
  const locale = i18n.language.startsWith('en') ? 'en' : 'ru';

  const options = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    return countries.codes
      .map((code) => ({
        value: code,
        // Код остаётся в подписи: в документах и переписке страну
        // называют двумя буквами, и сопоставить их нужно глазами.
        label: `${names.of(code) ?? code} · ${code}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale]);

  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      value={value || undefined}
      onChange={(next: string | undefined) => {
        onChange?.(next ?? '');
      }}
      placeholder={placeholder}
      options={options}
      style={style}
    />
  );
}
