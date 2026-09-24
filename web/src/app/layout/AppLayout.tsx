import { useState, type JSX } from 'react';
import {
  Badge, Button, Drawer, Dropdown, Layout, Select, Space, Tag, Tooltip, Typography,
} from 'antd';
import { BellOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, type Locale } from '@/shared/i18n';
import { useClock, useClockTicker, formatUtc } from '@/shared/clock/useClock';
import { useCurrentUser, useDemoMode, useSession } from '@/shared/auth/session';
import { SOC_COLORS, SOC_DENSITY } from '@/app/theme';
import { useNotifications } from '@/api/comms';
import { NavRail } from './NavRail';
import { SectionTabs } from './SectionTabs';
import { NotificationCentre } from './NotificationCentre';
import { DemoClockPanel } from './DemoClockPanel';

function LocaleSwitch(): JSX.Element {
  const { t, i18n } = useTranslation();
  return (
    <Select<Locale>
      size="small"
      value={i18n.language.startsWith('en') ? 'en' : 'ru'}
      onChange={(value) => {
        void i18n.changeLanguage(value);
      }}
      options={SUPPORTED_LOCALES.map((code) => ({ value: code, label: code.toUpperCase() }))}
      style={{ width: 68 }}
      aria-label={t('common.language')}
    />
  );
}

/**
 * Переключатель роли.
 *
 * Профиль и выход. Переключателя ролей нет: обход аутентификации запрещён
 * (ADR-013). Чтобы посмотреть систему глазами другой роли, нужно войти
 * под другим пользователем.
 */
function UserMenu(): JSX.Element | null {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const signOut = useSession((s) => s.signOut);
  const navigate = useNavigate();

  if (!user) return null;

  // «Сменить сотрудника» — это выход и новый вход, а не подмена роли:
  // обход аутентификации запрещён (ADR-013). От обычного выхода отличается
  // тем, куда приводит: на вход со списком учётных записей, а не на пустую
  // форму.
  const items = [
    {
      key: 'switchUser',
      label: t('auth.switchUser'),
      onClick: () => {
        void signOut().then(() => {
          navigate('/login?switch=1');
        });
      },
    },
    { type: 'divider' as const },
    {
      key: 'signOut',
      label: t('auth.signOut'),
      onClick: () => {
        void signOut().then(() => {
          navigate('/login');
        });
      },
    },
  ];

  return (
    <Dropdown menu={{ items }} trigger={['click']}>
      {/* Имя урезается по ширине: настоящие имена с отчеством длиннее
          выдуманных и на узком экране распирали шапку. */}
      <Button size="small" icon={<UserOutlined />} className="soc-user-button">
        <Space size={4}>
          <span className="soc-user-name">{user.name}</span>
          <Typography.Text type="secondary" className="soc-hide-sm">
            {t(`roles.${user.role}`)}
          </Typography.Text>
        </Space>
      </Button>
    </Dropdown>
  );
}

export function AppLayout(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc, shifted } = useClock();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  useClockTicker();

  // Непрочитанные считает сервер своей выборкой: колокольчик показывает
  // ровно то, что лежит в центре уведомлений.
  const unread = useNotifications(true).data?.meta.total ?? 0;
  const demoMode = useDemoMode();

  return (
    <Layout className="soc" style={{ minHeight: '100vh' }}>
      {/* Обвязка несёт знак заказчика и потому тёмная. Полоса 52 px:
          выше она отнимала бы строки у суточного плана, ради которых
          вся плотность и выбиралась. */}
      <Layout.Header
        className="soc-chrome"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: SOC_DENSITY.chromeHeight,
          lineHeight: `${String(SOC_DENSITY.chromeHeight)}px`,
          background: SOC_COLORS.brandInk,
          paddingInline: 16,
          position: 'sticky',
          top: 0,
          zIndex: 20,
        }}
      >
        {/* Кнопка меню появляется на узких экранах (адаптив от 360 px) */}
        <Button
          className="soc-burger"
          icon={<MenuOutlined />}
          size="small"
          onClick={() => {
            setDrawerOpen(true);
          }}
          aria-label={t('nav.menu')}
        />

        {/* Белая версия знака — на brand-ink, цветная остаётся для белого
            фона и бланка документа. Красный из знака в интерфейсе не
            используется: там он означает критический статус. */}
        <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
          <img
            src="/brand/streamline-fs-white.png"
            alt={t('app.fullName')}
            style={{ height: 26, width: 'auto', display: 'block' }}
          />
        </Link>

        <span
          aria-hidden="true"
          style={{ width: 1, height: 22, background: SOC_COLORS.brandInkLine }}
          className="soc-hide-sm"
        />

        <Typography.Text
          className="soc-hide-sm"
          style={{ color: SOC_COLORS.onBrandInk, fontSize: 13, fontWeight: 500 }}
        >
          {t('app.chromeTitle')}
        </Typography.Text>

        {demoMode && (
          <Tooltip title={t('app.demoTooltip')}>
            <Tag color="orange" style={{ margin: 0 }} className="soc-hide-sm">
              {t('app.demoBadge')}
            </Tag>
          </Tooltip>
        )}

        <div style={{ flex: 1 }} />

        {demoMode && (
          <span className="soc-hide-sm">
            <DemoClockPanel />
          </span>
        )}

        <Tooltip title={t('clock.utcHint')}>
          <Space size={4} className="soc-hide-sm">
            <Typography.Text
              style={{ fontFamily: "'JetBrains Mono', monospace", color: SOC_COLORS.onBrandInk }}
            >
              {formatUtc(nowUtc)}
            </Typography.Text>
            {shifted && (
              <Tag color="purple" style={{ margin: 0 }}>
                {t('clock.shifted')}
              </Tag>
            )}
          </Space>
        </Tooltip>

        <Badge count={unread} size="small">
          <Button
            icon={<BellOutlined />}
            size="small"
            onClick={() => {
              setNotificationsOpen(true);
            }}
            aria-label={t('nav.notifications')}
          />
        </Badge>

        <span className="soc-hide-sm">
          <LocaleSwitch />
        </span>
        <UserMenu />
      </Layout.Header>

      <Layout>
        {/* Навигация переехала на светлый рельс: контраст отдан данным,
            а не обвязке. */}
        <Layout.Sider
          width={SOC_DENSITY.railWidth}
          theme="light"
          className="soc-sider"
          style={{
            background: SOC_COLORS.surface,
            borderInlineEnd: `1px solid ${SOC_COLORS.border}`,
          }}
        >
          <NavRail />
        </Layout.Sider>

        <Layout.Content style={{ padding: SOC_DENSITY.contentPadding, minWidth: 0 }}>
          <SectionTabs />
          <Outlet />
        </Layout.Content>
      </Layout>

      <Drawer
        placement="left"
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        width={260}
        styles={{ body: { padding: 0 } }}
        title={t('app.name')}
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
    </Layout>
  );
}
