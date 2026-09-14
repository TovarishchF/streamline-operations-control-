import type { JSX } from 'react';
import {
  Card, Col, Descriptions, Progress, Row, Space, Statistic, Tag, Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { PayableItem } from '@/api/types';
import { PAYABLES } from '@/mocks/billing';
import { VENDOR_BY_ID } from '@/mocks/counterparties';
import { useCurrentUser } from '@/shared/auth/session';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/** Показатели поставщика: те же составляющие, что и во внутреннем рейтинге. */
export function VendorPerformancePage(): JSX.Element {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const vendor = user?.vendorId ? VENDOR_BY_ID.get(user.vendorId) : undefined;
  const rating = vendor?.rating;

  if (!rating?.sufficientData) {
    return (
      <Card>
        <EmptyState description={t('vendor.insufficientDataHint', { count: rating?.orderCount ?? 0 })} />
      </Card>
    );
  }

  const items = [
    { key: 'onTimeConfirmRate', label: t('vendor.onTimeConfirm') },
    { key: 'slaComplianceRate', label: t('vendor.slaCompliance') },
    { key: 'billingAccuracy', label: t('vendor.billingAccuracy') },
  ] as const;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.vendor.performance')}
      </Typography.Title>

      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}>
          <Card size="small">
            <Statistic
              title={t('vendor.rating')}
              value={Number.parseFloat(rating.rating ?? '0').toFixed(2)}
              suffix="/ 5"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('vendor.basedOn', { count: rating.orderCount })}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={16}>
          <Card size="small" title={t('vendor.sections.rating')}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {items.map(({ key, label }) => {
                const value = Number.parseFloat(rating.components?.[key] ?? '0');
                return (
                  <div key={key}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Typography.Text style={{ fontSize: 12 }}>{label}</Typography.Text>
                      <Mono>{(value * 100).toFixed(0)} %</Mono>
                    </Space>
                    <Progress
                      percent={value * 100} size="small" showInfo={false}
                      strokeColor={
                        value >= 0.9 ? STATUS_TOKENS.done.color
                          : value >= 0.75 ? STATUS_TOKENS.warning.color
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

      <Card size="small" title={t('vendor.sections.terms')}>
        <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered>
          <Descriptions.Item label={t('vendor.currency')}>
            <Mono>{vendor?.settlementCurrency}</Mono>
          </Descriptions.Item>
          <Descriptions.Item label={t('client.paymentTerms')}>
            {vendor?.paymentTerms?.deferDays ?? 0} {t('common.days')}
          </Descriptions.Item>
          <Descriptions.Item label={t('vendor.exchange')}>
            <Tag>{t(`vendor.exchangeMethod.${vendor?.exchangeMethod ?? 'email'}`)}</Tag>
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </Space>
  );
}

/** Заявки на оплату поставщика и их статусы. */
export function VendorPayablesPage(): JSX.Element {
  const { t } = useTranslation();
  const user = useCurrentUser();

  const items = PAYABLES.filter((p) => p.vendorId === user?.vendorId);

  const columns: DataColumns<PayableItem> = [
    {
      title: t('finance.number'), dataIndex: 'number', width: 180,
      render: (value: string | null) => <Mono>{value ?? '—'}</Mono>,
    },
    {
      title: t('finance.amount'), key: 'amount', width: 160, align: 'right',
      render: (_, row) => <MoneyText value={row.amount} strong />,
    },
    {
      title: t('finance.dueDate'), dataIndex: 'dueDate', width: 140,
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
        <DataTable<PayableItem>
          size="small" rowKey="id" columns={columns} dataSource={items}
          pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 700 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
