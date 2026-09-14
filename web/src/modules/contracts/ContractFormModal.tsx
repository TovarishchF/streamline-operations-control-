import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Col, Form, Input, Modal, Row, Select, Space, Typography, Upload,
} from 'antd';
import { DeleteOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { uploadAttachment, type AttachmentRef } from '@/api/attachments';
import { useCreateContract, useVendors, type CreateContractInput } from '@/api/counterparties';
import type { CurrencyCode } from '@/api/types';
import { CURRENCIES, PaymentTermsFields } from '@/modules/counterparties/CounterpartyFields';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';
import { applyApiError } from '@/shared/ui/form-errors';

interface FormValues {
  vendorId: string;
  number: string;
  validFrom: Dayjs;
  validTo: Dayjs;
  currency: CurrencyCode;
  paymentTerms: { mode: string; deferDays?: number; prepaymentPercent?: number };
}

/**
 * Заведение договора с поставщиком и загрузка скана `[ТЗ 3.3.3]`.
 *
 * Файл идёт из браузера **прямо в объектное хранилище** по подписанной
 * ссылке (ADR-007): сервер приложения байты через себя не пропускает.
 * К договору привязывается только подтверждённая загрузка — оборванная
 * не оставит ссылку в никуда.
 *
 * Загрузка выполняется до отправки формы, а не вместе с ней: иначе отказ
 * по номеру договора заставил бы человека грузить двадцать мегабайт заново.
 */
export function ContractFormModal({
  open,
  onClose,
  vendorId,
}: {
  open: boolean;
  onClose: () => void;
  vendorId?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(false);

  const vendors = useVendors().data?.data ?? [];
  const createContract = useCreateContract();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    setAttachments([]);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const payload: CreateContractInput = {
      vendorId: values.vendorId,
      number: values.number.trim(),
      validFrom: values.validFrom.toISOString(),
      validTo: values.validTo.toISOString(),
      currency: values.currency,
      paymentTerms: {
        mode: values.paymentTerms.mode as 'prepayment' | 'postpayment' | 'deferred',
        deferDays: values.paymentTerms.deferDays ?? 0,
        ...(values.paymentTerms.prepaymentPercent !== undefined
          ? { prepaymentPercent: values.paymentTerms.prepaymentPercent.toFixed(4) }
          : {}),
      },
      attachmentIds: attachments.map((item) => item.id),
    };

    try {
      const created = await createContract.mutateAsync(payload);
      void message.success(t('contract.created', { number: created.number }));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={680}
      title={t('contract.add')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createContract.isPending}
      okButtonProps={{ disabled: uploading }}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Form<FormValues> form={form} layout="vertical" requiredMark preserve={false}>
        {banner ? (
          <Alert type="error" showIcon message={banner} style={{ marginBottom: 12 }} />
        ) : null}

        <Row gutter={12}>
          <Col xs={24} sm={14}>
            <Form.Item
              name="vendorId"
              label={t('service.vendor')}
              rules={[{ required: true }]}
              initialValue={vendorId}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={10}>
            <Form.Item
              name="number"
              label={t('contract.number')}
              tooltip={t('contract.numberHint')}
              rules={[{ required: true }]}
            >
              <Input autoFocus />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={24} sm={9}>
            <Form.Item
              name="validFrom"
              label={t('contract.validFrom')}
              rules={[{ required: true }]}
            >
              <DateTimePicker />
            </Form.Item>
          </Col>
          <Col xs={24} sm={9}>
            <Form.Item
              name="validTo"
              label={t('contract.validTo')}
              rules={[
                { required: true },
                {
                  // Валидатор Ant Design обязан вернуть Promise. Отказ
                  // оформляется через reject, а не через async без await:
                  // сравнение двух дат ничего не ждёт.
                  validator: (_, value: Dayjs | undefined) => {
                    const from = form.getFieldValue('validFrom') as Dayjs | undefined;
                    if (value && from && !value.isAfter(from)) {
                      return Promise.reject(new Error(t('contract.validToBeforeFrom')));
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <DateTimePicker />
            </Form.Item>
          </Col>
          <Col xs={24} sm={6}>
            <Form.Item
              name="currency"
              label={t('contract.currency')}
              rules={[{ required: true }]}
              initialValue="RUB"
            >
              <Select options={CURRENCIES.map((code) => ({ value: code, label: code }))} />
            </Form.Item>
          </Col>
        </Row>

        <PaymentTermsFields namePrefix="paymentTerms" />

        <Form.Item label={t('contract.scan')} tooltip={t('contract.scanHint')}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Upload
              multiple
              showUploadList={false}
              accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv"
              // Загрузку ведём сами: файл идёт мимо сервера приложения,
              // прямо в хранилище по подписанной ссылке.
              customRequest={({ file, onSuccess, onError }) => {
                setUploading(true);
                uploadAttachment(file as File, 'contract')
                  .then((ref) => {
                    setAttachments((current) => [...current, ref]);
                    onSuccess?.(ref);
                  })
                  .catch((cause: unknown) => {
                    void message.error(
                      cause instanceof Error ? cause.message : t('contract.uploadFailed'),
                    );
                    onError?.(cause as Error);
                  })
                  .finally(() => {
                    setUploading(false);
                  });
              }}
            >
              <Button icon={<UploadOutlined />} loading={uploading}>
                {t('contract.uploadScan')}
              </Button>
            </Upload>

            {attachments.map((attachment) => (
              <Space key={attachment.id} size={6}>
                <PaperClipOutlined />
                <Typography.Text>{attachment.fileName}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {Math.round(attachment.sizeBytes / 1024)} {t('common.kilobytes')}
                </Typography.Text>
                <Button
                  size="small"
                  type="text"
                  icon={<DeleteOutlined />}
                  aria-label={t('common.remove')}
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    );
                  }}
                />
              </Space>
            ))}
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}
