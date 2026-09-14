import { useState, type JSX } from 'react';
import { Alert, App, Col, Form, Input, InputNumber, Modal, Row, Select, Switch } from 'antd';
import { useTranslation } from 'react-i18next';

import { useCreateAirport, type CreateAirportInput } from '@/api/catalog';
import { applyApiError } from '@/shared/ui/form-errors';

/**
 * Часовые пояса для выбора.
 *
 * Список берётся у браузера: `Intl.supportedValuesOf` отдаёт зоны IANA
 * той же базы, по которой считает сервер. Держать собственный перечень
 * значило бы поддерживать его вручную при каждом переносе границ зон.
 */
function timezoneOptions(): { value: string; label: string }[] {
  const zones =
    'supportedValuesOf' in Intl
      ? (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf(
          'timeZone',
        )
      : ['UTC', 'Europe/Moscow'];
  return zones.map((zone) => ({ value: zone, label: zone }));
}

interface FormValues {
  icao: string;
  iata?: string;
  nameRu: string;
  nameEn: string;
  cityRu?: string;
  cityEn?: string;
  country: string;
  timezone: string;
  lat: number;
  lon: number;
  elevationFt: number;
  isCoordinated: boolean;
}

/**
 * Добавление аэропорта в справочник.
 *
 * `CLAUDE.md § 4`: справочник наполняется из открытых источников
 * (OurAirports, общественное достояние), и это **реальные** данные.
 * Ручной ввод нужен для площадки, которой в выгрузке нет: частный
 * аэродром, временный пункт. Запись получает `dataSource: user`
 * и отличима от выгрузки.
 */
export function AirportFormModal({
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
  const createAirport = useCreateAirport();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const payload: CreateAirportInput = {
      icao: values.icao.toUpperCase(),
      iata: (values.iata ?? '').toUpperCase(),
      name: { ru: values.nameRu.trim(), en: values.nameEn.trim() },
      city: { ru: values.cityRu?.trim() ?? '', en: values.cityEn?.trim() ?? '' },
      country: values.country.toUpperCase(),
      timezone: values.timezone,
      lat: values.lat,
      lon: values.lon,
      elevationFt: values.elevationFt,
      isCoordinated: values.isCoordinated,
    };

    try {
      const created = await createAirport.mutateAsync(payload);
      void message.success(t('airport.created', { icao: created.icao }));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={680}
      title={t('airport.add')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createAirport.isPending}
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
          message={t('airport.manualEntryNotice')}
          style={{ marginBottom: 12 }}
        />

        {banner ? (
          <Alert type="error" showIcon message={banner} style={{ marginBottom: 12 }} />
        ) : null}

        <Row gutter={12}>
          <Col xs={8} sm={5}>
            <Form.Item
              name="icao"
              label="ICAO"
              rules={[{ required: true, len: 4, message: t('airport.icaoHint') }]}
              normalize={(value: string) => value.toUpperCase()}
            >
              <Input autoFocus maxLength={4} />
            </Form.Item>
          </Col>
          <Col xs={8} sm={5}>
            <Form.Item
              name="iata"
              label="IATA"
              rules={[{ len: 3, message: t('airport.iataHint') }]}
              normalize={(value: string) => value.toUpperCase()}
            >
              <Input maxLength={3} />
            </Form.Item>
          </Col>
          <Col xs={8} sm={5}>
            <Form.Item
              name="country"
              label={t('airport.country')}
              rules={[{ required: true, len: 2, message: t('client.countryHint') }]}
              normalize={(value: string) => value.toUpperCase()}
              initialValue="RU"
            >
              <Input maxLength={2} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={9}>
            <Form.Item
              name="timezone"
              label={t('airport.timezone')}
              tooltip={t('airport.timezoneHint')}
              rules={[{ required: true }]}
              initialValue="Europe/Moscow"
            >
              <Select showSearch optionFilterProp="label" options={timezoneOptions()} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="nameRu" label={t('catalog.nameRu')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="nameEn" label={t('catalog.nameEn')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="cityRu" label={t('airport.cityRu')}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="cityEn" label={t('airport.cityEn')}>
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={12} sm={7}>
            <Form.Item
              name="lat"
              label={t('airport.lat')}
              rules={[{ required: true, type: 'number', min: -90, max: 90 }]}
            >
              <InputNumber precision={6} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={7}>
            <Form.Item
              name="lon"
              label={t('airport.lon')}
              rules={[{ required: true, type: 'number', min: -180, max: 180 }]}
            >
              <InputNumber precision={6} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={5}>
            <Form.Item name="elevationFt" label={t('airport.elevation')} initialValue={0}>
              <InputNumber style={{ width: '100%' }} addonAfter="ft" />
            </Form.Item>
          </Col>
          <Col xs={12} sm={5}>
            <Form.Item
              name="isCoordinated"
              label={t('airport.coordinated')}
              tooltip={t('airport.coordinatedHint')}
              valuePropName="checked"
              initialValue={false}
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
