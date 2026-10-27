import { Suspense, useCallback, useEffect, useState, type JSX } from 'react';
import { Button, Drawer, Dropdown, Layout, Skeleton, Tooltip } from 'antd';
import { BellOutlined, MenuOutlined, SearchOutlined } from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES } from '@/shared/i18n';
import { useClock, useClockTicker, formatUtc } from '@/shared/clock/useClock';
import { formatLocalTime, zoneAbbreviation } from '@/shared/format/timezone';
import { useCurrentUser, useSampleDataMode, useSession } from '@/shared/auth/session';
import { SOC_DENSITY } from '@/app/theme';
import { useNotifications } from '@/api/comms';
import { useHealth } from '@/api/system';
import { NavRail, breadcrumb } from './NavRail';
import { NotificationCentre } from './NotificationCentre';
import { ModelClockPanel } from './ModelClockPanel';
import { CommandPalette } from './CommandPalette';

/** Инициалы для аватара: первая буква первого и последнего слова имени. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase('ru');
}

/** Имя в шапке: имя и фамилия, без отчества — полное имя в подсказке. */
function shortName(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.length > 2 ? `${words[0] ?? ''} ${words[words.length - 1] ?? ''}` : name;
}

/**
 * Пользователь: аватар, имя и роль; в меню — язык, версия, смена
 * сотрудника и выход.
 *
 * Переключателя ролей нет: обход аутентификации запрещён (ADR-013).
 * Чтобы посмотреть систему глазами другой роли, нужно войти под другим
 * пользователем.
 */
function UserMenu(): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const user = useCurrentUser();
  const signOut = useSession((s) => s.signOut);
  const navigate = useNavigate();
  // Версия берётся с сервера, а не пишется в разметке: подпись, которую
  // забыли обновить, хуже отсутствующей.
  const health = useHealth();

  if (!user) return null;

  const language = i18n.language.startsWith('en') ? 'en' : 'ru';

  // «Сменить сотрудника» — это выход и новый вход, а не подмена роли.
  // От обычного выхода отличается тем, куда приводит: на вход со списком
  // учётных записей, а не на пустую форму.
  const items = [
    {
      key: 'language',
      label: t('common.language'),
      children: SUPPORTED_LOCALES.map((code) => ({
        key: `lang:${code}`,
        label: code.toUpperCase(),
        disabled: code === language,
        onClick: () => {
          void i18n.changeLanguage(code);
        },
      })),
    },
    { type: 'divider' as const },
    {
      key: 'switchUser',
      label: t('auth.switchUser'),
      onClick: () => {
        void signOut().then(() => {
          navigate('/login?switch=1');
        });
      },
    },
    {
      key: 'signOut',
      label: t('auth.signOut'),
      onClick: () => {
        void signOut().then(() => {
          navigate('/login');
        });
      },
    },
    ...(health.data
      ? [
          { type: 'divider' as const },
          { key: 'version', label: `SOC ${health.data.version}`, disabled: true },
        ]
      : []),
  ];

  return (
    <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
      <button type="button" className="soc-user" title={user.name}>
        <span className="soc-avatar" aria-hidden="true">{initials(user.name)}</span>
        <span className="soc-user__text soc-hide-sm">
          <span className="soc-user__name">{shortName(user.name)}</span>
          <span className="soc-user__role">{t(`roles.${user.role}`)}</span>
        </span>
      </button>
    </Dropdown>
  );
}

/**
 * Часы: UTC, затем местное время пользователя с подписью зоны.
 * Голое `12:40` — дефект: время в шапке всегда с зоной.
 */
function DualClock(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc, shifted } = useClock();
  const user = useCurrentUser();
  const timeZone = user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Tooltip title={shifted ? t('clock.shiftedHint') : t('clock.utcHint')}>
      <div className={shifted ? 'soc-clock is-shifted' : 'soc-clock'}>
        <span>{formatUtc(nowUtc)}</span>
        <span className="soc-clock__sep" aria-hidden="true" />
        <span className="soc-clock__lt">
          {formatLocalTime(timeZone, nowUtc)} {zoneAbbreviation(timeZone, nowUtc)}
        </span>
      </div>
    </Tooltip>
  );
}

/** Состояние свёрнутого рельса — своё у каждого пользователя на этом устройстве. */
function useRailCollapsed(userId: string | undefined): [boolean, () => void] {
  const key = `soc.rail.collapsed.${userId ?? 'anonymous'}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(key, value ? '0' : '1');
      } catch {
        // Хранилище недоступно (приватный режим) — рельс просто не запомнит выбор.
      }
      return !value;
    });
  }, [key]);

  return [collapsed, toggle];
}

/**
 * Обвязка внутренних экранов (карточки AppShell, NavRail, TopBar).
 *
 * Слева тёмный рельс, справа шапка на `surface` и область содержимого
 * на `canvas`. Ниже 1024 px рельс уходит в выдвижную панель.
 */
export function AppLayout(): JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const user = useCurrentUser();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useRailCollapsed(user?.id);
  useClockTicker();

  // Непрочитанные считает сервер своей выборкой: колокольчик показывает
  // ровно то, что лежит в центре уведомлений.
  const unread = useNotifications(true).data?.meta.total ?? 0;
  const sampleData = useSampleDataMode();
  const crumbs = breadcrumb(location.pathname);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const clock = <DualClock />;

  return (
    <Layout className="soc soc-shell" hasSider>
      <Layout.Sider
        width={SOC_DENSITY.railWidth}
        collapsedWidth={SOC_DENSITY.railWidthCollapsed}
        collapsed={collapsed}
        trigger={null}
        className={collapsed ? 'soc-rail is-collapsed' : 'soc-rail'}
      >
        <NavRail collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </Layout.Sider>

      <Layout className="soc-main">
        <Layout.Header className="soc-topbar">
          <Button
            className="soc-burger"
            type="text"
            icon={<MenuOutlined />}
            onClick={() => {
              setDrawerOpen(true);
            }}
            aria-label={t('nav.menu')}
          />

          <div className="soc-crumbs">
            {crumbs ? (
              <>
                <span className="soc-crumbs__section">{t(crumbs.sectionKey)}</span>
                <span className="soc-crumbs__sep" aria-hidden="true">/</span>
                <span className="soc-crumbs__page">{t(crumbs.pageKey)}</span>
              </>
            ) : (
              <span className="soc-crumbs__page">{t('app.fullName')}</span>
            )}
          </div>

          <button
            type="button"
            className="soc-search soc-hide-sm"
            onClick={() => {
              setPaletteOpen(true);
            }}
            aria-label={t('nav.search')}
          >
            <SearchOutlined />
            <span className="soc-search__text">{t('nav.searchPlaceholder')}</span>
            <span className="soc-kbd">Ctrl K</span>
          </button>

          {/* В режиме генератора часы открывают управление модельным временем. */}
          <span className="soc-hide-sm">
            {sampleData ? <ModelClockPanel>{clock}</ModelClockPanel> : clock}
          </span>

          <button
            type="button"
            className="soc-iconbtn"
            onClick={() => {
              setNotificationsOpen(true);
            }}
            aria-label={`${t('nav.notifications')}: ${String(unread)}`}
          >
            <BellOutlined />
            {unread > 0 ? <span className="soc-count">{unread}</span> : null}
          </button>

          <UserMenu />
        </Layout.Header>

        <Layout.Content className="soc-content">
          {/* Экран грузится при первом открытии: меню и шапка остаются на месте. */}
          <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
            <Outlet />
          </Suspense>
        </Layout.Content>
      </Layout>

      <Drawer
        placement="left"
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        width={SOC_DENSITY.railWidth}
        closable={false}
        rootClassName="soc-rail-drawer"
      >
        <NavRail
          onNavigate={() => {
            setDrawerOpen(false);
          }}
        />
      </Drawer>

      <NotificationCentre
        open={notificationsOpen}
        onClose={() => {
          setNotificationsOpen(false);
        }}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
      />
    </Layout>
  );
}
