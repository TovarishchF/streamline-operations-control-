import { useMemo, useState, type JSX } from 'react';
import { Badge, Button, Drawer, Dropdown, Layout, Menu, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { BellOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, type Locale } from '@/shared/i18n';
import { useClock, useClockTicker, formatUtc } from '@/shared/clock/useClock';
import { DEMO_USERS, useSession, type DemoUser } from '@/shared/auth/session';
import { hasPermission } from '@/shared/auth/permissions';
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
 * Существует только на макетах (веха M2) и на демонстрационном стенде: на M3
 * его заменит настоящий вход (ADR-013). Нужен, чтобы заказчик мог увидеть,
 * что каждая роль видит свой набор экранов.
 */
function RoleSwitch(): JSX.Element {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const navigate = useNavigate();

  const items = DEMO_USERS.map((demo: DemoUser) => ({
    key: demo.id,
    label: (
      <Space size={6}>
        <span>{demo.name}</span>
        <Typography.Text type="secondary">{t(`roles.${demo.role}`)}</Typography.Text>
      </Space>
    ),
    onClick: () => {
      setUser(demo);
      navigate('/');
    },
  }));

  return (
    <Dropdown menu={{ items, selectedKeys: [user.id] }} trigger={['click']}>
      <Button size="small" icon={<UserOutlined />}>
        <Space size={4}>
          {user.name}
          <Typography.Text type="secondary">{t(`roles.${user.role}`)}</Typography.Text>
        </Space>
      </Button>
    </Dropdown>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const role = useSession((s) => s.user.role);

  const items = useMemo(
    () =>
      NAV_GROUPS.map((group) => {
        const visible = group.items.filter((item) => hasPermission(role, item.permission));
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
    [role, t],
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
        <RoleSwitch />
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
