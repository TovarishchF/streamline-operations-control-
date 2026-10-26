import type { JSX, ReactNode } from 'react';

/**
 * Число дашборда: подпись, значение, строка контекста
 * (карточка KpiTile дизайн-системы).
 *
 * Значение приходит готовым: плитка ничего не считает. `tone` красит
 * только значение — у плитки нет цветных рамок и значков в кружках.
 */
export function KpiTile({
  label,
  value,
  unit,
  tone = 'default',
  extra,
  footnote,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: 'default' | 'warning' | 'critical';
  /** Пилюля в строке подписи. */
  extra?: ReactNode;
  footnote?: ReactNode;
}): JSX.Element {
  return (
    <div className="soc-kpi">
      <div className="soc-kpi__label">
        <span>{label}</span>
        {extra}
      </div>
      <div className="soc-kpi__row">
        <div className={tone === 'default' ? 'soc-kpi__value' : `soc-kpi__value is-${tone}`}>
          {value}
          {unit ? <small>{unit}</small> : null}
        </div>
      </div>
      <div className="soc-kpi__foot">{footnote}</div>
    </div>
  );
}
