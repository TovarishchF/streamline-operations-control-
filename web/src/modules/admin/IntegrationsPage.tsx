import { useState, type JSX } from 'react';
import { Alert, Button, Card, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { IntegrationLogEntry, IntegrationStatus } from '@/api/types';
import { INTEGRATIONS, INTEGRATION_LOG } from '@/mocks/admin';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Состояние внешних подключений `[ТЗ 4.2]`.
 *
 * **Показывает фактический режим каждого подключения** (`CLAUDE.md § 4`):
 * заглушка не изображает живое подключение. Колонка «что нужно для live» —
 * из `INTEGRATIONS.md § 6` и письма заказчику: администратор должен видеть,
 * чего именно не хватает, а не просто «не настроено».
 *
 * ADR-008: режим подключения на маркировку документов не влияет.
 */
export function IntegrationsPage(): JSX.Element {
  const { t } = useTranslation();
  const [testing, setTesting] = useState<string | null>(null);

  const stubCount = INTEGRATIONS.filter((i) => i.mode === 'stub').length;
  const unhealthy = INTEGRATIONS.filter((i) => !i.healthy);

  const columns: DataColumns<IntegrationStatus> = [
    {
      title: t('integrations.code'), dataIndex: 'code', width: 120, fixed: 'left',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('integrations.purpose'), key: 'name', width: 230,
      render: (_, row) => row.name?.ru ?? row.code,
    },
    {
      title: t('integrations.mode'), dataIndex: 'mode', width: 110,
      render: (value: string) => (
        <Tooltip title={value === 'stub' ? t('integrations.stubHint') : t('integrations.liveHint')}>
          <Tag color={value === 'live' ? 'green' : 'purple'} style={{ margin: 0 }}>
            {value}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: t('integrations.health'), dataIndex: 'healthy', width: 120,
      render: (value: boolean) => (
        <Tag
          style={{
            margin: 0,
            color: value ? STATUS_TOKENS.done.color : STATUS_TOKENS.critical.color,
            background: value ? STATUS_TOKENS.done.background : STATUS_TOKENS.critical.background,
            borderColor: value ? STATUS_TOKENS.done.border : STATUS_TOKENS.critical.border,
          }}
        >
          {value ? t('integrations.healthy') : t('integrations.unhealthy')}
        </Tag>
      ),
    },
    {
      title: t('integrations.lastCheck'), dataIndex: 'lastCheckAt', width: 110,
      render: (value: string | null) => <UtcTime value={value} />,
    },
    {
      title: t('integrations.errorRate'), dataIndex: 'errorRate24h', width: 110, align: 'right',
      render: (value: string) => {
        const percent = Number.parseFloat(value) * 100;
        return (
          <Mono>
            <span style={{ color: percent > 5 ? STATUS_TOKENS.critical.color : undefined }}>
              {percent.toFixed(1)} %
            </span>
          </Mono>
        );
      },
    },
    {
      title: t('integrations.requiredForLive'), dataIndex: 'requiredForLive', ellipsis: false,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }}>{value}</Typography.Text>
      ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 130, fixed: 'right',
      render: (_, row) => (
        <Button
          size="small"
          loading={testing === row.code}
          onClick={() => {
            setTesting(row.code);
            window.setTimeout(() => {
              setTesting(null);
            }, 800);
          }}
        >
          {t('integrations.test')}
        </Button>
      ),
    },
  ];

  const logColumns: DataColumns<IntegrationLogEntry> = [
    { title: t('integrations.ts'), dataIndex: 'ts', width: 110,
      render: (value: string) => <UtcTime value={value} withDate /> },
    { title: t('integrations.code'), dataIndex: 'code', width: 100,
      render: (value: string) => <Mono>{value}</Mono> },
    { title: t('integrations.mode'), dataIndex: 'mode', width: 90,
      render: (value: string) => <Tag color="purple" style={{ margin: 0 }}>{value}</Tag> },
    { title: t('integrations.direction'), dataIndex: 'direction', width: 110,
      render: (value: string) => t(`integrations.${value}`) },
    { title: t('integrations.endpoint'), dataIndex: 'endpoint', ellipsis: true,
      render: (value: string) => <Mono>{value}</Mono> },
    { title: t('integrations.duration'), dataIndex: 'durationMs', width: 100, align: 'right',
      render: (value: number) => <Mono>{value} ms</Mono> },
    { title: t('integrations.httpStatus'), dataIndex: 'status', width: 90, align: 'right',
      render: (value: number) => (
        <Mono>
          <span style={{ color: value >= 400 ? STATUS_TOKENS.critical.color : undefined }}>{value}</span>
        </Mono>
      ) },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('nav.integrations')}
      </Typography.Title>

      <Alert
        type="info"
        showIcon
        message={t('integrations.honestyNotice', { count: stubCount, total: INTEGRATIONS.length })}
        description={t('integrations.honestyHint')}
      />

      {unhealthy.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('integrations.unhealthyCount', { count: unhealthy.length })}
          description={unhealthy.map((i) => `${i.code}: ${i.requiredForLive ?? ''}`).join(' · ')}
        />
      ) : null}

      <Tabs
        items={[
          {
            key: 'status',
            label: t('integrations.tabStatus'),
            children: (
              <Card size="small" styles={{ body: { padding: 0 } }}>
                <DataTable<IntegrationStatus>
                  size="small"
                  rowKey="code"
                  columns={columns}
                  dataSource={INTEGRATIONS}
                  pagination={false}
                  scroll={{ x: 1250 }}
                />
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
                  <DataTable<IntegrationLogEntry>
                    size="small"
                    rowKey="id"
                    columns={logColumns}
                    dataSource={INTEGRATION_LOG}
                    pagination={{ pageSize: 15, size: 'small' }}
                    scroll={{ x: 900 }}
                    locale={{ emptyText: <EmptyState /> }}
                  />
                </Card>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
