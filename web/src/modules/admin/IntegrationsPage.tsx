import { useState, type JSX } from 'react';
import { App, Button, Card, Space, Tabs, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import {
  useCheckIntegration,
  useIntegrationLogs,
  useIntegrations,
  type IntegrationLogRow,
  type IntegrationStatusRow,
} from '@/api/admin';
import { ApiError } from '@/api/client';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Notice } from '@/shared/ui/Notice';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Внешние подключения `[ТЗ 4.2]` (ADR-039).
 *
 * Только работающие подключения: заглушек нет, а выключенное подключение
 * система не вызывает — показывать его здесь незачем. Как подключить
 * остальные — `docs/CONNECTING.md`.
 *
 * Состояние — по последнему настоящему обмену из журнала, а не по настройке:
 * включённое, но недоступное подключение должно выглядеть недоступным.
 */
export function IntegrationsPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const query = useIntegrations();
  const check = useCheckIntegration();
  const [logPage, setLogPage] = useState(1);
  const logs = useIntegrationLogs(logPage);
  const language = i18n.language.startsWith('en') ? 'en' : 'ru';

  const runCheck = async (code: string): Promise<void> => {
    try {
      const result = await check.mutateAsync(code);
      if (result.success) {
        void message.success(t('integrations.checkOk', { code }));
      } else {
        void message.error(t('integrations.checkFailed', { code, message: result.message }));
      }
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  const unhealthy = (query.data?.data ?? []).filter((item) => item.healthy === false);

  const columns: DataColumns<IntegrationStatusRow> = [
    {
      title: t('integrations.code'), dataIndex: 'code', width: 120,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('integrations.purpose'), key: 'name',
      sortBy: (row) => row.name[language],
      render: (_, row) => row.name[language],
    },
    {
      title: t('integrations.health'), dataIndex: 'healthy', width: 160, filterable: false,
      render: (value: boolean | null) => <HealthTag healthy={value} />,
    },
    {
      title: t('integrations.lastCheck'), dataIndex: 'lastCheckAt', width: 150,
      render: (value: string | null) => <UtcTime value={value} withDate />,
    },
    {
      title: t('integrations.lastSuccess'), dataIndex: 'lastSuccessAt', width: 170,
      render: (value: string | null) => <UtcTime value={value} withDate />,
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 130,
      render: (_, row) => (
        <Button
          size="small"
          loading={check.isPending && check.variables === row.code}
          onClick={() => {
            void runCheck(row.code);
          }}
        >
          {t('integrations.test')}
        </Button>
      ),
    },
  ];

  const logColumns: DataColumns<IntegrationLogRow> = [
    { title: t('integrations.ts'), dataIndex: 'ts', width: 130,
      render: (value: string) => <UtcTime value={value} withDate /> },
    { title: t('integrations.code'), dataIndex: 'code', width: 100,
      render: (value: string) => <Mono>{value}</Mono> },
    { title: t('integrations.direction'), dataIndex: 'direction', width: 120,
      render: (value: string) => t(`integrations.${value}`) },
    { title: t('integrations.operation'), dataIndex: 'operation', width: 140,
      render: (value: string) => <Mono>{value}</Mono> },
    { title: t('integrations.endpoint'), dataIndex: 'endpoint', ellipsis: true,
      render: (value: string) => <Mono>{value}</Mono> },
    { title: t('integrations.duration'), dataIndex: 'durationMs', width: 110, align: 'right',
      render: (value: number) => <Mono>{value} ms</Mono> },
    { title: t('integrations.result'), key: 'result', width: 220, ellipsis: true,
      sortBy: (row) => row.success,
      render: (_, row) =>
        row.success ? (
          <Mono>{row.httpStatus ?? 'OK'}</Mono>
        ) : (
          <Typography.Text style={{ color: STATUS_TOKENS.critical.color }}>
            {row.error ?? t('integrations.unhealthy')}
          </Typography.Text>
        ) },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('nav.integrations')}
        </Typography.Title>
        <Typography.Text type="secondary">{t('integrations.subtitle')}</Typography.Text>
      </div>

      {unhealthy.length > 0 ? (
        <Notice
          id={`integrations.unhealthy:${unhealthy.map((item) => item.code).join(',')}`}
          type="warning"
          showIcon
          message={t('integrations.unhealthyCount', { count: unhealthy.length })}
          description={unhealthy.map((item) => item.name[language]).join(' · ')}
        />
      ) : null}

      <Tabs
        items={[
          {
            key: 'status',
            label: t('integrations.tabStatus'),
            children: (
              <Card size="small" styles={{ body: { padding: 0 } }}>
                <QueryState query={query}>
                  {(page) => (
                    <DataTable<IntegrationStatusRow>
                      size="small"
                      rowKey="code"
                      columns={columns}
                      dataSource={page.data}
                      pagination={false}
                      scroll={{ x: 900 }}
                      locale={{ emptyText: <EmptyState description={t('integrations.empty')} /> }}
                    />
                  )}
                </QueryState>
              </Card>
            ),
          },
          {
            key: 'log',
            label: t('integrations.tabLog'),
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('integrations.logHint')}
                </Typography.Text>
                <Card size="small" styles={{ body: { padding: 0 } }}>
                  <QueryState query={logs}>
                    {(page) => (
                      <DataTable<IntegrationLogRow>
                        size="small"
                        rowKey="id"
                        columns={logColumns}
                        dataSource={page.data}
                        pagination={{
                          current: logPage,
                          pageSize: page.meta.perPage,
                          total: page.meta.total,
                          size: 'small',
                          onChange: setLogPage,
                        }}
                        scroll={{ x: 1000 }}
                        locale={{ emptyText: <EmptyState /> }}
                      />
                    )}
                  </QueryState>
                </Card>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

function HealthTag({ healthy }: { healthy: boolean | null }): JSX.Element {
  const { t } = useTranslation();
  if (healthy === null) {
    return <Tag style={{ margin: 0 }}>{t('integrations.unknown')}</Tag>;
  }
  const token = healthy ? STATUS_TOKENS.done : STATUS_TOKENS.critical;
  return (
    <Tag
      style={{
        margin: 0,
        color: token.color,
        background: token.background,
        borderColor: token.border,
      }}
    >
      {healthy ? t('integrations.healthy') : t('integrations.unhealthy')}
    </Tag>
  );
}
