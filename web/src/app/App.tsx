import type { JSX } from 'react';
import { ConfigProvider, Layout, Typography, Tag, Space, Select, Alert, Tooltip } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import enUS from 'antd/locale/en_US';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { socTheme } from './theme';
import { SUPPORTED_LOCALES, type Locale } from '@/shared/i18n';
import { useClock, useClockTicker, formatUtc } from '@/shared/clock/useClock';
import { useClockSync, useHealth } from '@/api/system';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** Признак демонстрационного стенда приходит с сервера (ADR-008). */
const DEMO_MODE = import.meta.env['VITE_DEMO_DATA'] === 'true';

function Header(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { nowUtc, shifted } = useClock();

  return (
    <Layout.Header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: '#fff',
        borderBottom: `1px solid ${STATUS_TOKENS.neutral.border}`,
        paddingInline: 16,
      }}
    >
      <Typography.Text strong style={{ fontSize: 16 }}>
        {t('app.name')}
      </Typography.Text>

      {DEMO_MODE && (
        <Tooltip title={t('app.demoTooltip')}>
          <Tag color="orange" style={{ margin: 0 }}>
            {t('app.demoBadge')}
          </Tag>
        </Tooltip>
      )}

      <div style={{ flex: 1 }} />

      {/* Время всегда с подписью зоны (CLAUDE.md § 10) */}
      <Space size={4}>
        <Typography.Text style={{ fontFamily: socTheme.token?.fontFamilyCode }}>
          {formatUtc(nowUtc)}
        </Typography.Text>
        {shifted && (
          <Tooltip title={t('clock.shiftedHint')}>
            <Tag color="purple" style={{ margin: 0 }}>
              {t('clock.shifted')}
            </Tag>
          </Tooltip>
        )}
      </Space>

      <Select<Locale>
        size="small"
        value={i18n.language.startsWith('en') ? 'en' : 'ru'}
        onChange={(value) => {
          void i18n.changeLanguage(value);
        }}
        options={SUPPORTED_LOCALES.map((code) => ({ value: code, label: code.toUpperCase() }))}
        style={{ width: 72 }}
        aria-label={t('common.language')}
      />
    </Layout.Header>
  );
}

function HealthPanel(): JSX.Element {
  const { t } = useTranslation();
  const { data, isPending, isError } = useHealth();

  if (isPending) return <Alert type="info" message={t('common.loading')} />;
  if (isError) return <Alert type="error" message={t('common.error')} />;

  const type = data.status === 'ok' ? 'success' : data.status === 'degraded' ? 'warning' : 'error';

  return (
    <Alert
      type={type}
      showIcon
      message={`${t('health.title')}: ${t(`health.${data.status}`)}`}
      description={
        <Space direction="vertical" size={2}>
          {Object.entries(data.checks).map(([name, check]) => (
            <Typography.Text key={name}>
              {t(`health.${name}`, name)}: {t(`health.${check.status}`)} · {check.latencyMs} ms
            </Typography.Text>
          ))}
          <Typography.Text type="secondary">
            {data.version} · {data.commit}
          </Typography.Text>
        </Space>
      }
    />
  );
}

function Shell(): JSX.Element {
  const { i18n } = useTranslation();
  useClockTicker();
  useClockSync();

  return (
    <ConfigProvider theme={socTheme} locale={i18n.language.startsWith('en') ? enUS : ruRU}>
      <Layout style={{ minHeight: '100vh' }}>
        <Header />
        <Layout.Content style={{ padding: 16, maxWidth: 1600, width: '100%', margin: '0 auto' }}>
          <HealthPanel />
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
