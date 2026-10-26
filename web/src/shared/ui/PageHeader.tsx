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
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="soc-page-head">
      <div className="soc-page-head__text">
        <h1 className="soc-page-title">{title}</h1>
        {meta ? <div className="soc-page-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="soc-page-actions">{actions}</div> : null}
    </div>
  );
}
