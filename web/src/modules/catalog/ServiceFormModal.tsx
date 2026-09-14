import { useState, type JSX } from 'react';
import {
  Alert, App, Col, Form, Input, InputNumber, Modal, Row, Select, Switch, Typography,
} from 'antd';
import { useTranslation } from 'react-i18next';

import { useCreateService, type CreateServiceInput } from '@/api/catalog';
import type { ServiceCategory } from '@/api/types';
import { applyApiError } from '@/shared/ui/form-errors';

const CATEGORIES: ServiceCategory[] = [
  'fuel',
  'handling',
  'catering',
  'transport',
  'permits',
  'deicing',
];

const UNITS = ['L', 'kg', 'ea', 'hour', 'pax', 'flight'] as const;

interface FormValues {
  code: string;
  category: ServiceCategory;
  nameRu: string;
  nameEn: string;
  unit: string;
  leadTimeH: number;
  requiresWeather: boolean;
  requiresActToComplete: boolean;
}

/**
 * Добавление позиции в каталог услуг `[ТЗ 3.2.1]`.
 *
 * Категории строго по ТЗ 3.2.1: седьмой без изменения ТЗ быть не может,
 * поэтому список закрыт, а не вводится текстом.
 *
 * Наименование двумя полями (ADR-031): справочник редактирует администратор,
 * а не переводчик, и оба языка нужны сразу — иначе английский интерфейс
 * покажет русское название услуги.
 */
export function ServiceFormModal({
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
  const createService = useCreateService();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const payload: CreateServiceInput = {
      code: values.code.trim().toUpperCase(),
      category: values.category,
      name: { ru: values.nameRu.trim(), en: values.nameEn.trim() },
      unit: values.unit,
      leadTimeH: values.leadTimeH,
      requiresWeather: values.requiresWeather,
      requiresActToComplete: values.requiresActToComplete,
      requiredAttributes: [],
    };

    try {
      const created = await createService.mutateAsync(payload);
      void message.success(t('catalog.serviceCreated', { code: created.code }));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={640}
      title={t('catalog.addService')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createService.isPending}
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
          <Col xs={24} sm={10}>
            <Form.Item
              name="code"
              label={t('catalog.code')}
              tooltip={t('catalog.codeHint')}
              rules={[{ required: true }]}
              normalize={(value: string) => value.toUpperCase()}
            >
              <Input autoFocus placeholder="FUEL-JETA1" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={14}>
            <Form.Item
              name="category"
              label={t('service.category')}
              rules={[{ required: true }]}
            >
              <Select
                options={CATEGORIES.map((code) => ({
                  value: code,
                  label: t(`serviceCategory.${code}`),
                }))}
              />
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
          <Col xs={12} sm={8}>
            <Form.Item name="unit" label={t('catalog.unit')} rules={[{ required: true }]}>
              <Select
                options={UNITS.map((unit) => ({
                  value: unit,
                  label: t(`serviceUnit.${unit}`),
                }))}
              />
            </Form.Item>
          </Col>
          <Col xs={12} sm={8}>
            <Form.Item
              name="leadTimeH"
              label={t('catalog.leadTime')}
              tooltip={t('catalog.leadTimeHint')}
              initialValue={4}
              rules={[{ required: true, type: 'number', min: 0 }]}
            >
              <InputNumber min={0} max={720} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="requiresWeather"
          label={t('catalog.requiresWeather')}
          tooltip={t('catalog.requiresWeatherHint')}
          valuePropName="checked"
          initialValue={false}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="requiresActToComplete"
          label={t('catalog.requiresAct')}
          tooltip={t('catalog.requiresActHint')}
          valuePropName="checked"
          initialValue={false}
        >
          <Switch />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('catalog.attributesLater')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
