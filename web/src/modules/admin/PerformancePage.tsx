import type { JSX } from 'react';
import { Alert, Card, Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { PERFORMANCE } from '@/mocks/admin';
import { Mono, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

interface Metric {
  name: string;
  source: 'server' | 'client';
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  sampleCount: number;
  thresholdMs: number;
  withinThreshold: boolean;
}

/**
 * Измеренные показатели производительности `[ТЗ 4.4]`.
 *
 * **Фактические перцентили за период, а не синтетика** (`SPEC.md § 3`).
 *
 * ADR-017: норматив считается выполненным при одновременном выполнении двух
 * условий — серверного `p95 http_req_duration` и клиентского времени до
 * `largest-contentful-paint`. Заказчик под «открытием карточки за 2 секунды»
 * понимает время до отрисовки экрана, а не длительность одного вызова API;
 * метод согласуется до испытаний, а не после неудобного результата.
 */
export function PerformancePage(): JSX.Element {
  const { t } = useTranslation();

  const columns: DataColumns<Metric> = [
    {
      title: t('performance.metric'), dataIndex: 'name', width: 220,
      render: (value: string) => (
        <Space direction="vertical" size={0}>
          <Mono>{value}</Mono>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t(`performance.metricName.${value}`, value)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('performance.source'), dataIndex: 'source', width: 150,
      render: (value: string) => (
        <Tag color={value === 'server' ? 'blue' : 'purple'} style={{ margin: 0 }}>
          {t(`performance.${value}`)}
        </Tag>
      ),
    },
    {
      title: 'p50', dataIndex: 'p50Ms', width: 100, align: 'right',
      render: (value: number) => <Mono>{value} ms</Mono>,
    },
    {
      title: 'p95', dataIndex: 'p95Ms', width: 110, align: 'right',
      render: (value: number, row) => (
        <Mono>
          <span
            style={{
              color: row.withinThreshold ? STATUS_TOKENS.done.color : STATUS_TOKENS.critical.color,
              fontWeight: 600,
            }}
          >
            {value} ms
          </span>
        </Mono>
      ),
    },
    {
      title: 'p99', dataIndex: 'p99Ms', width: 100, align: 'right',
      render: (value: number) => <Mono>{value} ms</Mono>,
    },
    {
      title: t('performance.threshold'), dataIndex: 'thresholdMs', width: 130, align: 'right',
      render: (value: number) => <Mono>{value} ms</Mono>,
    },
    {
      title: t('performance.samples'), dataIndex: 'sampleCount', width: 110, align: 'right',
      render: (value: number) => <Mono>{value.toLocaleString('ru-RU')}</Mono>,
    },
    {
      title: t('performance.verdict'), dataIndex: 'withinThreshold', width: 140,
      render: (value: boolean) => (
        <Tag
          style={{
            margin: 0,
            color: value ? STATUS_TOKENS.done.color : STATUS_TOKENS.critical.color,
            background: value ? STATUS_TOKENS.done.background : STATUS_TOKENS.critical.background,
            borderColor: value ? STATUS_TOKENS.done.border : STATUS_TOKENS.critical.border,
          }}
        >
          {value ? t('performance.within') : t('performance.exceeded')}
        </Tag>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.performance')}</Typography.Title>

      <Alert
        type="info"
        showIcon
        message={t('performance.methodNotice')}
        description={t('performance.methodHint')}
      />

      <Card size="small">
        <Space size={16} wrap>
          <Typography.Text type="secondary">{t('performance.period')}:</Typography.Text>
          <UtcTime value={PERFORMANCE.from} withDate />
          <span>—</span>
          <UtcTime value={PERFORMANCE.to} withDate />
        </Space>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<Metric>
          size="small"
          rowKey={(row) => `${row.name}_${row.source}`}
          columns={columns}
          dataSource={PERFORMANCE.metrics as Metric[]}
          pagination={false}
          scroll={{ x: 1150 }}
        />
      </Card>

      <Alert type="warning" showIcon message={t('performance.loadTestNotice')} />
    </Space>
  );
}
