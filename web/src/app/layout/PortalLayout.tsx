import type { JSX } from 'react';
import { Button, Dropdown, Layout, Menu, Space, Tag, Tooltip, Typography, Select } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { DEMO_USERS, useSession } from '@/shared/auth/session';
import { SUPPORTED_LOCALES, type Locale } from '@/shared/i18n';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
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
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const navigate = useNavigate();
  const location = useLocation();
  const { nowUtc } = useClock();
  useClockTicker();

  const items =
    user.role === 'client'
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

  const roleItems = DEMO_USERS.map((demo) => ({
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
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#fff',
          borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}`,
          paddingInline: 16,
        }}
      >
        <Typography.Text strong style={{ fontSize: 16 }}>
          {t('app.name')}
        </Typography.Text>
        <Tag color="blue" style={{ margin: 0 }}>
          {user.role === 'client' ? t('portal.client.title') : t('portal.vendor.title')}
        </Tag>
        <Tooltip title={t('app.demoTooltip')}>
          <Tag color="orange" style={{ margin: 0 }} className="soc-hide-sm">
            {t('app.demoBadge')}
          </Tag>
        </Tooltip>

        <Menu
          mode="horizontal"
          items={items}
          selectedKeys={[location.pathname]}
          style={{ flex: 1, borderBottom: 'none', minWidth: 0 }}
        />

        <Typography.Text
          className="soc-hide-sm"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
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

        <Dropdown menu={{ items: roleItems, selectedKeys: [user.id] }} trigger={['click']}>
          <Button size="small" icon={<UserOutlined />}>
            {user.name}
          </Button>
        </Dropdown>
      </Layout.Header>

      <Layout.Content style={{ padding: 16, maxWidth: 1280, width: '100%', margin: '0 auto' }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
