import { useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Form, Input, InputNumber, Modal, Progress,
  Row, Space, Statistic, Tag, Typography, Upload,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { CameraOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { DateTimePicker } from '@/shared/ui/DateTimePicker';

import type { PayableItem, ServiceOrder } from '@/api/types';
import { PAYABLES } from '@/mocks/billing';
import { VENDOR_BY_ID } from '@/mocks/counterparties';
import { FLIGHT_BY_ID, SERVICE_ORDERS } from '@/mocks/flights';
import { useCurrentUser } from '@/shared/auth/session';
import { useClock } from '@/shared/clock/useClock';
import {
  DateText, EmptyState, MoneyText, Mono, ServiceStatusTag, UtcTime,
} from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Портал поставщика `[ТЗ 4.3]`.
 *
 * Поставщик видит **только свои** заявки: ни чужих заявок, ни закупочных цен
 * других поставщиков, ни цен продажи клиенту. Изоляция — на сервере,
 * фильтрацией выборки по `vendor_id` (ADR-003).
 *
 * Основной сценарий — подтверждение в два касания: для поставщика это рабочий
 * инструмент, а не справочная система.
 */
export function VendorOrdersPage(): JSX.Element {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const { nowUtc } = useClock();
  const [finishing, setFinishing] = useState<ServiceOrder | null>(null);
  const [needsResponseOnly, setNeedsResponseOnly] = useState(false);

  const orders = SERVICE_ORDERS.filter((o) => o.vendorId === user?.vendorId).filter(
    (o) => !needsResponseOnly || o.status === 'ordered',
  );

  const countdown = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    const diff = new Date(iso).getTime() - nowUtc.getTime();
    if (diff < 0) return t('service.overdue');
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return `${String(hours)} ч ${String(minutes)} м`;
  };

  const columns: DataColumns<ServiceOrder> = [
    {
      title: t('service.name'), key: 'service', width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.service?.name.ru ?? row.serviceId}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Mono>{row.airportIcao}</Mono> · {t(`serviceLeg.${row.leg}`)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('flight.number'), dataIndex: 'flightId', width: 120,
      render: (value: string) => {
        const flight = FLIGHT_BY_ID.get(value);
        return (
          <Space direction="vertical" size={0}>
            <Mono>{flight?.number ?? value}</Mono>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <UtcTime value={flight?.stdUtc ?? null} withDate />
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('service.quantity'), dataIndex: 'quantity', width: 100, align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      // Поставщик видит согласованную с ним цену — и только её
      title: t('portal.vendor.agreedPrice'), key: 'price', width: 140, align: 'right',
      render: (_, row) => <MoneyText value={row.purchaseCost} />,
    },
    {
      title: t('service.status'), dataIndex: 'status', width: 150,
      render: (value: string) => <ServiceStatusTag status={value} />,
    },
    {
      title: t('service.slaDeadline'), key: 'sla', width: 140,
      render: (_, row) =>
        row.status === 'ordered' ? (
          <Space direction="vertical" size={0}>
            <UtcTime value={row.slaConfirmDeadline ?? null} />
            <Typography.Text
              style={{
                fontSize: 12,
                color: row.slaBreached ? STATUS_TOKENS.critical.color : STATUS_TOKENS.warning.color,
              }}
            >
              <Mono>{countdown(row.slaConfirmDeadline)}</Mono>
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 230, fixed: 'right',
      render: (_, row) => (
        <Space size={4} wrap>
          {row.status === 'ordered' ? (
            <>
              <Button size="small" type="primary">{t('portal.vendor.confirm')}</Button>
              <Button size="small" danger>{t('portal.vendor.reject')}</Button>
            </>
          ) : null}
          {row.status === 'confirmed' ? (
            <Button size="small">{t('serviceTransition.begin')}</Button>
          ) : null}
          {row.status === 'in_progress' ? (
            <Button size="small" type="primary" onClick={() => { setFinishing(row); }}>
              {t('serviceTransition.finish')}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const needsResponse = SERVICE_ORDERS.filter(
    (o) => o.vendorId === user?.vendorId && o.status === 'ordered',
  ).length;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.vendor.orders')}
      </Typography.Title>

      {needsResponse > 0 ? (
        <Alert type="warning" showIcon message={t('portal.vendor.needsResponse', { count: needsResponse })} />
      ) : null}

      <Tag.CheckableTag checked={needsResponseOnly} onChange={setNeedsResponseOnly}>
        {t('portal.vendor.needsResponseOnly')}
      </Tag.CheckableTag>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<ServiceOrder>
          size="small" rowKey="id" columns={columns} dataSource={orders}
          pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 1050 }}
          locale={{ emptyText: <EmptyState description={t('portal.vendor.noOrders')} /> }}
        />
      </Card>

      <Modal
        open={finishing !== null}
        title={t('portal.vendor.finishTitle')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => { setFinishing(null); }}
        onOk={() => { setFinishing(null); }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="info" showIcon message={t('portal.vendor.finishHint')} />
          <Form layout="vertical">
            <Row gutter={12}>
              <Col xs={24} md={12}>
                <Form.Item label={t('service.actualStart')} required>
                  <DateTimePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item label={t('service.actualEnd')} required>
                  <DateTimePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              label={t('service.actualQuantity')}
              required
              extra={t('service.actualQuantityHint')}
            >
              <InputNumber style={{ width: 200 }} defaultValue={Number(finishing?.quantity ?? 1)} />
            </Form.Item>
            <Form.Item label={t('service.uploadAct')} required>
              <Upload disabled>
                <Button icon={<CameraOutlined />}>{t('service.attachAct')}</Button>
              </Upload>
            </Form.Item>
            <Form.Item label={t('portal.vendor.comment')}>
              <Input.TextArea rows={2} />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </Space>
  );
}

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
