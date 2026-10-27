import type { JSX } from 'react';
import { App, Col, Form, InputNumber, Modal, Row, Select, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useServices } from '@/api/catalog';
import { useCreateTariff, type CreateTariffInput } from '@/api/counterparties';
import type { CurrencyCode, ServiceCategory } from '@/api/types';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { AirportSelect } from '@/shared/ui/AirportSelect';
import { DateOnlyPicker } from '@/shared/ui/DateTimePicker';

const CATEGORIES: ServiceCategory[] = [
  'fuel', 'handling', 'catering', 'transport', 'permits', 'deicing',
];

interface FormValues {
  serviceId?: string;
  category?: ServiceCategory;
  airportIcao?: string;
  mode: 'cost_plus' | 'fixed' | 'pass_through';
  markupPercent?: string;
  fixedAmount?: string;
  fixedCurrency?: CurrencyCode;
  discountKind?: 'percent' | 'fixed';
  discountValue?: string;
  validFrom: Dayjs;
  validTo: Dayjs;
}

/**
 * Новое тарифное правило клиента `[ТЗ 3.4.1]` (`DOMAIN.md § 7.2`).
 *
 * Правило не правится, а заменяется новым с другой датой начала:
 * цены в уже оформленных заявках зафиксированы снимком (ADR-022),
 * а история тарифа нужна, чтобы объяснить старую цену.
 * Проверку непротиворечивости делает сервер.
 */
export function TariffRuleModal({
  clientId,
  currency,
  open,
  onClose,
}: {
  clientId: string;
  currency: CurrencyCode;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const localized = useLocalizedName();
  const [form] = Form.useForm<FormValues>();
  const create = useCreateTariff(clientId);
  const services = useServices().data?.data ?? [];
  const mode = Form.useWatch('mode', form);
  const serviceId = Form.useWatch('serviceId', form);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const input: CreateTariffInput = {
      // Услуга точнее категории: при выбранной услуге категория не передаётся.
      scope: {
        serviceId: values.serviceId ?? null,
        category: values.serviceId ? null : (values.category ?? null),
        airportIcao: values.airportIcao ?? null,
      },
      pricing:
        values.mode === 'cost_plus'
          ? { mode: 'cost_plus', markupPercent: values.markupPercent ?? '0' }
          : values.mode === 'fixed'
            ? {
                mode: 'fixed',
                price: { amount: values.fixedAmount ?? '0', currency: values.fixedCurrency ?? currency },
              }
            : { mode: 'pass_through' },
      discount:
        values.discountKind && values.discountValue
          ? { kind: values.discountKind, value: values.discountValue }
          : null,
      validFrom: values.validFrom.startOf('day').toISOString(),
      validTo: values.validTo.endOf('day').toISOString(),
    };
    try {
      await create.mutateAsync(input);
      void message.success(t('tariff.created'));
      form.resetFields();
      onClose();
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  return (
    <Modal
      open={open}
      width="min(720px, calc(100vw - 32px))"
      title={t('tariff.add')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      onCancel={onClose}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('tariff.addHint')}
      </Typography.Paragraph>
      <Form<FormValues>
        form={form}
        layout="vertical"
        requiredMark
        preserve={false}
        initialValues={{ mode: 'cost_plus', fixedCurrency: currency }}
      >
        <Row gutter={12}>
          <Col xs={24} md={12}>
            <Form.Item name="serviceId" label={t('tariff.scopeService')} extra={t('tariff.scopeServiceHint')}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={services.map((service) => ({
                  value: service.id,
                  label: `${service.code} · ${localized(service.name)}`,
                }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="category" label={t('service.category')}>
              <Select
                allowClear
                disabled={Boolean(serviceId)}
                options={CATEGORIES.map((value) => ({ value, label: t(`serviceCategory.${value}`) }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="airportIcao" label={t('flight.airport')} extra={t('tariff.scopeAirportHint')}>
              <AirportSelect allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="mode" label={t('tariff.mode')} rules={[{ required: true }]}>
              <Select
                options={(['cost_plus', 'fixed', 'pass_through'] as const).map((value) => ({
                  value,
                  label: t(`tariffMode.${value}`),
                }))}
              />
            </Form.Item>
          </Col>
          {mode === 'cost_plus' ? (
            <Col xs={24} md={12}>
              <Form.Item
                name="markupPercent"
                label={t('tariff.markupPercent')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <InputNumber<string> stringMode min="0" precision={2} addonAfter="%" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          ) : null}
          {mode === 'fixed' ? (
            <>
              <Col xs={14} md={8}>
                <Form.Item
                  name="fixedAmount"
                  label={t('tariff.fixedPrice')}
                  rules={[{ required: true, message: t('common.required') }]}
                >
                  <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={10} md={4}>
                <Form.Item name="fixedCurrency" label={t('client.currency')}>
                  <Select options={(['RUB', 'USD', 'EUR'] as const).map((value) => ({ value, label: value }))} />
                </Form.Item>
              </Col>
            </>
          ) : null}
          <Col xs={12} md={6}>
            <Form.Item name="discountKind" label={t('tariff.discount')}>
              <Select
                allowClear
                options={[
                  { value: 'percent', label: '%' },
                  { value: 'fixed', label: currency },
                ]}
              />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="discountValue" label={t('tariff.discountValue')}>
              <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item
              name="validFrom"
              label={t('contract.validFrom')}
              rules={[{ required: true, message: t('common.required') }]}
            >
              <DateOnlyPicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item
              name="validTo"
              label={t('contract.validTo')}
              rules={[{ required: true, message: t('common.required') }]}
            >
              <DateOnlyPicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
