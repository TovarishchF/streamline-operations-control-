import { useState, type JSX } from 'react';
import { Alert, App, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useFleet } from '@/api/fleet';
import {
  conflictsFromError,
  useUpdateFlight,
  type Flight,
  type FlightUpdateInput,
} from '@/api/flights';
import { AirportSelect } from '@/shared/ui/AirportSelect';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';

dayjs.extend(utc);

interface FormValues {
  aircraftId: string | null;
  depIcao: string;
  arrIcao: string;
  std: Dayjs;
  sta: Dayjs;
  paxCount: number;
  remarks: string;
}

/**
 * Изменение рейса `[ТЗ 3.1.3]` (`SPEC.md § 4.1`).
 *
 * Тот же сценарий, что у переноса полосы на планшете: сервер проверяет
 * конфликты, новый конфликт сохраняется только с причиной (409
 * `SCHEDULE_CONFLICT`), изменение уходит в аудит и письмами клиенту
 * и поставщикам. На сервер отправляются только изменённые поля: правка
 * примечания не должна переспрашивать о конфликте, которого она не создаёт.
 */
export function FlightEditModal({
  flight,
  open,
  onClose,
}: {
  flight: Flight;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const update = useUpdateFlight(flight.id);
  const fleet = useFleet().data?.data ?? [];
  const [conflicts, setConflicts] = useState<{ kind: string; message: string }[]>([]);
  const [reason, setReason] = useState('');
  // Вылетевший рейс уже случился: время, маршрут и борт не переносятся.
  const departed = flight.status === 'in_flight' || flight.status === 'arrived';

  const close = (): void => {
    setConflicts([]);
    setReason('');
    onClose();
  };

  const changes = (values: FormValues): FlightUpdateInput => {
    const patch: FlightUpdateInput = {};
    if (values.aircraftId !== flight.aircraftId) patch.aircraftId = values.aircraftId;
    if (values.depIcao !== flight.depIcao) patch.depIcao = values.depIcao;
    if (values.arrIcao !== flight.arrIcao) patch.arrIcao = values.arrIcao;
    const std = values.std.toISOString();
    const sta = values.sta.toISOString();
    if (std !== new Date(flight.stdUtc).toISOString()) patch.stdUtc = std;
    if (sta !== new Date(flight.staUtc).toISOString()) patch.staUtc = sta;
    if (values.paxCount !== flight.paxCount) patch.paxCount = values.paxCount;
    if (values.remarks !== flight.remarks) patch.remarks = values.remarks;
    return patch;
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const patch = changes(values);
    if (Object.keys(patch).length === 0) {
      close();
      return;
    }
    if (conflicts.length > 0) patch.conflictOverrideReason = reason.trim();
    try {
      await update.mutateAsync(patch);
      void message.success(t('flight.updated', { number: flight.number }));
      close();
    } catch (error) {
      const found = conflictsFromError(error);
      if (found.length > 0) {
        setConflicts(found);
        return;
      }
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  return (
    <Modal
      open={open}
      width="min(720px, calc(100vw - 32px))"
      title={t('flight.edit', { number: flight.number })}
      okText={conflicts.length > 0 ? t('schedule.conflictConfirm') : t('common.save')}
      okButtonProps={{ disabled: conflicts.length > 0 && reason.trim() === '' }}
      cancelText={t('common.cancel')}
      confirmLoading={update.isPending}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{
          aircraftId: flight.aircraftId,
          depIcao: flight.depIcao,
          arrIcao: flight.arrIcao,
          std: dayjs.utc(flight.stdUtc),
          sta: dayjs.utc(flight.staUtc),
          paxCount: flight.paxCount,
          remarks: flight.remarks,
        }}
        onValuesChange={() => {
          // Изменили форму — прежний ответ о конфликтах больше не про неё.
          if (conflicts.length > 0) setConflicts([]);
        }}
      >
        <Row gutter={12}>
          <Col xs={24} md={12}>
            <Form.Item name="depIcao" label={t('flight.departure')} rules={[{ required: true }]}>
              <AirportSelect aria-label={t('flight.departure')} disabled={departed} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="arrIcao"
              label={t('flight.arrival')}
              rules={[
                { required: true },
                {
                  validator: (_, value: string | undefined) =>
                    value && value === form.getFieldValue('depIcao')
                      ? Promise.reject(new Error(t('flight.sameAirport')))
                      : Promise.resolve(),
                },
              ]}
            >
              <AirportSelect aria-label={t('flight.arrival')} disabled={departed} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="std"
              label={t('flight.std')}
              rules={[{ required: true }]}
              extra={t('flight.stdMoveHint')}
            >
              <DateTimePicker style={{ width: '100%' }} disabled={departed} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="sta"
              label={t('flight.sta')}
              rules={[
                { required: true },
                {
                  validator: (_, value: Dayjs | undefined) => {
                    const std = form.getFieldValue('std') as Dayjs | undefined;
                    return value && std && !value.isAfter(std)
                      ? Promise.reject(new Error(t('flight.arrivalBeforeDeparture')))
                      : Promise.resolve();
                  },
                },
              ]}
            >
              <DateTimePicker style={{ width: '100%' }} disabled={departed} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="aircraftId" label={t('flight.aircraft')}>
              <Select
                allowClear
                disabled={departed}
                showSearch
                optionFilterProp="label"
                options={fleet.map((aircraft) => ({
                  value: aircraft.id,
                  label: `${aircraft.registration} — ${aircraft.type?.icaoType ?? ''}${
                    aircraft.status === 'serviceable' ? '' : ` (${t(`aircraftStatus.${aircraft.status}`)})`
                  }`,
                }))}
                onClear={() => {
                  form.setFieldValue('aircraftId', null);
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="paxCount" label={t('flight.pax')}>
              <InputNumber min={0} max={500} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="remarks" label={t('flight.remarks')}>
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>

      {conflicts.length > 0 ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message={t('schedule.conflictConfirmHint')}
            description={
              <Space direction="vertical" size={2}>
                {conflicts.map((conflict) => (
                  <span key={`${conflict.kind}:${conflict.message}`}>
                    <Tag style={{ margin: 0, marginInlineEnd: 6 }}>{t(`conflictKind.${conflict.kind}`)}</Tag>
                    {conflict.message}
                  </span>
                ))}
              </Space>
            }
          />
          <Input.TextArea
            rows={2}
            value={reason}
            placeholder={t('schedule.conflictReason')}
            aria-label={t('schedule.conflictReason')}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Space>
      ) : null}
    </Modal>
  );
}
