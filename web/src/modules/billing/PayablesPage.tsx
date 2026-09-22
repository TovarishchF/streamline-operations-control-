import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Popconfirm, Row, Select, Space, Tag, Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useApprovePayable, usePayables, type PayableRow } from '@/api/billing';
import { ApiError } from '@/api/client';
import { useVendors } from '@/api/counterparties';
import { Can } from '@/shared/auth/Can';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  pending: 'neutral', approved: 'progress', scheduled: 'ready',
  paid: 'done', disputed: 'critical', cancelled: 'cancelled',
};

/**
 * Заявки на оплату поставщикам `[ТЗ 3.4.2]`.
 *
 * Создаются автоматически при переходе услуги в «Выполнена». Срок оплаты —
 * дата выполнения плюс отсрочка из **снимка** условий контракта (ADR-025):
 * перезаключение договора не меняет сроки по уже оказанным услугам.
 */
export function PayablesPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [vendorId, setVendorId] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [overdueOnly, setOverdueOnly] = useState(false);

  // Отбор выполняет сервер: реестр листается постранично, и выкачивать
  // его целиком ради фильтра нельзя.
  const query = usePayables({
    ...(vendorId ? { vendorId } : {}),
    ...(status ? { status } : {}),
    overdue: overdueOnly,
  });
  const approve = useApprovePayable();
  const vendors = useVendors().data?.data ?? [];

  const rows = query.data?.data ?? [];
  const overdueCount = rows.filter((item) => item.isOverdue).length;

  const confirmApproval = async (id: string): Promise<void> => {
    try {
      await approve.mutateAsync(id);
      void message.success(t('finance.approved'));
    } catch (error) {
      void message.error(
        error instanceof ApiError ? error.message : t('common.saveFailed'),
      );
    }
  };

  const columns: DataColumns<PayableRow> = [
    {
      title: t('finance.number'), dataIndex: 'number', width: 170, fixed: 'left',
      render: (value: string | null) => <Mono>{value ?? '—'}</Mono>,
    },
    {
      title: t('service.vendor'), dataIndex: 'vendorName', ellipsis: true,
      render: (value: string, row) => <Link to={`/vendors/${row.vendorId}`}>{value}</Link>,
    },
    {
      title: t('finance.amount'), key: 'amount', width: 160, align: 'right',
      sortBy: (row) => Number.parseFloat(row.amount.amount),
      sorter: (a, b) => Number.parseFloat(a.amount.amount) - Number.parseFloat(b.amount.amount),
      render: (_, row) => <MoneyText value={row.amount} strong />,
    },
    {
      title: t('finance.dueDate'), dataIndex: 'dueDate', width: 130,
      sorter: (a, b) => a.dueDate.localeCompare(b.dueDate),
      render: (value: string, row) => (
        <Space size={4}>
          <DateText value={value} />
          {row.isOverdue ? <Tag color="red" style={{ margin: 0 }}>{t('finance.overdue')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('finance.status'), dataIndex: 'status', width: 150,
      render: (value: string) => {
        const token = STATUS_TOKENS[TOKEN[value] ?? 'neutral'];
        return (
          <Tag style={{ color: token.color, background: token.background, borderColor: token.border, margin: 0 }}>
            {t(`payableStatus.${value}`)}
          </Tag>
        );
      },
    },
    {
      title: t('reconciliation.title'), dataIndex: 'vendorInvoiceId', width: 130,
      render: (value: string | null) =>
        value ? (
          <Link to="/billing/reconciliation">{t('reconciliation.linked')}</Link>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 140,
      render: (_, row) =>
        row.status === 'pending' ? (
          <Can permission="billing.payables.edit">
            {/* Согласование — обязательство заплатить: подтверждается
                отдельным шагом, а не одним нажатием в таблице. */}
            <Popconfirm
              title={t('finance.approveConfirm', {
                amount: `${row.amount.amount} ${row.amount.currency}`,
                vendor: row.vendorName,
              })}
              okText={t('common.yes')}
              cancelText={t('common.no')}
              onConfirm={() => { void confirmApproval(row.id); }}
            >
              <Button size="small" type="primary" loading={approve.isPending}>
                {t('finance.approve')}
              </Button>
            </Popconfirm>
          </Can>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.payables')}</Typography.Title>

      {overdueCount > 0 ? (
        <Alert type="warning" showIcon message={t('finance.payablesOverdue', { count: overdueCount })} />
      ) : null}

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]} align="middle">
          <Col xs={12} md={8}>
            <Select
              allowClear showSearch optionFilterProp="label" style={{ width: '100%' }}
              placeholder={t('service.vendor')} value={vendorId} onChange={setVendorId}
              options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
            />
          </Col>
          <Col xs={12} md={6}>
            <Select
              allowClear style={{ width: '100%' }} placeholder={t('finance.status')}
              value={status} onChange={setStatus}
              options={Object.keys(TOKEN).map((code) => ({ value: code, label: t(`payableStatus.${code}`) }))}
            />
          </Col>
          <Col xs={24} md={6}>
            <Tag.CheckableTag checked={overdueOnly} onChange={setOverdueOnly}>
              {t('finance.overdueOnly')}
            </Tag.CheckableTag>
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<PayableRow>
          size="small" rowKey="id" columns={columns} dataSource={rows}
          loading={query.isFetching}
          pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1050 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
