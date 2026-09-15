import { useState, type JSX } from 'react';
import { Alert, App, Form, Modal, Select, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useApplyInbox, type InboxMessageRow } from '@/api/comms';
import { useServiceOrders } from '@/api/orders';
import { applyApiError } from '@/shared/ui/form-errors';
import { Mono } from '@/shared/ui/primitives';

/** Переходы заявки, которые может принести письмо поставщика. */
const TRANSITIONS = ['confirm', 'reject'] as const;

interface FormValues {
  serviceOrderId: string;
  transition: (typeof TRANSITIONS)[number];
}

/**
 * Ручной разбор входящего `[ТЗ 3.2.2]` (`SPEC.md § 8.3`).
 *
 * Открывается для письма, которое система не опознала. Это штатный
 * сценарий, а не устранение сбоя: полностью автоматического разбора
 * не будет (`INTEGRATIONS.md § 3.3`), и диспетчер указывает заявку
 * и действие сам.
 */
export function ApplyInboxModal({
  message,
  onClose,
}: {
  message: InboxMessageRow | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message: toast } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);

  const applyInbox = useApplyInbox();
  // Подтверждать и отклонять можно только заказанные заявки: список
  // ограничен ими, чтобы диспетчер не выбирал заведомо невозможное.
  const orders = useServiceOrders({ status: 'ordered' });

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    try {
      await applyInbox.mutateAsync({
        id: message?.id ?? '',
        serviceOrderId: values.serviceOrderId,
        transition: values.transition,
      });
      void toast.success(t('comms.applied'));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('comms.applyFailed')));
    }
  };

  return (
    <Modal
      open={message !== null}
      width={600}
      title={t('comms.processManually')}
      okText={t('comms.apply')}
      cancelText={t('common.cancel')}
      confirmLoading={applyInbox.isPending}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      {message ? (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t('comms.manualHint')}
          </Typography.Paragraph>

          <Typography.Paragraph>
            <Mono>{message.from}</Mono>
            <br />
            <Typography.Text strong>{message.subject}</Typography.Text>
          </Typography.Paragraph>

          <Form<FormValues> form={form} layout="vertical" requiredMark preserve={false}>
            {banner ? (
              <Alert type="error" showIcon message={banner} style={{ marginBottom: 12 }} />
            ) : null}

            <Form.Item
              name="serviceOrderId"
              label={t('comms.serviceOrder')}
              rules={[{ required: true }]}
            >
              <Select
                autoFocus
                showSearch
                optionFilterProp="label"
                loading={orders.isLoading}
                options={(orders.data?.data ?? []).map((order) => ({
                  value: order.id,
                  label: `${order.service?.name.ru ?? order.serviceId} · ${order.airportIcao}${
                    order.vendorName ? ` · ${order.vendorName}` : ''
                  }`,
                }))}
              />
            </Form.Item>

            <Form.Item
              name="transition"
              label={t('comms.action')}
              rules={[{ required: true }]}
            >
              <Select
                options={TRANSITIONS.map((value) => ({
                  value,
                  label: t(`inboxAction.${value}`),
                }))}
              />
            </Form.Item>
          </Form>
        </>
      ) : null}
    </Modal>
  );
}
