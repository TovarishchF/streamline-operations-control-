import { useState, type JSX } from 'react';
import { Alert, App, Form, Modal, Select, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useCreateInvoice, useCreateQuote, useQuotes } from '@/api/documents';
import { useFlights } from '@/api/flights';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';
import { applyApiError } from '@/shared/ui/form-errors';

interface FormValues {
  flightId: string;
  quoteId?: string;
  validUntil?: Dayjs;
}

/**
 * Формирование котировки или счёта `[ТЗ 3.4.1]`.
 *
 * Документ собирает **сервер** из заявок рейса: котировку — из планируемых,
 * счёт — из фактически оказанных. Форма спрашивает только то, чего сервер
 * знать не может: по какому рейсу и, для счёта, с какой котировкой
 * сопоставлять.
 *
 * Строки, суммы и НДС не вводятся руками (`CLAUDE.md § 3` п. 16) — это
 * не форма счёта, а команда «собери счёт по рейсу».
 */
export function DocumentFormModal({
  kind,
  open,
  onClose,
  flightId,
}: {
  kind: 'quote' | 'invoice';
  open: boolean;
  onClose: () => void;
  flightId?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);
  const [selectedFlight, setSelectedFlight] = useState<string | undefined>(flightId);

  const flights = useFlights({}).data?.data ?? [];
  // Котировки по выбранному рейсу: счёт сопоставляется именно с ней,
  // и предлагать чужие незачем.
  const quotes = useQuotes({ flightId: selectedFlight ?? '' }).data?.data ?? [];

  const createQuote = useCreateQuote();
  const createInvoice = useCreateInvoice();
  const pending = createQuote.isPending || createInvoice.isPending;

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    try {
      if (kind === 'quote') {
        const quote = await createQuote.mutateAsync({
          flightId: values.flightId,
          ...(values.validUntil ? { validUntil: values.validUntil.toISOString() } : {}),
        });
        void message.success(t('finance.quoteCreated'));
        close();
        navigate(`/billing/quotes/${quote.id}`);
      } else {
        const invoice = await createInvoice.mutateAsync({
          flightId: values.flightId,
          ...(values.quoteId ? { quoteId: values.quoteId } : {}),
        });
        void message.success(t('finance.invoiceCreated'));
        close();
        navigate(`/billing/invoices/${invoice.id}`);
      }
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={600}
      title={kind === 'quote' ? t('finance.createQuote') : t('finance.createInvoice')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={pending}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Form<FormValues> form={form} layout="vertical" requiredMark preserve={false}>
        <Alert
          type="info"
          showIcon
          message={
            kind === 'quote' ? t('finance.quoteBuildHint') : t('finance.invoiceBuildHint')
          }
          style={{ marginBottom: 12 }}
        />

        {banner ? (
          <Alert type="error" showIcon message={banner} style={{ marginBottom: 12 }} />
        ) : null}

        <Form.Item
          name="flightId"
          label={t('finance.flight')}
          rules={[{ required: true }]}
          initialValue={flightId}
        >
          <Select
            showSearch
            optionFilterProp="label"
            onChange={setSelectedFlight}
            options={flights.map((flight) => ({
              value: flight.id,
              label: `${flight.number} · ${flight.depIcao}→${flight.arrIcao} · ${flight.clientName}`,
            }))}
          />
        </Form.Item>

        {kind === 'invoice' ? (
          <Form.Item
            name="quoteId"
            label={t('finance.basedOnQuote')}
            tooltip={t('finance.basedOnQuoteHint')}
          >
            <Select
              allowClear
              options={quotes.map((quote) => ({
                value: quote.id,
                label: `${quote.number ?? t('finance.draft')} · ${quote.totals.grandTotal.amount} ${quote.currency}`,
              }))}
            />
          </Form.Item>
        ) : (
          <Form.Item name="validUntil" label={t('finance.validUntil')}>
            <DateTimePicker style={{ width: '100%' }} />
          </Form.Item>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('finance.numberOnIssueHint')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
