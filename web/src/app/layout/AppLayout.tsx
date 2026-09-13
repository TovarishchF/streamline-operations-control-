import { useMemo, useState, type JSX } from 'react';
import { Badge, Button, Drawer, Dropdown, Layout, Menu, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { BellOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, type Locale } from '@/shared/i18n';
import { useClock, useClockTicker, formatUtc } from '@/shared/clock/useClock';
import { useCurrentUser, usePermissionMap, useSession } from '@/shared/auth/session';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { NOTIFICATIONS } from '@/mocks/comms';
import { NAV_GROUPS } from './navigation';
import { NotificationCentre } from './NotificationCentre';
import { DemoClockPanel } from './DemoClockPanel';

// На M2 макеты всегда работают на сгенерированных данных. На M11 признак
// придёт с сервера в /auth/me как demoMode (ADR-008).
const IS_DEMO: boolean = true;

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

  const items = [
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

function Sidebar({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const permissions = usePermissionMap();

  const items = useMemo(
    () =>
      NAV_GROUPS.map((group) => {
        const visible = group.items.filter((item) => permissions[item.permission] === true);
        if (visible.length === 0) return null;
        return {
          key: group.key,
          label: t(group.labelKey),
          type: 'group' as const,
          children: visible.map((item) => ({
            key: item.path,
            label: <Link to={item.path}>{t(item.labelKey)}</Link>,
          })),
        };
      }).filter((group): group is NonNullable<typeof group> => group !== null),
    [permissions, t],
  );

  // Подсветка пункта: самый длинный совпадающий префикс, иначе на карточке
  // рейса подсвечивался бы и «Суточный план», и ничего.
  const selected = useMemo(() => {
    const paths = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.path));
    const match = paths
      .filter((p) => location.pathname === p || location.pathname.startsWith(`${p}/`))
      .sort((a, b) => b.length - a.length)[0];
    return match ? [match] : [];
  }, [location.pathname]);

  return (
    <Menu
      mode="inline"
      items={items}
      selectedKeys={selected}
      onClick={onNavigate}
      style={{ borderInlineEnd: 'none', height: '100%' }}
    />
  );
}

export function AppLayout(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc, shifted } = useClock();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  useClockTicker();

  const unread = NOTIFICATIONS.filter((n) => !n.readAt).length;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#fff',
          borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}`,
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

        <Link to="/" style={{ color: 'inherit' }}>
          <Typography.Text strong style={{ fontSize: 16 }}>
            {t('app.name')}
          </Typography.Text>
        </Link>

        {IS_DEMO && (
          <Tooltip title={t('app.demoTooltip')}>
            <Tag color="orange" style={{ margin: 0 }} className="soc-hide-sm">
              {t('app.demoBadge')}
            </Tag>
          </Tooltip>
        )}

        <div style={{ flex: 1 }} />

        <span className="soc-hide-sm">
          <DemoClockPanel />
        </span>

        <Tooltip title={t('clock.utcHint')}>
          <Space size={4} className="soc-hide-sm">
            <Typography.Text style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
        <Layout.Sider
          width={228}
          theme="light"
          className="soc-sider"
          style={{ borderInlineEnd: `1px solid ${STATUS_TOKENS.neutral.border}` }}
        >
          <Sidebar />
        </Layout.Sider>

        <Layout.Content style={{ padding: 16, minWidth: 0 }}>
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
        <Sidebar
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
