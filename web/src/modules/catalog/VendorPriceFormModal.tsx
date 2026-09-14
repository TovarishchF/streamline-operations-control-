import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Col, Form, InputNumber, Modal, Row, Select, Space, Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import {
  useAirports,
  useCreateVendorPrice,
  useServices,
  type CreateVendorPriceInput,
} from '@/api/catalog';
import { useVendors } from '@/api/counterparties';
import type { CurrencyCode } from '@/api/types';
import { CURRENCIES } from '@/modules/counterparties/CounterpartyFields';
import { DateOnlyPicker } from '@/shared/ui/DateTimePicker';
import { applyApiError } from '@/shared/ui/form-errors';

const SURCHARGE_CODES = ['night', 'weekend', 'holiday', 'urgent', 'into_plane'] as const;

interface FormValues {
  vendorId: string;
  serviceId: string;
  airportIcao: string;
  amount: number;
  currency: CurrencyCode;
  minCharge?: number;
  validFrom: Dayjs;
  validTo: Dayjs;
  surcharges?: { code: string; kind: 'percent' | 'fixed'; value: number }[];
}

/**
 * Запрос цены поставщика и её занесение в прайс `[ТЗ 3.2.1]`.
 *
 * Цена действует в периоде, и периоды по одной тройке (поставщик, услуга,
 * аэропорт) не пересекаются: иначе на дату оказания подходят две цены,
 * и выбор между ними произволен. Сервер откажет с внятным текстом, где
 * назовёт мешающий период.
 *
 * Изменения цены нет и не будет: новые условия — это новый период. Правка
 * задним числом переписала бы уже оформленные заявки, которые ссылаются
 * на снимок цены (`CLAUDE.md § 3` п. 5).
 */
export function VendorPriceFormModal({
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
  const [airportSearch, setAirportSearch] = useState('');

  const vendors = useVendors().data?.data ?? [];
  const services = useServices().data?.data ?? [];
  const airports = useAirports({ search: airportSearch, perPage: 30 }).data?.data ?? [];
  const createPrice = useCreateVendorPrice();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const payload: CreateVendorPriceInput = {
      vendorId: values.vendorId,
      serviceId: values.serviceId,
      airportIcao: values.airportIcao,
      // Деньги уходят строкой с четырьмя знаками: число с плавающей точкой
      // в денежных величинах запрещено на всех уровнях (`CLAUDE.md § 3` п. 1).
      price: { amount: values.amount.toFixed(4), currency: values.currency },
      minCharge:
        values.minCharge === undefined
          ? null
          : { amount: values.minCharge.toFixed(4), currency: values.currency },
      validFrom: values.validFrom.startOf('day').toISOString(),
      validTo: values.validTo.endOf('day').toISOString(),
      surcharges: (values.surcharges ?? []).map((surcharge) => ({
        code: surcharge.code as (typeof SURCHARGE_CODES)[number],
        kind: surcharge.kind,
        value: surcharge.value.toFixed(4),
      })),
    };

    try {
      await createPrice.mutateAsync(payload);
      void message.success(t('price.created'));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={700}
      title={t('price.add')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createPrice.isPending}
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
          <Col xs={24} sm={12}>
            <Form.Item name="serviceId" label={t('service.name')} rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                options={services.map((service) => ({
                  value: service.id,
                  label: `${service.name.ru} (${service.code})`,
                }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={24} sm={10}>
            <Form.Item
              name="airportIcao"
              label={t('price.airport')}
              rules={[{ required: true }]}
            >
              <Select
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
          <Col xs={12} sm={7}>
            <Form.Item name="validFrom" label={t('price.validFrom')} rules={[{ required: true }]}>
              <DateOnlyPicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={7}>
            <Form.Item
              name="validTo"
              label={t('price.validTo')}
              rules={[
                { required: true },
                {
                  // Валидатор Ant Design обязан вернуть Promise. Отказ
                  // оформляется через reject, а не через async без await:
                  // сравнение двух дат ничего не ждёт.
                  validator: (_, value: Dayjs | undefined) => {
                    const from = form.getFieldValue('validFrom') as Dayjs | undefined;
                    if (value && from && !value.isAfter(from)) {
                      return Promise.reject(new Error(t('price.validToBeforeFrom')));
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <DateOnlyPicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={12} sm={8}>
            <Form.Item
              name="amount"
              label={t('price.unitPrice')}
              rules={[{ required: true, type: 'number', min: 0 }]}
            >
              <InputNumber min={0} precision={4} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={6}>
            <Form.Item
              name="currency"
              label={t('client.currency')}
              rules={[{ required: true }]}
              initialValue="RUB"
            >
              <Select options={CURRENCIES.map((code) => ({ value: code, label: code }))} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={10}>
            <Form.Item
              name="minCharge"
              label={t('price.minCharge')}
              tooltip={t('price.minChargeHint')}
            >
              <InputNumber min={0} precision={4} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label={t('price.surcharges')} tooltip={t('price.surchargesHint')}>
          <Form.List name="surcharges">
            {(fields, { add, remove }) => (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {fields.map((field) => (
                  <Row key={field.key} gutter={8}>
                    <Col xs={10} sm={9}>
                      <Form.Item
                        name={[field.name, 'code']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Select
                          options={SURCHARGE_CODES.map((code) => ({
                            value: code,
                            label: t(`surcharge.${code}`),
                          }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={7} sm={7}>
                      <Form.Item
                        name={[field.name, 'kind']}
                        initialValue="percent"
                        style={{ marginBottom: 0 }}
                      >
                        <Select
                          options={[
                            { value: 'percent', label: t('price.kindPercent') },
                            { value: 'fixed', label: t('price.kindFixed') },
                          ]}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={5} sm={6}>
                      <Form.Item
                        name={[field.name, 'value']}
                        rules={[{ required: true, type: 'number', min: 0 }]}
                        style={{ marginBottom: 0 }}
                      >
                        <InputNumber min={0} precision={2} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={2} sm={2}>
                      <Button
                        icon={<DeleteOutlined />}
                        aria-label={t('common.remove')}
                        onClick={() => {
                          remove(field.name);
                        }}
                      />
                    </Col>
                  </Row>
                ))}
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    add({ kind: 'percent' });
                  }}
                >
                  {t('price.addSurcharge')}
                </Button>
              </Space>
            )}
          </Form.List>
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('price.snapshotNotice')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
