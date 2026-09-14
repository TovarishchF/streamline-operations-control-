import { useState, type JSX } from 'react';
import { Alert, App, Col, Form, Input, Modal, Rate, Row, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { useAirports } from '@/api/catalog';
import { useCreateVendor, type CreateVendorInput } from '@/api/counterparties';
import type { CurrencyCode, ServiceCategory } from '@/api/types';
import {
  CURRENCIES,
  ContactsEditor,
  PaymentTermsFields,
} from '@/modules/counterparties/CounterpartyFields';
import { applyApiError } from '@/shared/ui/form-errors';

const SERVICE_CATEGORIES: ServiceCategory[] = [
  'fuel',
  'handling',
  'catering',
  'transport',
  'permits',
  'deicing',
];

const EXCHANGE_METHODS = ['portal', 'email', 'api'] as const;

interface FormValues {
  name: string;
  legalName: string;
  country: string;
  settlementCurrency: CurrencyCode;
  specializations: string[];
  coverageAirports?: string[];
  coverageRegions?: string;
  exchangeMethod: 'portal' | 'email' | 'api';
  manualQualityScore: number;
  paymentTerms: { mode: string; deferDays?: number; prepaymentPercent?: number };
  contacts?: { name: string; email: string; role?: string; locale: 'ru' | 'en' }[];
}

/**
 * Заведение поставщика `[ТЗ 3.3.1]`.
 *
 * География и специализации — это не украшение карточки: по ним идёт
 * подбор поставщика (`DOMAIN.md § 7.5`) и проверка доступности услуги
 * в аэропорту. Поставщик без специализации не попадёт ни в один подбор.
 */
export function VendorFormModal({
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
  const [airportSearch, setAirportSearch] = useState('');
  const createVendor = useCreateVendor();

  // Справочник ищется на сервере: в нём больше тысячи аэропортов,
  // и выкачивать его целиком ради выпадающего списка незачем.
  const airports = useAirports({ search: airportSearch, perPage: 30 }).data?.data ?? [];

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const payload: CreateVendorInput = {
      name: values.name.trim(),
      legalName: values.legalName.trim(),
      country: values.country,
      settlementCurrency: values.settlementCurrency,
      specializations: values.specializations,
      coverage: {
        airports: values.coverageAirports ?? [],
        regions: (values.coverageRegions ?? '')
          .split(',')
          .map((region) => region.trim())
          .filter(Boolean),
      },
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
      certificates: [],
      manualQualityScore: values.manualQualityScore,
      exchangeMethod: values.exchangeMethod,
    };

    try {
      const created = await createVendor.mutateAsync(payload);
      void message.success(t('vendor.created', { name: created.name }));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={720}
      title={t('vendor.add')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createVendor.isPending}
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
            <Form.Item name="name" label={t('vendor.name')} rules={[{ required: true }]}>
              <Input autoFocus />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="legalName"
              label={t('client.legalName')}
              rules={[{ required: true }]}
            >
              <Input />
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
          <Col xs={24} sm={12}>
            <Form.Item
              name="exchangeMethod"
              label={t('vendor.exchangeMethod')}
              tooltip={t('vendor.exchangeMethodHint')}
              initialValue="email"
            >
              <Select
                options={EXCHANGE_METHODS.map((method) => ({
                  value: method,
                  label: t(`vendor.exchangeMethod.${method}`),
                }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="specializations"
          label={t('vendor.specializations')}
          tooltip={t('vendor.specializationsHint')}
          rules={[{ required: true, type: 'array', min: 1 }]}
        >
          <Select
            mode="multiple"
            options={SERVICE_CATEGORIES.map((code) => ({
              value: code,
              label: t(`serviceCategory.${code}`),
            }))}
          />
        </Form.Item>

        <Row gutter={12}>
          <Col xs={24} sm={14}>
            <Form.Item
              name="coverageAirports"
              label={t('vendor.coverageAirports')}
              tooltip={t('vendor.coverageAirportsHint')}
            >
              <Select
                mode="multiple"
                showSearch
                filterOption={false}
                onSearch={setAirportSearch}
                options={airports.map((airport) => ({
                  value: airport.icao,
                  label: `${airport.icao} — ${airport.name.ru}`,
                }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={10}>
            <Form.Item
              name="coverageRegions"
              label={t('vendor.coverageRegions')}
              tooltip={t('vendor.coverageRegionsHint')}
            >
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <PaymentTermsFields namePrefix="paymentTerms" />

        <Form.Item
          name="manualQualityScore"
          label={t('vendor.manualScore')}
          tooltip={t('vendor.manualScoreHint')}
          initialValue={3}
        >
          <Rate count={5} />
        </Form.Item>

        <Form.Item label={t('counterparty.contacts')}>
          <ContactsEditor />
        </Form.Item>
      </Form>
    </Modal>
  );
}
