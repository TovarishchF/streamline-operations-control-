import type { JSX } from 'react';
import { Card, Col, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { PayableRow } from '@/api/billing';
import { useVendorPerformance, useVendorPortalPayables } from '@/api/portals';
import { QueryState } from '@/shared/ui/QueryState';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const COMPONENTS = [
  { key: 'onTimeConfirmRate', label: 'vendor.onTimeConfirm' },
  { key: 'slaComplianceRate', label: 'vendor.slaCompliance' },
  { key: 'billingAccuracy', label: 'vendor.billingAccuracy' },
] as const;

/**
 * Показатели поставщика `[ТЗ 4.3]`: те же составляющие, что и во внутреннем
 * рейтинге (`GET /portal/vendor/performance`), — расчёт прозрачен.
 * Составляющая без данных показывается прочерком, а не нулём (G-55).
 */
export function VendorPerformancePage(): JSX.Element {
  const { t } = useTranslation();
  const query = useVendorPerformance();

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.vendor.performance')}
      </Typography.Title>

      <QueryState query={query}>
        {(rating) =>
          !rating.sufficientData ? (
            <Card>
              <EmptyState description={t('vendor.insufficientDataHint', { count: rating.orderCount })} />
            </Card>
          ) : (
            <Row gutter={[12, 12]}>
              <Col xs={24} md={8}>
                <Card size="small">
                  <Statistic title={t('vendor.rating')} value={rating.rating ?? '—'} suffix="/ 5" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('vendor.basedOn', { count: rating.orderCount })}
                  </Typography.Text>
                </Card>
              </Col>
              <Col xs={24} md={16}>
                <Card size="small" title={t('vendor.sections.rating')}>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    {COMPONENTS.map(({ key, label }) => {
                      const raw = rating.components[key];
                      // Доля — для полосы и подписи; сам показатель считает сервер.
                      const value = raw === null ? null : Number.parseFloat(raw);
                      return (
                        <div key={key}>
                          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Typography.Text style={{ fontSize: 12 }}>{t(label)}</Typography.Text>
                            <Mono>{value === null ? '—' : `${(value * 100).toFixed(0)} %`}</Mono>
                          </Space>
                          <Progress
                            percent={value === null ? 0 : value * 100}
                            size="small"
                            showInfo={false}
                            strokeColor={
                              value === null
                                ? STATUS_TOKENS.neutral.color
                                : value >= 0.9
                                  ? STATUS_TOKENS.done.color
                                  : value >= 0.75
                                    ? STATUS_TOKENS.warning.color
                                    : STATUS_TOKENS.critical.color
                            }
                          />
                        </div>
                      );
                    })}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('portal.vendor.ratingHint')}
                    </Typography.Text>
                  </Space>
                </Card>
              </Col>
            </Row>
          )
        }
      </QueryState>
    </Space>
  );
}

/** Заявки на оплату поставщика и их статусы (`GET /portal/vendor/payables`). */
export function VendorPayablesPage(): JSX.Element {
  const { t } = useTranslation();
  const query = useVendorPortalPayables();

  const columns: DataColumns<PayableRow> = [
    {
      title: t('finance.number'), dataIndex: 'number', width: 180,
      render: (value: string | null) => <Mono>{value ?? '—'}</Mono>,
    },
    {
      title: t('finance.amount'), key: 'amount', width: 160, align: 'right',
      render: (_, row) => <MoneyText value={row.amount} strong />,
    },
    {
      title: t('finance.dueDate'), dataIndex: 'dueDate', width: 160,
      render: (value: string, row) => (
        <Space size={4}>
          <DateText value={value} />
          {row.isOverdue ? <Tag color="red" style={{ margin: 0 }}>{t('finance.overdue')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('finance.status'), dataIndex: 'status', width: 160,
      render: (value: string) => <Tag>{t(`payableStatus.${value}`)}</Tag>,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.vendor.payables')}
      </Typography.Title>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<PayableRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 700 }}
              locale={{ emptyText: <EmptyState /> }}
            />
          )}
        </QueryState>
      </Card>
    </Space>
  );
}
