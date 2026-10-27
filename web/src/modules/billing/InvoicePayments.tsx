import { useState, type JSX } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Space, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { usePayments, useRegisterPayment, type PaymentRow } from '@/api/billing';
import { ApiError } from '@/api/client';
import type { InvoiceRow } from '@/api/documents';
import { Can } from '@/shared/auth/Can';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState, MoneyText, Mono, UtcTime } from '@/shared/ui/primitives';

interface PaymentValues {
  amount: string;
  receivedAt: Dayjs;
  externalId?: string;
  comment?: string;
}

/**
 * Оплаты счёта `[ТЗ 3.4.1]` (ADR-019).
 *
 * Статус счёта — «оплачен частично», «оплачен» — выводит сервер из суммы
 * распределённых платежей; здесь его не присваивают. Поступление ручное:
 * подключение к учётной системе заказчика не включено (`INTEGRATIONS.md`).
 */
export function InvoicePayments({ invoice }: { invoice: InvoiceRow }): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<PaymentValues>();
  const [open, setOpen] = useState(false);
  const payments = usePayments({ invoiceId: invoice.id });
  const register = useRegisterPayment();
  const payable = invoice.status !== 'draft' && invoice.status !== 'voided';
  const currency = invoice.totals.grandTotal.currency;

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const amount = { amount: values.amount, currency };
    try {
      await register.mutateAsync({
        clientId: invoice.clientId,
        amount,
        receivedAt: values.receivedAt.toISOString(),
        allocations: [{ invoiceId: invoice.id, amount }],
        ...(values.externalId ? { externalId: values.externalId } : {}),
        ...(values.comment ? { comment: values.comment } : {}),
      });
      void message.success(t('payment.registered'));
      form.resetFields();
      setOpen(false);
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  const columns: DataColumns<PaymentRow> = [
    {
      title: t('payment.receivedAt'), dataIndex: 'receivedAt', width: 130,
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('payment.allocated'), key: 'allocated', width: 160, align: 'right',
      render: (_, row) => (
        <MoneyText
          value={row.allocations.find((item) => item.invoiceId === invoice.id)?.amount ?? null}
          strong
        />
      ),
    },
    {
      title: t('payment.amount'), key: 'amount', width: 160, align: 'right',
      render: (_, row) => <MoneyText value={row.amount} />,
    },
    {
      title: t('payment.source'), dataIndex: 'source', width: 120,
      render: (value: string) => <Tag>{t(`payment.sourceKind.${value}`)}</Tag>,
    },
    {
      title: t('payment.externalId'), dataIndex: 'externalId', width: 160,
      render: (value: string) => (value ? <Mono>{value}</Mono> : '—'),
    },
    { title: t('payment.comment'), dataIndex: 'comment', ellipsis: true },
  ];

  return (
    <Card
      size="small"
      title={t('payment.title')}
      extra={
        payable ? (
          <Can permission="billing.documents.edit">
            <Button size="small" type="primary" onClick={() => { setOpen(true); }}>
              {t('payment.register')}
            </Button>
          </Can>
        ) : null
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Typography.Text type="secondary">{t('payment.paid')}:</Typography.Text>
          <MoneyText value={invoice.paidAmount} strong />
          <Typography.Text type="secondary">{t('payment.of')}</Typography.Text>
          <MoneyText value={invoice.totals.grandTotal} />
        </Space>
        <QueryState query={payments} skeletonRows={2}>
          {(paged) => (
            <DataTable<PaymentRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={false} scroll={{ x: 820 }}
              locale={{ emptyText: <EmptyState description={t('payment.none')} /> }}
            />
          )}
        </QueryState>
      </Space>

      <Modal
        open={open}
        title={t('payment.register')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={register.isPending}
        onCancel={() => { setOpen(false); }}
        onOk={() => { void submit(); }}
        destroyOnClose
      >
        <Form<PaymentValues> form={form} layout="vertical" requiredMark preserve={false}>
          <Form.Item
            name="amount"
            label={t('payment.amount')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <InputNumber<string> stringMode min="0.01" precision={2} addonAfter={currency} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="receivedAt"
            label={t('payment.receivedAt')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <DateTimePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="externalId" label={t('payment.externalId')} extra={t('payment.externalIdHint')}>
            <Input />
          </Form.Item>
          <Form.Item name="comment" label={t('payment.comment')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
