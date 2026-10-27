import { useMemo, type JSX, type ReactNode } from 'react';
import { Alert, Progress, Space, Tabs, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { DataTable } from '@/shared/ui/DataTable';
import { useDashboard, type DashboardData } from '@/api/reports';
import { EChart, type ChartOption } from '@/shared/ui/EChart';
import { KpiTile } from '@/shared/ui/KpiTile';
import { PageHeader } from '@/shared/ui/PageHeader';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState, MoneyText, Mono, PercentText, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { DashboardGrid } from './DashboardGrid';
import { widgetResult, type WidgetCode, type WidgetData } from './widgets';

type ClientItem = WidgetData<'top_clients'>['byRevenue'][number];
type VendorItem = WidgetData<'top_vendors'>['items'][number];
type CategoryItem = WidgetData<'category_margin'>['items'][number];
type BucketItem = WidgetData<'receivables'>['items'][number];

function weekLabel(iso: string): string {
  return iso.slice(5, 10).split('-').reverse().join('.');
}

/**
 * Недельный ряд одной линией: подписи — начало недели (UTC).
 *
 * Шкала значений — в сокращённой записи языка интерфейса («21 млн»):
 * суммы маржи в миллионах не помещаются в подпись оси целиком.
 */
function seriesOption(labels: string[], values: number[], color: string, locale: string): ChartOption {
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  return {
    grid: { left: 8, right: 12, top: 12, bottom: 24, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: (value: number) => compact.format(value) } },
    series: [{ type: 'line', data: values, smooth: false, symbolSize: 5, lineStyle: { color }, itemStyle: { color } }],
  };
}

/**
 * Дашборд руководителя `[ТЗ 3.6.2]`.
 *
 * Состав — `SPEC.md § 9.2`: количество рейсов и динамика, маржа в абсолюте
 * и процентах по периодам, топ клиентов по выручке и по марже, топ
 * поставщиков по обороту, маржа по категориям, доля рейсов с маржой ниже
 * порога, загрузка парка. Все величины считает сервер по агрегатному пути
 * маржи (ADR-012); время его обновления показано рядом с заголовком.
 */
export function ManagerDashboard(): JSX.Element {
  const { t } = useTranslation();
  const query = useDashboard('manager');

  return (
    <>
      <PageHeader
        title={t('nav.dashboardManager')}
        meta={
          query.data ? (
            query.data.generatedAt ? (
              <span>
                {t('dashboard.refreshedAt')} <UtcTime value={query.data.generatedAt} withDate />
              </span>
            ) : (
              <span>{t('dashboard.notRefreshed')}</span>
            )
          ) : null
        }
      />
      <QueryState query={query}>
        {(dashboard) => (
          <DashboardGrid
            role="manager"
            dashboard={dashboard}
            render={(code) => <ManagerWidget dashboard={dashboard} code={code} />}
          />
        )}
      </QueryState>
    </>
  );
}

function ManagerWidget({ dashboard, code }: { dashboard: DashboardData; code: string }): JSX.Element {
  const { t } = useTranslation();

  const show = <C extends WidgetCode>(
    widget: C,
    draw: (data: WidgetData<C>) => ReactNode,
  ): JSX.Element => {
    const result = widgetResult(dashboard, widget);
    return result.kind === 'ok' ? <>{draw(result.data)}</> : <Alert type="warning" showIcon message={result.message} />;
  };

  switch (code) {
    case 'flights_count':
      return show('flights_count', (data) => (
        <FlightsCount data={data} />
      ));
    case 'margin_summary':
      return show('margin_summary', (data) => <MarginSummary data={data} />);
    case 'margin_health':
      return show('margin_health', (data) => (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Share
            label={t('dashboard.belowThresholdOf', { threshold: data.thresholdPercent })}
            part={data.belowThreshold}
            total={data.total}
            color={STATUS_TOKENS.warning.color}
          />
          <Share
            label={t('dashboard.negativeMargin')}
            part={data.negative}
            total={data.total}
            color={STATUS_TOKENS.critical.color}
          />
        </Space>
      ));
    case 'fleet_usage':
      return show('fleet_usage', (data) => (
        <Share
          label={t('dashboard.fleetUsage')}
          part={data.used}
          total={data.total}
          color={STATUS_TOKENS.progress.color}
        />
      ));
    case 'category_margin':
      return show('category_margin', (data) => (
        <DataTable<CategoryItem>
          size="small" rowKey="category" pagination={false} dataSource={data.items}
          locale={{ emptyText: <EmptyState /> }}
          columns={[
            {
              title: t('service.category'), dataIndex: 'category',
              render: (value: string) => t(`serviceCategory.${value}`),
            },
            {
              title: t('finance.margin'), key: 'margin', align: 'right',
              render: (_: unknown, row: CategoryItem) => <MoneyText value={row.margin} colorBySign />,
            },
            {
              title: t('finance.marginPercent'), dataIndex: 'marginPercent', width: 100, align: 'right',
              render: (value: string | null) => <PercentText value={value} colorBySign />,
            },
          ]}
        />
      ));
    case 'top_clients':
      return show('top_clients', (data) => {
        const columns = [
          { title: t('flight.client'), dataIndex: 'name', ellipsis: true },
          { title: t('dashboard.flights'), dataIndex: 'flights', width: 80, align: 'right' as const },
          {
            title: t('finance.revenue'), key: 'revenue', width: 150, align: 'right' as const,
            render: (_: unknown, row: ClientItem) => <MoneyText value={row.revenue} />,
          },
          {
            title: t('finance.margin'), key: 'margin', width: 150, align: 'right' as const,
            render: (_: unknown, row: ClientItem) => <MoneyText value={row.margin} colorBySign />,
          },
          {
            title: t('finance.marginPercent'), dataIndex: 'marginPercent', width: 100, align: 'right' as const,
            render: (value: string | null) => <PercentText value={value} colorBySign />,
          },
        ];
        return (
          <Tabs
            size="small"
            items={[
              {
                key: 'revenue',
                label: t('dashboard.byRevenue'),
                children: (
                  <DataTable<ClientItem>
                    size="small" rowKey="clientId" pagination={false} dataSource={data.byRevenue}
                    columns={columns} scroll={{ x: 560 }} locale={{ emptyText: <EmptyState /> }}
                  />
                ),
              },
              {
                key: 'margin',
                label: t('dashboard.byMargin'),
                children: (
                  <DataTable<ClientItem>
                    size="small" rowKey="clientId" pagination={false} dataSource={data.byMargin}
                    columns={columns} scroll={{ x: 560 }} locale={{ emptyText: <EmptyState /> }}
                  />
                ),
              },
            ]}
          />
        );
      });
    case 'top_vendors':
      return show('top_vendors', (data) => (
        <DataTable<VendorItem>
          size="small" rowKey="vendorId" pagination={false} dataSource={data.items}
          scroll={{ x: 420 }} locale={{ emptyText: <EmptyState /> }}
          columns={[
            { title: t('service.vendor'), dataIndex: 'name', ellipsis: true },
            {
              title: t('dashboard.turnover'), key: 'turnover', width: 160, align: 'right',
              render: (_: unknown, row: VendorItem) => <MoneyText value={row.turnover} />,
            },
            {
              title: t('vendor.rating'), key: 'rating', width: 120,
              render: (_: unknown, row: VendorItem) =>
                row.sufficientData && row.rating ? (
                  <Mono>{row.rating}</Mono>
                ) : (
                  <Tag>{t('vendor.insufficientData')}</Tag>
                ),
            },
          ]}
        />
      ));
    case 'receivables':
    case 'payables':
      return show(code, (data) => (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <DataTable<BucketItem>
            size="small" rowKey="bucket" pagination={false} dataSource={data.items}
            columns={[
              { title: t('dashboard.bucket'), dataIndex: 'bucket', render: (value: string) => <Mono>{value}</Mono> },
              {
                title: t('finance.amount'), key: 'amount', align: 'right',
                render: (_: unknown, row: BucketItem) => <MoneyText value={row.amount} />,
              },
            ]}
          />
          {data.rateDate ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('dashboard.rateDate', { date: data.rateDate })}
            </Typography.Text>
          ) : null}
        </Space>
      ));
    default:
      return <EmptyState />;
  }
}

function Share({
  label,
  part,
  total,
  color,
}: {
  label: string;
  part: number;
  total: number;
  color: string;
}): JSX.Element {
  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text style={{ fontSize: 12 }}>{label}</Typography.Text>
        <Mono>
          {part} / {total}
        </Mono>
      </Space>
      <Progress percent={(part / Math.max(1, total)) * 100} size="small" showInfo={false} strokeColor={color} />
    </div>
  );
}

function FlightsCount({ data }: { data: WidgetData<'flights_count'> }): JSX.Element {
  const { t, i18n } = useTranslation();
  const option = useMemo(
    () =>
      seriesOption(
        data.series.map((point) => weekLabel(point.weekStart)),
        data.series.map((point) => point.count),
        STATUS_TOKENS.progress.color,
        i18n.language,
      ),
    [data, i18n.language],
  );
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <KpiTile value={data.total} footnote={t('dashboard.last30Days')} />
      <EChart option={option} height={110} label={t('dashboard.flightsTrend')} />
    </Space>
  );
}

function MarginSummary({ data }: { data: WidgetData<'margin_summary'> }): JSX.Element {
  const { t, i18n } = useTranslation();
  const option = useMemo(
    () =>
      seriesOption(
        data.series.map((point) => weekLabel(point.weekStart)),
        // Для линии графика — число; суммы на экране выводятся строкой из ответа.
        data.series.map((point) => Number.parseFloat(point.margin.amount)),
        STATUS_TOKENS.done.color,
        i18n.language,
      ),
    [data, i18n.language],
  );
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={24} wrap>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('finance.revenue')}</Typography.Text>
          <div><MoneyText value={data.revenue} strong /></div>
        </div>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('finance.cost')}</Typography.Text>
          <div><MoneyText value={data.cost} strong /></div>
        </div>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('finance.margin')}</Typography.Text>
          <div><MoneyText value={data.margin} strong colorBySign /></div>
        </div>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('finance.marginPercent')}</Typography.Text>
          <div><PercentText value={data.marginPercent} colorBySign /></div>
        </div>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('dashboard.marginByWeek')}</Typography.Text>
      <EChart option={option} height={120} label={t('dashboard.marginByWeek')} />
    </Space>
  );
}
