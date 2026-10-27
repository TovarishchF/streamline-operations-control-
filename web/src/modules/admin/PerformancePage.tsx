import { useMemo, useState, type JSX } from 'react';
import { Card, Segmented, Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { usePerformance, type PerformanceReportRow } from '@/api/admin';
import { useClock } from '@/shared/clock/useClock';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

type Metric = PerformanceReportRow['metrics'][number];

const PERIOD_HOURS = { day: 24, week: 168, month: 720 } as const;
type Period = keyof typeof PERIOD_HOURS;

function Milliseconds({ value }: { value: number | null }): JSX.Element {
  const { t } = useTranslation();
  return value === null ? (
    <Typography.Text type="secondary">—</Typography.Text>
  ) : (
    <Mono>{t('performance.ms', { value })}</Mono>
  );
}

/**
 * Измеренные показатели производительности `[ТЗ 4.4]`.
 *
 * **Фактические перцентили за период, а не синтетика** (`SPEC.md § 3`):
 * серверные — по времени ответов API, клиентские — по замерам браузеров
 * пользователей (`POST /performance/samples`).
 *
 * ADR-017: норматив считается выполненным при одновременном выполнении двух
 * условий — серверного `p95` и клиентского времени до отрисовки экрана.
 * Метрика без замеров за период — «нет данных», а не «выполнено».
 */
export function PerformancePage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { nowUtc } = useClock();
  const [period, setPeriod] = useState<Period>('day');

  // Конец периода — по часу, а не по секунде: иначе отчёт перезапрашивался
  // бы с каждым тиком часов.
  const hour = Math.floor(nowUtc.getTime() / 3_600_000);
  const range = useMemo(() => {
    const to = new Date((hour + 1) * 3_600_000);
    const from = new Date(to.getTime() - PERIOD_HOURS[period] * 3_600_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [hour, period]);
  const report = usePerformance(range);
  const locale = i18n.language.startsWith('en') ? 'en-GB' : 'ru-RU';

  const verdict = (value: boolean | null): JSX.Element => {
    if (value === null) return <Tag style={{ margin: 0 }}>{t('performance.noData')}</Tag>;
    const token = value ? STATUS_TOKENS.done : STATUS_TOKENS.critical;
    return (
      <Tag style={{ margin: 0, color: token.color, background: token.background, borderColor: token.border }}>
        {value ? t('performance.within') : t('performance.exceeded')}
      </Tag>
    );
  };

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
    { title: 'p50', dataIndex: 'p50Ms', width: 100, align: 'right', render: (value: number | null) => <Milliseconds value={value} /> },
    {
      title: 'p95', dataIndex: 'p95Ms', width: 110, align: 'right',
      render: (value: number | null, row) => (
        <span
          style={{
            color:
              row.withinThreshold === null
                ? undefined
                : row.withinThreshold
                  ? STATUS_TOKENS.done.color
                  : STATUS_TOKENS.critical.color,
            fontWeight: 600,
          }}
        >
          <Milliseconds value={value} />
        </span>
      ),
    },
    { title: 'p99', dataIndex: 'p99Ms', width: 100, align: 'right', render: (value: number | null) => <Milliseconds value={value} /> },
    { title: t('performance.threshold'), dataIndex: 'thresholdMs', width: 130, align: 'right', render: (value: number) => <Milliseconds value={value} /> },
    {
      title: t('performance.samples'), dataIndex: 'sampleCount', width: 110, align: 'right',
      render: (value: number) => <Mono>{value.toLocaleString(locale)}</Mono>,
    },
    {
      title: t('performance.verdict'), dataIndex: 'withinThreshold', width: 140,
      render: (value: boolean | null) => verdict(value),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.performance')}</Typography.Title>

      <Card size="small">
        <Space size={16} wrap>
          <Segmented
            value={period}
            onChange={(value) => {
              setPeriod(value as Period);
            }}
            options={[
              { label: t('performance.periodDay'), value: 'day' },
              { label: t('performance.periodWeek'), value: 'week' },
              { label: t('performance.periodMonth'), value: 'month' },
            ]}
          />
          <Typography.Text type="secondary">{t('performance.period')}:</Typography.Text>
          <UtcTime value={range.from} withDate />
          <span>—</span>
          <UtcTime value={range.to} withDate />
        </Space>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={report}>
          {(data) => (
            <DataTable<Metric>
              size="small"
              rowKey={(row) => `${row.name}_${row.source}`}
              columns={columns}
              dataSource={data.metrics}
              pagination={false}
              scroll={{ x: 1150 }}
              locale={{ emptyText: <EmptyState description={t('performance.noData')} /> }}
            />
          )}
        </QueryState>
      </Card>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('performance.methodHint')}
      </Typography.Text>
    </Space>
  );
}
