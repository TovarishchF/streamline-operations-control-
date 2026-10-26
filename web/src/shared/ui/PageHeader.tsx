import type { JSX, ReactNode } from 'react';

/**
 * Верх каждого экрана: заголовок, строка сведений и действия (карточка
 * PageHeader дизайн-системы).
 *
 * Действия передаются в порядке «второстепенные, затем единственное
 * главное». Экраны раздела перечислены в рельсе под его пунктом, поэтому
 * вкладок раздела над страницей нет.
 */
export function PageHeader({
  title,
  meta,
  actions,
  titleHidden,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /**
   * Заголовок только для чтения с экрана: дашборд начинается с плиток,
   * а экрану всё равно нужен `h1`.
   */
  titleHidden?: boolean;
}): JSX.Element {
  return (
    <div className="soc-page-head">
      <div className="soc-page-head__text">
        <h1 className={titleHidden ? 'sr-only' : 'soc-page-title'}>{title}</h1>
        {meta ? <div className="soc-page-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="soc-page-actions">{actions}</div> : null}
    </div>
  );
}
