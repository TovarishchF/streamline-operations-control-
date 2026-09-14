import { useState, type JSX } from 'react';
import { App, Button, Card, Space, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { PaperClipOutlined, PlusOutlined, SwapOutlined, WarningOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import type { Flight } from '@/api/flights';
import type { ServiceOrder } from '@/api/types';
import { useSocStore } from '@/mocks/store';
import { Can } from '@/shared/auth/Can';
import { usePermission } from '@/shared/auth/session';
import { EmptyState, MoneyText, Mono, ServiceStatusTag, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { ServiceOrderWizard } from './ServiceOrderWizard';
import { VendorSuggestModal } from '@/modules/vendors/VendorSuggestModal';

/**
 * Заявки на услуги по рейсу `[ТЗ 3.2.3]`.
 *
 * Закупочная цена скрыта от ролей без права `billing.purchase_price.view` —
 * клиент не должен видеть, по какой цене мы покупаем. На сервере это
 * обеспечивается составом ответа, а не фильтрацией здесь (ADR-003).
 */
export function FlightServicesTab({
  flight,
  orders,
}: {
  flight: Flight;
  orders: ServiceOrder[];
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const transitionOrder = useSocStore((state) => state.transitionOrder);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [suggestFor, setSuggestFor] = useState<ServiceOrder | null>(null);
  const canSeePurchase = usePermission('billing.purchase_price.view');

  const columns: DataColumns<ServiceOrder> = [
    {
      title: t('service.name'), key: 'service', width: 230, fixed: 'left',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <span>{row.service?.name.ru ?? row.serviceId}</span>
            {row.replacedOrderId ? (
              <Tooltip title={t('service.reassignedFrom')}>
                <SwapOutlined style={{ color: STATUS_TOKENS.progress.color }} />
              </Tooltip>
            ) : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t(`serviceCategory.${row.service?.category ?? 'handling'}`)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('service.leg'), dataIndex: 'leg', width: 96,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{t(`serviceLeg.${value}`)}</span>
          <Mono>{row.airportIcao}</Mono>
        </Space>
      ),
    },
    {
      title: t('service.vendor'), dataIndex: 'vendorName', width: 160, ellipsis: true,
      render: (value: string) => value || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('service.quantity'), key: 'quantity', width: 120, align: 'right',
      render: (_, row) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <Mono>{row.quantity}</Mono>
          {/* ADR-020: фактическое количество идёт в счёт, план и факт расходятся */}
          {row.actualQuantity && row.actualQuantity !== row.quantity ? (
            <Tooltip title={t('service.actualQuantityHint')}>
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                <Mono>{t('service.fact')}: {row.actualQuantity}</Mono>
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    ...(canSeePurchase
      ? ([
          {
            title: t('service.purchaseCost'), key: 'cost', width: 130, align: 'right',
            render: (_, row) => <MoneyText value={row.purchaseCost} />,
          },
        ] as DataColumns<ServiceOrder>)
      : []),
    {
      title: t('service.salePrice'), key: 'sale', width: 130, align: 'right',
      render: (_, row) => <MoneyText value={row.salePrice} strong />,
    },
    {
      title: t('service.status'), dataIndex: 'status', width: 150,
      render: (value: string, row) => (
        <Space size={4}>
          <ServiceStatusTag status={value} />
          {row.slaBreached ? (
            <Tooltip title={t('service.slaBreachedHint')}>
              <WarningOutlined style={{ color: STATUS_TOKENS.critical.color }} />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('service.sla'), key: 'sla', width: 110,
      render: (_, row) =>
        row.status === 'ordered' && row.slaConfirmDeadline ? (
          <UtcTime value={row.slaConfirmDeadline} />
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('service.documents'), key: 'docs', width: 80, align: 'center',
      render: (_, row) =>
        (row.documents?.length ?? 0) > 0 ? (
          <Tooltip title={row.documents?.map((d) => d.fileName).join(', ')}>
            <Space size={2}>
              <PaperClipOutlined />
              {row.documents?.length}
            </Space>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 190, fixed: 'right',
      render: (_, row) => (
        <Space size={4} wrap>
          {row.status === 'ordered' ? (
            <Can permission="service.confirm">
              <Space size={4}>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => { runTransition(row.id, 'confirm'); }}
                >
                  {t('serviceTransition.confirm')}
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={() => { runTransition(row.id, 'reject'); }}
                >
                  {t('serviceTransition.reject')}
                </Button>
              </Space>
            </Can>
          ) : null}
          {row.status === 'rejected' ? (
            <Can permission="vendor.assign">
              <Button
                size="small" type="primary"
                onClick={() => { setSuggestFor(row); }}
              >
                {t('service.reassign')}
              </Button>
            </Can>
          ) : null}
          {row.status === 'confirmed' ? (
            <Can permission="service.confirm">
              <Button size="small" onClick={() => { runTransition(row.id, 'begin'); }}>
                {t('serviceTransition.begin')}
              </Button>
            </Can>
          ) : null}
          {row.status === 'in_progress' ? (
            <Can permission="service.confirm">
              <Button
                size="small"
                type="primary"
                onClick={() => { runTransition(row.id, 'finish'); }}
              >
                {t('serviceTransition.finish')}
              </Button>
            </Can>
          ) : null}
          <Can permission="vendor.assign">
            <Button size="small" onClick={() => { setSuggestFor(row); }}>
              {t('service.compareVendors')}
            </Button>
          </Can>
        </Space>
      ),
    },
  ];

  const rejected = orders.filter((o) => o.status === 'rejected');

  /** Переход заявки. Проверяется против shared/state-machines/service-order.json. */
  const runTransition = (id: string, transition: 'confirm' | 'begin' | 'finish' | 'reject'): void => {
    const error = transitionOrder(id, transition);
    if (error) {
      void message.error(t('service.transitionFailed'));
      return;
    }
    void message.success(t('service.transitionDone', { transition: t(`serviceTransition.${transition}`) }));
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Space size={8} wrap>
          <Typography.Text type="secondary">
            {t('service.summary', {
              total: orders.length,
              confirmed: orders.filter((o) => o.status === 'confirmed' || o.status === 'completed').length,
            })}
          </Typography.Text>
          {rejected.length > 0 ? (
            <Tag color="red">{t('service.rejectedCount', { count: rejected.length })}</Tag>
          ) : null}
        </Space>
        <Can permission="service.order">
          <Button
            type="primary" icon={<PlusOutlined />}
            onClick={() => { setWizardOpen(true); }}
          >
            {t('service.orderNew')}
          </Button>
        </Can>
      </Space>

      <DataTable<ServiceOrder>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={orders}
        pagination={false}
        scroll={{ x: 1200 }}
        locale={{
          emptyText: (
            <EmptyState
              description={t('service.emptyForFlight')}
              action={
                <Can permission="service.order">
                  <Button type="primary" onClick={() => { setWizardOpen(true); }}>
                    {t('service.orderNew')}
                  </Button>
                </Can>
              }
            />
          ),
        }}
        rowClassName={(row) => (row.status === 'rejected' ? 'soc-row-critical' : '')}
      />

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('service.autoReservationHint')}
        </Typography.Text>
      </Card>

      <ServiceOrderWizard
        flight={flight}
        open={wizardOpen}
        onClose={() => { setWizardOpen(false); }}
      />

      <VendorSuggestModal
        order={suggestFor}
        flight={flight}
        onClose={() => { setSuggestFor(null); }}
      />
    </Space>
  );
}
