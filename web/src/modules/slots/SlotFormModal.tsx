import { useState, type JSX } from 'react';
import { Alert, App, DatePicker, Form, Modal, Select, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { useAirports } from '@/api/catalog';
import { useFlights } from '@/api/flights';
import { useCreateSlot, type SlotKind } from '@/api/slots';
import { applyApiError } from '@/shared/ui/form-errors';

interface FormValues {
  flightId: string;
  airportIcao: string;
  kind: SlotKind;
  requestedTime: Dayjs;
}

/**
 * Запрос слота `[ТЗ 3.1.1]` (ADR-026).
 *
 * Аэропорты предлагаются только координируемые: запрашивать слот там,
 * где координации нет, незачем, и список из всех площадок мира только
 * мешал бы искать.
 */
export function SlotFormModal({
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

  const createSlot = useCreateSlot();
  const flights = useFlights({});
  const airports = useAirports({ coordinatedOnly: true });

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    try {
      await createSlot.mutateAsync({
        flightId: values.flightId,
        airportIcao: values.airportIcao,
        kind: values.kind,
        // Время слота — в UTC, как и всё расписание аэропорта.
        requestedTimeUtc: values.requestedTime.toISOString(),
      });
      void message.success(t('slots.created'));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={560}
      title={t('slots.newRequest')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createSlot.isPending}
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

        <Form.Item name="flightId" label={t('flight.number')} rules={[{ required: true }]}>
          <Select
            autoFocus
            showSearch
            optionFilterProp="label"
            loading={flights.isLoading}
            options={(flights.data?.data ?? []).map((flight) => ({
              value: flight.id,
              label: `${flight.number} · ${flight.depIcao} → ${flight.arrIcao}`,
            }))}
          />
        </Form.Item>

        <Form.Item
          name="airportIcao"
          label={t('flight.airport')}
          tooltip={t('slots.coordinatedOnlyHint')}
          rules={[{ required: true }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            loading={airports.isLoading}
            options={(airports.data?.data ?? []).map((airport) => ({
              value: airport.icao,
              label: `${airport.icao} · ${airport.name.ru}`,
            }))}
            notFoundContent={
              <Typography.Text type="secondary">{t('slots.noCoordinated')}</Typography.Text>
            }
          />
        </Form.Item>

        <Form.Item
          name="kind"
          label={t('slots.kind')}
          initialValue="departure"
          rules={[{ required: true }]}
        >
          <Select
            options={(['departure', 'arrival'] as const).map((value) => ({
              value,
              label: t(`slotKind.${value}`),
            }))}
          />
        </Form.Item>

        <Form.Item
          name="requestedTime"
          label={t('slots.requested')}
          tooltip={t('slots.timeUtcHint')}
          rules={[{ required: true }]}
        >
          <DatePicker showTime={{ format: 'HH:mm' }} format="DD.MM.YYYY HH:mm" style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
