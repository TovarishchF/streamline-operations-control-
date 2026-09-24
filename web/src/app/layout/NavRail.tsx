import { useMemo, type JSX } from 'react';
import { Typography } from 'antd';
import {
  ApiOutlined,
  BarChartOutlined,
  BookOutlined,
  DollarOutlined,
  EnvironmentOutlined,
  InboxOutlined,
  MailOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { usePayables } from '@/api/billing';
import { useFlightRequests } from '@/api/flights';
import { useHealth } from '@/api/system';
import { SOC_COLORS, SOC_DENSITY, SOC_RADIUS } from '@/app/theme';
import { useDemoMode, usePermissionMap } from '@/shared/auth/session';
import { NAV_GROUPS, NAV_PATHS, type NavItem } from './navigation';

/**
 * Светлый рельс навигации.
 *
 * Во второй версии дизайн-системы рельс переехал с `brand-ink` на `surface`:
 * тёмно-синий блок шириной 216 px забирал внимание весь рабочий день,
 * а сообщать ему нечего — навигация неподвижна. Тёмное осталось полосе
 * со знаком.
 *
 * Девять пунктов в трёх группах — состав задан системой. Экраны, не попавшие
 * в девятку, живут вкладками внутри раздела (`SectionTabs`).
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

function visibleItems(
  permissions: Readonly<Record<string, boolean>>,
  demoMode: boolean,
): { key: string; labelKey: string; items: NavItem[] }[] {
  return NAV_GROUPS.map((group) => ({
    key: group.key,
    labelKey: group.labelKey,
    // Пункт виден, если роль имеет право хотя бы на один его экран:
    // раздел из одних недоступных вкладок — тупик.
    items: group.items.filter((item) => {
      if (item.demoOnly === true && !demoMode) return false;
      const screens = [item, ...(item.children ?? [])];
      return screens.some((screen) => permissions[screen.permission] === true);
    }),
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

export function NavRail({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const permissions = usePermissionMap();
  const demoMode = useDemoMode();
  const badges = useRailBadges();
  // Версия берётся с сервера, а не пишется в разметке: подпись, которую
  // забыли обновить, хуже отсутствующей.
  const health = useHealth();

  const groups = useMemo(
    () => visibleItems(permissions, demoMode),
    [permissions, demoMode],
  );

  const current = activePath(location.pathname);

  return (
    <nav
      aria-label={t('nav.menu')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 12,
        gap: 14,
        overflowY: 'auto',
      }}
    >
      {groups.map((group) => (
        <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Заголовок группы набирается прописными в разметке, а не токеном:
              в русском прописная кириллица шире латиницы, и длинное слово
              распирало бы рельс. */}
          <Typography.Text
            style={{
              padding: '0 10px 4px',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              color: SOC_COLORS.inkTertiary,
            }}
          >
            {t(group.labelKey).toLocaleUpperCase('ru')}
          </Typography.Text>

          {group.items.map((item) => {
            const isActive =
              current !== null &&
              (item.path === current ||
                (item.children ?? []).some((child) => child.path === current));
            const badge = badges[item.key];

            return (
              <Link
                key={item.key}
                to={item.path}
                onClick={onNavigate}
                aria-current={isActive ? 'page' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: SOC_DENSITY.controlHeight,
                  paddingInline: 10,
                  borderRadius: SOC_RADIUS.control,
                  // Активный пункт несёт подложку, границу и цвет действия.
                  // Полоса-акцент слева не используется.
                  background: isActive ? SOC_COLORS.brand100 : 'transparent',
                  border: `1px solid ${isActive ? SOC_COLORS.brand200 : 'transparent'}`,
                  color: isActive ? SOC_COLORS.brand : SOC_COLORS.inkSecondary,
                  fontWeight: isActive ? 500 : 400,
                  textDecoration: 'none',
                }}
              >
                <span style={{ fontSize: 16, display: 'flex' }} aria-hidden="true">
                  {ICONS[item.icon]}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t(item.labelKey)}
                </span>
                {badge !== undefined ? (
                  // Счётчик моноширинный: 6 и 18 не должны менять ширину пункта.
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: isActive ? SOC_COLORS.brand : SOC_COLORS.inkTertiary,
                    }}
                  >
                    {badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '8px 10px 0',
          borderTop: `1px solid ${SOC_COLORS.surfaceLine}`,
          fontSize: 11,
          color: SOC_COLORS.inkTertiary,
        }}
      >
        {demoMode ? <span>{t('nav.footDemo')}</span> : null}
        {health.data ? (
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            SOC {health.data.version}
          </span>
        ) : null}
      </div>
    </nav>
  );
}
