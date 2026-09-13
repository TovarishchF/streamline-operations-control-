import { useMemo, type JSX } from 'react';
import { Card, Col, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { DataTable } from '@/shared/ui/DataTable';

import type { VendorRating } from '@/api/types';
import { PAYABLES_BUCKETS, RECEIVABLES_BUCKETS } from '@/mocks/billing';
import { CLIENTS, VENDORS } from '@/mocks/counterparties';
import { FLIGHT_LIST, MARGINS, SERVICE_ORDERS } from '@/mocks/flights';
import { AIRCRAFT } from '@/mocks/reference';
import { EmptyState, MoneyText, Mono, PercentText } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Дашборд руководителя `[ТЗ 3.6.2]`.
 *
 * Состав — `SPEC.md § 9.2`: количество рейсов и динамика, маржа в абсолюте
 * и процентах, топ клиентов по выручке и по марже, топ поставщиков по обороту,
 * средняя маржа по категориям, доля рейсов с маржой ниже порога, загрузка парка.
 *
 * `CLAUDE.md § 3` п. 16: все величины приходят посчитанными с сервера.
 * Здесь они только агрегируются по готовым значениям для отображения.
 */
interface ClientRow {
  id: string;
  name: string;
  revenue: number;
  margin: number;
  flights: number;
  percent: string | null;
}

interface VendorRow {
  id: string;
  name: string;
  rating: VendorRating | null | undefined;
  turnover: number;
}

export function ManagerDashboard(): JSX.Element {
  const { t } = useTranslation();

  const stats = useMemo(() => {
    const margins = FLIGHT_LIST.map((flight) => MARGINS.get(flight.id)).filter(
      (m): m is NonNullable<typeof m> => m !== undefined,
    );

    const revenue = margins.reduce((sum, m) => sum + Number.parseFloat(m.revenue.amount), 0);
    const cost = margins.reduce((sum, m) => sum + Number.parseFloat(m.cost.amount), 0);
    const belowThreshold = margins.filter((m) => m.isBelowThreshold).length;
    const negative = margins.filter((m) => Number.parseFloat(m.margin.amount) < 0).length;

    return {
      revenue, cost, margin: revenue - cost,
      marginPercent: revenue === 0 ? null : (((revenue - cost) / revenue) * 100).toFixed(4),
      belowThreshold, negative, total: margins.length,
    };
  }, []);

  const topClients: ClientRow[] = useMemo(() => {
    const byClient = new Map<string, { revenue: number; margin: number; flights: number }>();
    for (const flight of FLIGHT_LIST) {
      const margin = MARGINS.get(flight.id);
      if (!margin) continue;
      const current = byClient.get(flight.clientId ?? '') ?? { revenue: 0, margin: 0, flights: 0 };
      current.revenue += Number.parseFloat(margin.revenue.amount);
      current.margin += Number.parseFloat(margin.margin.amount);
      current.flights += 1;
      byClient.set(flight.clientId ?? '', current);
    }
    return Array.from(byClient.entries())
      .map(([id, value]) => ({
        id,
        name: CLIENTS.find((c) => c.id === id)?.name ?? id,
        ...value,
        percent: value.revenue === 0 ? null : ((value.margin / value.revenue) * 100).toFixed(4),
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6);
  }, []);

  const topVendors: VendorRow[] = useMemo(() => {
    const byVendor = new Map<string, number>();
    for (const order of SERVICE_ORDERS) {
      if (!order.vendorId) continue;
      byVendor.set(
        order.vendorId,
        (byVendor.get(order.vendorId) ?? 0) + Number.parseFloat(order.purchaseCost?.amount ?? '0'),
      );
    }
    return Array.from(byVendor.entries())
      .map(([id, turnover]) => ({
        id,
        name: VENDORS.find((v) => v.id === id)?.name ?? id,
        rating: VENDORS.find((v) => v.id === id)?.rating,
        turnover,
      }))
      .sort((a, b) => b.turnover - a.turnover)
      .slice(0, 6);
  }, []);

  const fleetUsage = useMemo(() => {
    const used = new Set(FLIGHT_LIST.map((f) => f.aircraftId).filter(Boolean));
    return { used: used.size, total: AIRCRAFT.length };
  }, []);

  const rub = (amount: number) => ({ amount: amount.toFixed(4), currency: 'RUB' as const });

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('nav.dashboardManager')}
      </Typography.Title>

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title={t('dashboard.flightsTotal')} value={stats.total} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('finance.revenue')} value={0}
              valueRender={() => <MoneyText value={rub(stats.revenue)} strong />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('finance.margin')} value={0}
              valueRender={() => <MoneyText value={rub(stats.margin)} strong colorBySign />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('finance.marginPercent')} value={0}
              valueRender={() => <PercentText value={stats.marginPercent} colorBySign threshold={12} />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}>
          <Card size="small" title={t('dashboard.marginHealth')}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <div>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Typography.Text style={{ fontSize: 12 }}>{t('dashboard.belowThreshold')}</Typography.Text>
                  <Mono>{stats.belowThreshold} / {stats.total}</Mono>
                </Space>
                <Progress
                  percent={(stats.belowThreshold / Math.max(1, stats.total)) * 100}
                  size="small" showInfo={false}
                  strokeColor={STATUS_TOKENS.warning.color}
                />
              </div>
              <div>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Typography.Text style={{ fontSize: 12 }}>{t('dashboard.negativeMargin')}</Typography.Text>
                  <Mono>{stats.negative} / {stats.total}</Mono>
                </Space>
                <Progress
                  percent={(stats.negative / Math.max(1, stats.total)) * 100}
                  size="small" showInfo={false}
                  strokeColor={STATUS_TOKENS.critical.color}
                />
              </div>
              <div>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Typography.Text style={{ fontSize: 12 }}>{t('dashboard.fleetUsage')}</Typography.Text>
                  <Mono>{fleetUsage.used} / {fleetUsage.total}</Mono>
                </Space>
                <Progress
                  percent={(fleetUsage.used / Math.max(1, fleetUsage.total)) * 100}
                  size="small" showInfo={false}
                  strokeColor={STATUS_TOKENS.progress.color}
                />
              </div>
            </Space>
          </Card>
        </Col>

        <Col xs={24} md={8}>
          <Card size="small" title={t('dashboard.receivables')} styles={{ body: { padding: 0 } }}>
            <DataTable
              size="small" rowKey="bucket" pagination={false}
              dataSource={RECEIVABLES_BUCKETS}
              columns={[
                { title: t('dashboard.bucket'), dataIndex: 'bucket', render: (v: string) => <Mono>{v}</Mono> },
                {
                  title: t('finance.amount'), key: 'amount', align: 'right',
                  render: (_, row: { amount: { amount: string; currency: string } }) => (
                    <MoneyText value={row.amount as never} />
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} md={8}>
          <Card size="small" title={t('dashboard.payables')} styles={{ body: { padding: 0 } }}>
            <DataTable
              size="small" rowKey="bucket" pagination={false}
              dataSource={PAYABLES_BUCKETS}
              columns={[
                { title: t('dashboard.bucket'), dataIndex: 'bucket', render: (v: string) => <Mono>{v}</Mono> },
                {
                  title: t('finance.amount'), key: 'amount', align: 'right',
                  render: (_, row: { amount: { amount: string; currency: string } }) => (
                    <MoneyText value={row.amount as never} />
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('dashboard.topClients')} styles={{ body: { padding: 0 } }}>
            <DataTable<ClientRow>
              size="small" rowKey="id" pagination={false} dataSource={topClients}
              locale={{ emptyText: <EmptyState /> }}
              columns={[
                { title: t('flight.client'), dataIndex: 'name', ellipsis: true },
                { title: t('dashboard.flights'), dataIndex: 'flights', width: 80, align: 'right' },
                {
                  title: t('finance.revenue'), key: 'revenue', width: 150, align: 'right',
                  render: (_: unknown, row: ClientRow) => <MoneyText value={rub(row.revenue)} />,
                },
                {
                  title: t('finance.marginPercent'), key: 'percent', width: 110, align: 'right',
                  render: (_: unknown, row: ClientRow) => (
                    <PercentText value={row.percent} colorBySign threshold={12} />
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card size="small" title={t('dashboard.topVendors')} styles={{ body: { padding: 0 } }}>
            <DataTable<VendorRow>
              size="small" rowKey="id" pagination={false} dataSource={topVendors}
              locale={{ emptyText: <EmptyState /> }}
              columns={[
                { title: t('service.vendor'), dataIndex: 'name', ellipsis: true },
                {
                  title: t('dashboard.turnover'), key: 'turnover', width: 160, align: 'right',
                  render: (_: unknown, row: VendorRow) => <MoneyText value={rub(row.turnover)} />,
                },
                {
                  title: t('vendor.rating'), key: 'rating', width: 120,
                  render: (_: unknown, row: VendorRow) =>
                    row.rating?.sufficientData ? (
                      <Mono>{Number.parseFloat(row.rating.rating ?? '0').toFixed(2)}</Mono>
                    ) : (
                      <Tag>{t('vendor.insufficientData')}</Tag>
                    ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
