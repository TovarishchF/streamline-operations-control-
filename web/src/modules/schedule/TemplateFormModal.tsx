import { useState, type JSX } from 'react';
import { Alert, App, Col, Form, Input, Modal, Row, Select, TimePicker, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { useAircraftTypes, useServices } from '@/api/catalog';
import { useClients } from '@/api/counterparties';
import { useCreateTemplate } from '@/api/flights';
import { applyApiError } from '@/shared/ui/form-errors';

/** Дни недели по ISO: 1 — понедельник, 7 — воскресенье. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

interface FormValues {
  name: string;
  clientId: string;
  aircraftTypeId: string;
  depIcao: string;
  arrIcao: string;
  depTime: Dayjs;
  weekdays: number[];
  serviceIds?: string[];
}

/**
 * Заведение шаблона регулярного рейса `[ТЗ 3.1.1]` (`SPEC.md § 4.5`).
 *
 * Время вылета задаётся **местным** временем аэропорта вылета: диспетчер
 * договаривается о слоте в местном времени. Перевод в UTC делается при
 * генерации серии, на каждую дату отдельно — иначе расписание ломалось бы
 * дважды в год на переходе летнего времени.
 *
 * Услуги по умолчанию заводятся сразу: шаблон без них сгенерирует серию
 * пустых рейсов, и услуги придётся добавлять к каждому руками — ровно та
 * работа, ради устранения которой шаблон и нужен.
 */
export function TemplateFormModal({
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

  const createTemplate = useCreateTemplate();
  const clients = useClients();
  const types = useAircraftTypes();
  const services = useServices();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    try {
      await createTemplate.mutateAsync({
        name: values.name.trim(),
        clientId: values.clientId,
        aircraftTypeId: values.aircraftTypeId,
        depIcao: values.depIcao.toUpperCase(),
        arrIcao: values.arrIcao.toUpperCase(),
        // Время уходит как есть: это местное время аэропорта вылета,
        // и переводить его здесь было бы ошибкой.
        depTimeLocal: values.depTime.format('HH:mm'),
        weekdays: values.weekdays,
        defaultServices: (values.serviceIds ?? []).map((serviceId) => ({
          serviceId,
          leg: 'departure' as const,
          attributes: {},
        })),
      });
      void message.success(t('template.created'));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={640}
      title={t('template.create')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createTemplate.isPending}
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

        <Form.Item name="name" label={t('template.name')} rules={[{ required: true }]}>
          <Input autoFocus placeholder="Москва — Петербург, будни" />
        </Form.Item>

        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="clientId" label={t('flight.client')} rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                loading={clients.isLoading}
                options={(clients.data?.data ?? []).map((client) => ({
                  value: client.id,
                  label: client.name,
                }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="aircraftTypeId"
              label={t('template.aircraftType')}
              rules={[{ required: true }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                loading={types.isLoading}
                options={(types.data?.data ?? []).map((type) => ({
                  value: type.id,
                  label: `${type.icaoType} · ${type.name.ru}`,
                }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col xs={12} sm={8}>
            <Form.Item
              name="depIcao"
              label={t('flight.departure')}
              rules={[{ required: true, pattern: /^[A-Za-z]{4}$/ }]}
              normalize={(value: string) => value.toUpperCase()}
            >
              <Input placeholder="UUWW" maxLength={4} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={8}>
            <Form.Item
              name="arrIcao"
              label={t('flight.arrival')}
              rules={[{ required: true, pattern: /^[A-Za-z]{4}$/ }]}
              normalize={(value: string) => value.toUpperCase()}
            >
              <Input placeholder="ULLI" maxLength={4} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              name="depTime"
              label={t('template.depTimeLocal')}
              tooltip={t('template.depTimeLocalHint')}
              initialValue={dayjs('09:00', 'HH:mm')}
              rules={[{ required: true }]}
            >
              <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="weekdays"
          label={t('template.weekdays')}
          rules={[{ required: true, type: 'array', min: 1 }]}
        >
          <Select
            mode="multiple"
            options={WEEKDAYS.map((day, index) => ({
              value: day,
              label: t(`weekday.${WEEKDAY_KEYS[index] ?? 'mon'}`),
            }))}
          />
        </Form.Item>

        <Form.Item
          name="serviceIds"
          label={t('template.defaultServices')}
          tooltip={t('template.defaultServicesHint')}
        >
          <Select
            mode="multiple"
            showSearch
            optionFilterProp="label"
            loading={services.isLoading}
            options={(services.data?.data ?? []).map((service) => ({
              value: service.id,
              label: `${service.code} · ${service.name.ru}`,
            }))}
          />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('template.editHint')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
