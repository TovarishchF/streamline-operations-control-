import { useState, type JSX } from 'react';
import { App, Button, Card, Input, Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import {
  useOrderTransition,
  useServiceOrders,
  type ServiceOrderRow,
} from '@/api/orders';
import { FinishOrderModal, transitionErrorText } from '@/modules/flights/FinishOrderModal';
import { useCurrentUser } from '@/shared/auth/session';
import { useClock } from '@/shared/clock/useClock';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import {
  EmptyState, MoneyText, Mono, ServiceStatusTag, UtcTime,
} from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { Notice } from '@/shared/ui/Notice';

/**
 * Заявки в портале поставщика `[ТЗ 4.3]`.
 *
 * Поставщик видит **только свои** заявки: ни чужих заявок, ни закупочных цен
 * других поставщиков, ни цен продажи клиенту. Изоляция — на сервере,
 * фильтрацией выборки по `vendor_id` (ADR-003), а не сокрытием на экране.
 *
 * Основной сценарий — подтверждение в два касания: для поставщика это
 * рабочий инструмент, а не справочная система.
 */
export function VendorOrdersPage(): JSX.Element {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const user = useCurrentUser();
  const { nowUtc } = useClock();
  const localized = useLocalizedName();

  const [finishing, setFinishing] = useState<ServiceOrderRow | null>(null);
  const [needsResponseOnly, setNeedsResponseOnly] = useState(false);

  const query = useServiceOrders({
    vendorId: user?.vendorId ?? undefined,
    ...(needsResponseOnly ? { needsResponse: true } : {}),
  });
  const orders = query.data?.data ?? [];
  const needsResponse = orders.filter((order) => order.status === 'ordered').length;

  const transition = useOrderTransition();

  const report = (error: unknown): void => {
    void message.error(transitionErrorText(error, t('service.transitionFailed')));
  };

  const run = (
    id: string,
    name: 'confirm' | 'begin' | 'reject',
    comment?: string,
  ): void => {
    transition
      .mutateAsync({ id, transition: name, ...(comment ? { comment } : {}) })
      .then(() => {
        void message.success(
          t('service.transitionDone', { transition: t(`serviceTransition.${name}`) }),
        );
      })
      .catch(report);
  };

  /** Отказ требует причины: она уходит диспетчеру и в аудит. */
  const requestReject = (id: string): void => {
    let reason = '';
    modal.confirm({
      title: t('portal.vendor.reject'),
      content: (
        <Input.TextArea
          rows={3}
          placeholder={t('service.rejectReasonPlaceholder')}
          onChange={(event) => {
            reason = event.target.value;
          }}
        />
      ),
      okText: t('portal.vendor.reject'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => {
        run(id, 'reject', reason);
      },
    });
  };

  const countdown = (iso: string | null): string => {
    if (!iso) return '—';
    const diff = new Date(iso).getTime() - nowUtc.getTime();
    if (diff < 0) return t('service.overdue');
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return t('service.countdown', { h: hours, m: minutes });
  };

  const columns: DataColumns<ServiceOrderRow> = [
    {
      title: t('service.name'), key: 'service', width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.service ? localized(row.service.name) : row.serviceId}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Mono>{row.airportIcao}</Mono> · {t(`serviceLeg.${row.leg}`)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('service.quantity'), dataIndex: 'quantity', width: 110, align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('finance.cost'), key: 'cost', width: 150, align: 'right',
      render: (_, row) => <MoneyText value={row.purchaseCost} />,
    },
    {
      title: t('service.orderedAt'), dataIndex: 'orderedAt', width: 150,
      render: (value: string | null) =>
        value ? <UtcTime value={value} /> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('service.status'), dataIndex: 'status', width: 150,
      render: (value: string) => <ServiceStatusTag status={value} />,
    },
    {
      title: t('service.slaDeadline'), key: 'sla', width: 150,
      render: (_, row) =>
        row.status === 'ordered' ? (
          <Space direction="vertical" size={0}>
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
          {row.availableTransitions.includes('confirm') ? (
            <Button
              size="small"
              type="primary"
              loading={transition.isPending}
              onClick={() => { run(row.id, 'confirm'); }}
            >
              {t('portal.vendor.confirm')}
            </Button>
          ) : null}
          {row.availableTransitions.includes('reject') ? (
            <Button size="small" danger onClick={() => { requestReject(row.id); }}>
              {t('portal.vendor.reject')}
            </Button>
          ) : null}
          {row.availableTransitions.includes('begin') ? (
            <Button
              size="small"
              loading={transition.isPending}
              onClick={() => { run(row.id, 'begin'); }}
            >
              {t('serviceTransition.begin')}
            </Button>
          ) : null}
          {row.availableTransitions.includes('finish') ? (
            <Button
              size="small"
              type="primary"
              onClick={() => {
                setFinishing(row);
              }}
            >
              {t('serviceTransition.finish')}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.vendor.orders')}
      </Typography.Title>

      {needsResponse > 0 ? (
        <Notice
          id={`portal.vendor.needsResponse:${String(needsResponse)}`}
          type="warning"
          showIcon
          message={t('portal.vendor.needsResponse', { count: needsResponse })}
        />
      ) : null}

      <Tag.CheckableTag checked={needsResponseOnly} onChange={setNeedsResponseOnly}>
        {t('portal.vendor.needsResponseOnly')}
      </Tag.CheckableTag>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<ServiceOrderRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 1050 }}
              locale={{ emptyText: <EmptyState description={t('portal.vendor.noOrders')} /> }}
            />
          )}
        </QueryState>
      </Card>

      <FinishOrderModal
        order={finishing}
        onClose={() => {
          setFinishing(null);
        }}
      />
    </Space>
  );
}
