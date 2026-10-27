import { useEffect, useState, type JSX } from 'react';
import {
  Alert, App, Button, Col, Form, Input, InputNumber, Modal, Row, Space, Typography, Upload,
} from 'antd';
import { CameraOutlined, PaperClipOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import type { AttachmentRef } from '@/api/attachments';
import { ApiError } from '@/api/client';
import { uploadOrderDocument, useOrderTransition, type ServiceOrderRow } from '@/api/orders';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';

interface FinishValues {
  actualStart: Dayjs;
  actualEnd: Dayjs;
  actualQuantity: string;
  comment?: string;
}

/** Текст отказа сервера: перечень невыполненных условий точнее общего сообщения. */
export function transitionErrorText(error: unknown, fallback: string): string {
  const unmet =
    error instanceof ApiError && Array.isArray(error.details['unmetConditions'])
      ? (error.details['unmetConditions'] as { message: string }[])
          .map((item) => item.message)
          .join('; ')
      : '';
  return unmet || (error instanceof ApiError ? error.message : fallback);
}

/**
 * Завершение заявки `[ТЗ 3.2.3]`: фактические время и количество идут
 * в биллинг (ADR-020), а для услуг с обязательным актом сервер не пропустит
 * переход без загруженного документа.
 *
 * Один диалог для диспетчера и для портала поставщика: отметка исполнения
 * одна и та же, кто бы её ни ставил.
 */
export function FinishOrderModal({
  order,
  onClose,
}: {
  order: ServiceOrderRow | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const transition = useOrderTransition();
  const [form] = Form.useForm<FinishValues>();
  const [act, setAct] = useState<AttachmentRef | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setAct(null);
  }, [order?.id]);

  const close = (): void => {
    setAct(null);
    form.resetFields();
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (!order) return;
    const values = await form.validateFields();

    try {
      await transition.mutateAsync({
        id: order.id,
        transition: 'finish',
        actualStartAt: values.actualStart.toISOString(),
        actualEndAt: values.actualEnd.toISOString(),
        actualQuantity: values.actualQuantity,
        ...(values.comment ? { comment: values.comment } : {}),
      });
      void message.success(t('portal.vendor.finished'));
      close();
    } catch (error) {
      void message.error(transitionErrorText(error, t('service.transitionFailed')));
    }
  };

  return (
    <Modal
      open={order !== null}
      title={t('portal.vendor.finishTitle')}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={transition.isPending}
      okButtonProps={{ disabled: uploading }}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="info" showIcon message={t('portal.vendor.finishHint')} />
        <Form<FinishValues> form={form} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item
                name="actualStart"
                label={t('service.actualStart')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <DateTimePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="actualEnd"
                label={t('service.actualEnd')}
                rules={[
                  { required: true, message: t('common.required') },
                  {
                    validator: (_, value: Dayjs | undefined) => {
                      const start = form.getFieldValue('actualStart') as Dayjs | undefined;
                      if (value && start && value.isBefore(start)) {
                        return Promise.reject(new Error(t('service.endBeforeStart')));
                      }
                      return Promise.resolve();
                    },
                  },
                ]}
              >
                <DateTimePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          {/* Количество — строкой: десятичная дробь без потерь двоичной арифметики. */}
          <Form.Item
            name="actualQuantity"
            label={t('service.actualQuantity')}
            extra={t('service.actualQuantityHint')}
            rules={[{ required: true, message: t('common.required') }]}
            initialValue={order?.quantity ?? '1'}
          >
            <InputNumber<string> style={{ width: 200 }} min="0" precision={4} stringMode />
          </Form.Item>

          <Form.Item
            label={t('service.uploadAct')}
            required={order?.service?.requiresActToComplete ?? false}
            extra={order?.service?.requiresActToComplete ? t('service.actRequiredHint') : undefined}
          >
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Upload
                showUploadList={false}
                accept=".pdf,.jpg,.jpeg,.png"
                // Файл идёт прямо в хранилище по подписанной ссылке (ADR-007)
                // и сразу привязывается к заявке: акт, загруженный и не
                // привязанный, не откроет переход в «Выполнена».
                customRequest={({ file, onSuccess, onError }) => {
                  if (!order) return;
                  setUploading(true);
                  uploadOrderDocument(order.id, file as File, 'act')
                    .then((ref) => {
                      setAct(ref);
                      onSuccess?.(ref);
                    })
                    .catch((cause: unknown) => {
                      void message.error(transitionErrorText(cause, t('common.saveFailed')));
                      onError?.(cause as Error);
                    })
                    .finally(() => {
                      setUploading(false);
                    });
                }}
              >
                <Button icon={<CameraOutlined />} loading={uploading}>
                  {t('service.attachAct')}
                </Button>
              </Upload>
              {act ? (
                <Space size={6}>
                  <PaperClipOutlined />
                  <Typography.Text>{act.fileName}</Typography.Text>
                </Space>
              ) : null}
            </Space>
          </Form.Item>

          <Form.Item name="comment" label={t('portal.vendor.comment')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Space>
    </Modal>
  );
}
