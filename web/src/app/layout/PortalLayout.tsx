import type { JSX } from 'react';
import {
  Button, ConfigProvider, Dropdown, Layout, Menu, Tag, Tooltip, Typography, Select,
} from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { portalTheme, SOC_COLORS } from '@/app/theme';
import { useCurrentUser, useDemoMode, useSession } from '@/shared/auth/session';
import { SUPPORTED_LOCALES, type Locale } from '@/shared/i18n';
import { useClock, useClockTicker, formatUtc } from '@/shared/clock/useClock';

/**
 * Лейаут порталов `[ТЗ 3.5.3, 4.3]`.
 *
 * Отдельный лейаут с урезанной навигацией — клиент и поставщик не видят
 * внутренних разделов. Изоляция данных при этом обеспечивается **на сервере**
 * фильтрацией выборки, а не этим лейаутом (ADR-003).
 */
export function PortalLayout(): JSX.Element {
  const { t, i18n } = useTranslation();
  const user = useCurrentUser();
  const signOut = useSession((s) => s.signOut);
  const navigate = useNavigate();
  const location = useLocation();
  const { nowUtc } = useClock();
  const demoMode = useDemoMode();
  useClockTicker();

  const items =
    user?.role === 'client'
      ? [
          { key: '/portal/client/flights', label: <Link to="/portal/client/flights">{t('portal.client.flights')}</Link> },
          { key: '/portal/client/request', label: <Link to="/portal/client/request">{t('portal.client.newRequest')}</Link> },
          { key: '/portal/client/documents', label: <Link to="/portal/client/documents">{t('portal.client.documents')}</Link> },
        ]
      : [
          { key: '/portal/vendor/orders', label: <Link to="/portal/vendor/orders">{t('portal.vendor.orders')}</Link> },
          { key: '/portal/vendor/payables', label: <Link to="/portal/vendor/payables">{t('portal.vendor.payables')}</Link> },
          { key: '/portal/vendor/performance', label: <Link to="/portal/vendor/performance">{t('portal.vendor.performance')}</Link> },
        ];

  const userItems = [
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
    <ConfigProvider theme={portalTheme}>
      <Layout className="soc" style={{ minHeight: '100vh' }}>
      {/* Кабинет заказчика видит знак поставщика услуги, а не служебное
          сокращение: это его подрядчик, а не внутренняя система. */}
      <Layout.Header
        className="soc-chrome"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          height: 64,
          lineHeight: '64px',
          background: SOC_COLORS.brandInk,
          paddingInline: 24,
        }}
      >
        <img
          src="/brand/streamline-fs-white.png"
          alt={t('app.fullName')}
          style={{ height: 26, width: 'auto', display: 'block' }}
        />

        <span
          aria-hidden="true"
          style={{ width: 1, height: 24, background: SOC_COLORS.brandInkLine }}
        />

        <Typography.Text style={{ color: SOC_COLORS.onBrandInk, fontSize: 14, fontWeight: 500 }}>
          {user?.role === 'client' ? t('portal.client.title') : t('portal.vendor.title')}
        </Typography.Text>

        {demoMode && (
          <Tooltip title={t('app.demoTooltip')}>
            <Tag color="orange" style={{ margin: 0 }} className="soc-hide-sm">
              {t('app.demoBadge')}
            </Tag>
          </Tooltip>
        )}

        <div style={{ flex: 1 }} />

        <Typography.Text
          className="soc-hide-sm"
          style={{ fontFamily: "'JetBrains Mono', monospace", color: SOC_COLORS.onBrandInkMuted }}
        >
          {formatUtc(nowUtc)}
        </Typography.Text>

        <Select<Locale>
          size="small"
          value={i18n.language.startsWith('en') ? 'en' : 'ru'}
          onChange={(value) => {
            void i18n.changeLanguage(value);
          }}
          options={SUPPORTED_LOCALES.map((code) => ({ value: code, label: code.toUpperCase() }))}
          style={{ width: 68 }}
          className="soc-hide-sm"
          aria-label={t('common.language')}
        />

        <Dropdown menu={{ items: userItems }} trigger={['click']}>
          <Button size="small" icon={<UserOutlined />} className="soc-user-button">
            <span className="soc-user-name">{user?.name ?? ''}</span>
          </Button>
        </Dropdown>
      </Layout.Header>

      {/* Навигация — на светлом рельсе под обвязкой: контраст отдан
          содержимому, а не полосе с названием. */}
      <nav
        style={{
          background: SOC_COLORS.surface,
          borderBottom: `1px solid ${SOC_COLORS.border}`,
          paddingInline: 24,
        }}
      >
        <Menu
          mode="horizontal"
          items={items}
          selectedKeys={[location.pathname]}
          style={{ borderBottom: 'none', minWidth: 0 }}
        />
      </nav>

      <Layout.Content style={{ padding: 24, maxWidth: 1148, width: '100%', margin: '0 auto' }}>
        <Outlet />
      </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}
