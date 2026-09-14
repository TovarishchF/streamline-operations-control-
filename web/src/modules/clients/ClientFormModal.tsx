import { useState, type JSX } from 'react';
import { Alert, App, Col, Form, Input, InputNumber, Modal, Row, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { useCreateClient, type CreateClientInput } from '@/api/counterparties';
import type { CurrencyCode } from '@/api/types';
import { CURRENCIES, ContactsEditor, PaymentTermsFields } from '@/modules/counterparties/CounterpartyFields';
import { applyApiError } from '@/shared/ui/form-errors';

interface FormValues {
  name: string;
  legalName: string;
  country: string;
  settlementCurrency: CurrencyCode;
  defaultLocale: 'ru' | 'en';
  paymentTerms: { mode: string; deferDays?: number; prepaymentPercent?: number };
  creditLimitAmount?: number;
  creditLimitCurrency?: CurrencyCode;
  contacts?: { name: string; email: string; role?: string; locale: 'ru' | 'en' }[];
}

/**
 * Заведение клиента `[ТЗ 3.3]`.
 *
 * Кредитный лимит вводится числом, а на сервер уходит строкой с четырьмя
 * знаками (`CLAUDE.md § 3` п. 1): `InputNumber` — это способ ввода,
 * а не способ хранения денег.
 */
export function ClientFormModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);
  const createClient = useCreateClient();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const limit =
      values.creditLimitAmount === undefined
        ? null
        : {
            amount: values.creditLimitAmount.toFixed(4),
            currency: values.creditLimitCurrency ?? values.settlementCurrency,
          };

    const payload: CreateClientInput = {
      name: values.name.trim(),
      legalName: values.legalName.trim(),
      country: values.country,
      settlementCurrency: values.settlementCurrency,
      defaultLocale: values.defaultLocale,
      paymentTerms: {
        mode: values.paymentTerms.mode as 'prepayment' | 'postpayment' | 'deferred',
        deferDays: values.paymentTerms.deferDays ?? 0,
        ...(values.paymentTerms.prepaymentPercent !== undefined
          ? { prepaymentPercent: values.paymentTerms.prepaymentPercent.toFixed(4) }
          : {}),
      },
      contacts: (values.contacts ?? []).map((contact, index) => ({
        name: contact.name,
        email: contact.email,
        role: contact.role ?? '',
        locale: contact.locale,
        isPrimary: index === 0,
      })),
      creditLimit: limit,
    };

    try {
      const created = await createClient.mutateAsync(payload);
      void message.success(t('client.created', { name: created.name }));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={720}
      title={t('client.add')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createClient.isPending}
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
          <Col xs={24} sm={12}>
            <Form.Item name="name" label={t('client.name')} rules={[{ required: true }]}>
              <Input autoFocus placeholder={t('client.namePlaceholder')} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="legalName"
              label={t('client.legalName')}
              rules={[{ required: true }]}
            >
              <Input placeholder={t('client.legalNamePlaceholder')} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={12} sm={6}>
            <Form.Item
              name="country"
              label={t('client.country')}
              rules={[{ required: true, len: 2, message: t('client.countryHint') }]}
              normalize={(value: string) => value.toUpperCase()}
              initialValue="RU"
            >
              <Input maxLength={2} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6}>
            <Form.Item
              name="settlementCurrency"
              label={t('client.currency')}
              rules={[{ required: true }]}
              initialValue="RUB"
            >
              <Select options={CURRENCIES.map((code) => ({ value: code, label: code }))} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6}>
            <Form.Item
              name="defaultLocale"
              label={t('client.locale')}
              initialValue="ru"
              tooltip={t('client.localeHint')}
            >
              <Select
                options={[
                  { value: 'ru', label: 'ru' },
                  { value: 'en', label: 'en' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>

        <PaymentTermsFields namePrefix="paymentTerms" />

        <Row gutter={12}>
          <Col xs={16} sm={10}>
            <Form.Item name="creditLimitAmount" label={t('client.creditLimit')}>
              <InputNumber min={0} style={{ width: '100%' }} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={8} sm={6}>
            <Form.Item
              name="creditLimitCurrency"
              label={t('client.creditLimitCurrency')}
              initialValue="RUB"
            >
              <Select options={CURRENCIES.map((code) => ({ value: code, label: code }))} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label={t('counterparty.contacts')}>
          <ContactsEditor />
        </Form.Item>
      </Form>
    </Modal>
  );
}
