import { useEffect, useMemo, useState, type JSX } from 'react';
import { Popover, Tooltip } from 'antd';
import {
  ApiOutlined,
  BarChartOutlined,
  BookOutlined,
  DollarOutlined,
  DownOutlined,
  EnvironmentOutlined,
  InboxOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MailOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { usePayables } from '@/api/billing';
import { useFlightRequests } from '@/api/flights';
import { useSampleDataMode, usePermissionMap } from '@/shared/auth/session';
import { NAV_GROUPS, NAV_PATHS, type NavItem } from './navigation';

/**
 * Рельс навигации (дизайн-система v3, карточка NavRail).
 *
 * Рельс — единственная тёмная насыщенная область (`chrome`): рамка вокруг
 * данных. Внутри области содержимого цвет означает только состояние.
 *
 * Девять пунктов в трёх группах — состав задан системой. Экраны, не попавшие
 * в девятку, раскрываются под пунктом своего раздела после нажатия на него;
 * в свёрнутом рельсе — всплывающим списком справа от значка.
 *
 * Пункт — настоящая ссылка: `div` с обработчиком клавиатура пропускает.
 */

const ICONS: Record<string, JSX.Element> = {
  Schedule: <ScheduleOutlined />,
  Inbox: <InboxOutlined />,
  Environment: <EnvironmentOutlined />,
  Mail: <MailOutlined />,
  Dollar: <DollarOutlined />,
  BarChart: <BarChartOutlined />,
  Team: <TeamOutlined />,
  Book: <BookOutlined />,
  Api: <ApiOutlined />,
};

/**
 * Счётчики у пунктов.
 *
 * Счётчик показывает **то, что требует действия**, а не общее число записей:
 * «18 рейсов» диспетчеру ничего не говорит, «6 заявок ждут решения» —
 * говорит. Там, где такого числа нет, счётчика нет: выдуманных чисел
 * в интерфейсе не бывает (`CLAUDE.md § 4`).
 */
function useRailBadges(): Record<string, string | undefined> {
  const permissions = usePermissionMap();
  // Рельс висит на каждом экране: запрос без права уходил бы с каждого
  // и возвращал 403. Право проверяется до запроса, а не после ответа.
  const requests = useFlightRequests('pending', permissions['request.approve'] === true);
  const overdue = usePayables({
    overdue: true,
    enabled: permissions['billing.payables.view'] === true,
  });

  const pending = requests.data?.meta.total;
  const unpaid = overdue.data?.meta.total;

  return {
    requests: pending !== undefined && pending > 0 ? String(pending) : undefined,
    billing: unpaid !== undefined && unpaid > 0 ? String(unpaid) : undefined,
  };
}

export function visibleItems(
  permissions: Readonly<Record<string, boolean>>,
  sampleData: boolean,
): { key: string; labelKey: string; items: NavItem[] }[] {
  return NAV_GROUPS.map((group) => ({
    key: group.key,
    labelKey: group.labelKey,
    // Пункт виден, если роль имеет право хотя бы на один его экран:
    // раздел из одних недоступных вкладок — тупик.
    items: group.items
      .filter((item) => {
        if (item.sampleDataOnly === true && !sampleData) return false;
        const screens = [item, ...(item.children ?? [])];
        return screens.some((screen) => permissions[screen.permission] === true);
      })
      .map((item) => ({
        ...item,
        children: item.children?.filter((child) => child.sampleDataOnly !== true || sampleData),
      })),
  })).filter((group) => group.items.length > 0);
}

/**
 * Активный пункт — с самым длинным совпадающим префиксом пути.
 *
 * Иначе на карточке рейса подсветятся два пункта сразу или ни одного.
 */
export function activePath(pathname: string): string | null {
  const match = NAV_PATHS.filter(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  ).sort((a, b) => b.length - a.length)[0];
  return match ?? null;
}

/** Крошки шапки: раздел рельса и экран внутри него. */
export function breadcrumb(pathname: string): { sectionKey: string; pageKey: string } | null {
  const current = activePath(pathname);
  if (current === null) return null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const child = (item.children ?? []).find((c) => c.path === current);
      // Первый экран раздела зовётся как сам раздел: «Суточный план /
      // Суточный план» ничего не говорит, над ней стоит группа рельса.
      if (child && child.labelKey === item.labelKey) {
        return { sectionKey: group.labelKey, pageKey: child.labelKey };
      }
      if (child) return { sectionKey: item.labelKey, pageKey: child.labelKey };
      if (item.path === current) return { sectionKey: group.labelKey, pageKey: item.labelKey };
    }
  }
  return null;
}

/**
 * Рельс навигации на тёмной полосе (карточка NavRail дизайн-системы).
 *
 * Свёрнутый (64 px) — только значки с подсказкой, счётчики превращаются
 * в точки, знак заменяется словом SOC: уменьшенный знак не читается.
 */
export function NavRail({
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const permissions = usePermissionMap();
  const sampleData = useSampleDataMode();
  const badges = useRailBadges();

  const groups = useMemo(
    () => visibleItems(permissions, sampleData),
    [permissions, sampleData],
  );

  const current = activePath(location.pathname);
  const activeKey = groups
    .flatMap((group) => group.items)
    .find(
      (item) =>
        item.path === current || (item.children ?? []).some((child) => child.path === current),
    )?.key;

  // Раскрыт раздел, в котором пользователь находится; переход в другой
  // раздел сворачивает прежний. Повторное нажатие на раскрытый — сворачивает.
  const [openKey, setOpenKey] = useState(activeKey);
  useEffect(() => {
    setOpenKey(activeKey);
  }, [activeKey, location.pathname]);

  return (
    <div className="soc-rail__inner">
      {/* Белая версия знака — только на тёмной обвязке. */}
      <Link to="/" className="soc-rail__brand" onClick={onNavigate}>
        {collapsed ? (
          <span className="soc-rail__soc">{t('app.name')}</span>
        ) : (
          <>
            <img src="/brand/streamline-fs-white.png" alt={t('app.fullName')} />
            <span className="soc-rail__product">{t('app.name')}</span>
          </>
        )}
      </Link>

      <nav aria-label={t('nav.menu')} className="soc-rail__nav">
        {groups.map((group) => (
          <div key={group.key} className="soc-rail__group">
            <div className="soc-rail__label">{t(group.labelKey)}</div>

            {group.items.map((item) => {
              const isActive =
                current !== null &&
                (item.path === current ||
                  (item.children ?? []).some((child) => child.path === current));
              const badge = badges[item.key];
              const label = t(item.labelKey);
              // Подпункты — только когда их больше одного: один ничего
              // не добавляет к самому пункту.
              const children = (item.children ?? []).filter(
                (child) => permissions[child.permission] === true,
              );
              const sectioned = children.length > 1;
              const expandable = !collapsed && sectioned;
              const open = expandable && openKey === item.key;
              const childLink = (
                child: (typeof children)[number],
                className: string,
                hidden = false,
              ): JSX.Element => (
                <Link
                  key={child.key}
                  to={child.path}
                  onClick={onNavigate}
                  tabIndex={hidden ? -1 : undefined}
                  aria-current={child.path === current ? 'page' : undefined}
                  className={child.path === current ? `${className} is-active` : className}
                >
                  {t(child.labelKey)}
                </Link>
              );

              const link = (
                <Link
                  key={item.key}
                  to={item.path}
                  onClick={() => {
                    if (expandable) setOpenKey(open && isActive ? undefined : item.key);
                    // Выдвижная панель закрывается, только когда раскрывать нечего:
                    // иначе подпункты исчезли бы вместе с ней.
                    if (!expandable) onNavigate?.();
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  aria-expanded={expandable ? open : undefined}
                  aria-label={collapsed ? label : undefined}
                  className={isActive ? 'soc-rail__item is-active' : 'soc-rail__item'}
                >
                  <span className="soc-rail__icon" aria-hidden="true">
                    {ICONS[item.icon]}
                  </span>
                  {collapsed ? null : <span className="soc-rail__text">{label}</span>}
                  {badge !== undefined ? <span className="soc-count">{badge}</span> : null}
                  {expandable ? <DownOutlined className="soc-rail__chevron" aria-hidden /> : null}
                </Link>
              );

              if (collapsed && sectioned) {
                // Подпункты свёрнутого рельса — во всплывающем списке:
                // иначе экраны раздела были бы недостижимы.
                return (
                  <Popover
                    key={item.key}
                    title={label}
                    placement="rightTop"
                    arrow={false}
                    trigger={['hover', 'focus']}
                    classNames={{ root: 'soc-rail-flyout' }}
                    content={
                      <div className="soc-rail-flyout__list">
                        {children.map((child) => childLink(child, 'soc-rail-flyout__item'))}
                      </div>
                    }
                  >
                    {link}
                  </Popover>
                );
              }
              if (collapsed) {
                return (
                  <Tooltip key={item.key} title={label} placement="right">
                    {link}
                  </Tooltip>
                );
              }
              if (!expandable) return link;

              return (
                <div key={item.key} className={open ? 'soc-rail__section is-open' : 'soc-rail__section'}>
                  {link}
                  {/* Высота анимируется через grid-template-rows: 0fr → 1fr. */}
                  <div className="soc-rail__sub" aria-hidden={!open}>
                    <div className="soc-rail__sub-inner">
                      {children.map((child) => childLink(child, 'soc-rail__subitem', !open))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      {onToggleCollapsed ? (
        <button type="button" className="soc-rail__toggle" onClick={onToggleCollapsed}>
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          {collapsed ? (
            <span className="sr-only">{t('nav.expand')}</span>
          ) : (
            <span>{t('nav.collapse')}</span>
          )}
        </button>
      ) : null}
    </div>
  );
}
