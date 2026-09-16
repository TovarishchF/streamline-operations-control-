import { useState, type JSX } from 'react';
import { Alert, App, Form, Modal, Select, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useVendors } from '@/api/counterparties';
import { transitionFlight, type FlightRow } from '@/api/flights';
import { assignOrderVendor, fetchFlightOrders } from '@/api/orders';
import { Mono } from '@/shared/ui/primitives';

/** Переходы, которые имеет смысл применять пачкой. */
const TRANSITIONS = ['start', 'ready', 'cancel'] as const;

type Outcome = { flight: string; ok: boolean; detail: string };

interface FormValues {
  transition?: (typeof TRANSITIONS)[number];
  vendorId?: string;
  reasonCode?: string;
}

/**
 * Массовые действия над выбранными рейсами `[ТЗ 3.1.2, 3.3.2]`.
 *
 * Пачка выполняется **по одному рейсу**, а не одной операцией на сервере.
 * Так и должно быть: у каждого рейса свой автомат и свои условия перехода,
 * и рейс, который не может перейти, не должен отменять переход остальных.
 *
 * Поэтому и результат показывается построчно: «применено к 7 из 10»
 * без перечня тех трёх — это сообщение, после которого всё равно идут
 * проверять руками.
 */
export function BulkActionsModal({
  mode,
  flights,
  onClose,
}: {
  /** `null` — окно закрыто. */
  mode: 'status' | 'vendor' | null;
  flights: FlightRow[];
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [running, setRunning] = useState(false);

  const vendors = useVendors();

  const close = (): void => {
    form.resetFields();
    setOutcomes([]);
    onClose();
  };

  const explain = (error: unknown): string =>
    error instanceof ApiError ? error.message : t('common.saveFailed');

  const run = async (): Promise<void> => {
    const values = await form.validateFields();
    setRunning(true);
    const collected: Outcome[] = [];

    for (const flight of flights) {
      try {
        if (mode === 'status' && values.transition) {
          await transitionFlight({
            id: flight.id,
            transition: values.transition,
            ...(values.reasonCode ? { reasonCode: values.reasonCode } : {}),
          });
        } else if (mode === 'vendor' && values.vendorId) {
          const orders = await fetchFlightOrders(flight.id);
          const drafts = orders.filter((order) => order.status === 'draft');
          if (drafts.length === 0) {
            collected.push({
              flight: flight.number,
              ok: false,
              detail: t('schedule.bulkNoDrafts'),
            });
            continue;
          }
          for (const order of drafts) {
            await assignOrderVendor({ id: order.id, vendorId: values.vendorId });
          }
        }
        collected.push({ flight: flight.number, ok: true, detail: t('schedule.bulkDone') });
      } catch (error) {
        collected.push({ flight: flight.number, ok: false, detail: explain(error) });
      }
    }

    setOutcomes(collected);
    setRunning(false);

    const failed = collected.filter((item) => !item.ok).length;
    if (failed === 0) {
      void message.success(t('schedule.bulkAllDone', { count: collected.length }));
    } else {
      void message.warning(
        t('schedule.bulkPartly', { done: collected.length - failed, total: collected.length }),
      );
    }
  };

  return (
    <Modal
      open={mode !== null}
      width={680}
      title={mode === 'vendor' ? t('schedule.bulkVendor') : t('schedule.bulkStatus')}
      okText={t('schedule.bulkApply')}
      cancelText={outcomes.length > 0 ? t('common.back') : t('common.cancel')}
      confirmLoading={running}
      okButtonProps={{ disabled: outcomes.length > 0 }}
      onCancel={close}
      onOk={() => {
        void run();
      }}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('schedule.bulkHint', { count: flights.length })}
      </Typography.Paragraph>

      <Form<FormValues> form={form} layout="vertical" requiredMark preserve={false}>
        {mode === 'status' ? (
          <>
            <Form.Item
              name="transition"
              label={t('schedule.bulkTransition')}
              rules={[{ required: true }]}
            >
              <Select
                autoFocus
                options={TRANSITIONS.map((value) => ({
                  value,
                  label: t(`flightTransition.${value}`),
                }))}
              />
            </Form.Item>

            <Form.Item
              noStyle
              shouldUpdate={(before: FormValues, after: FormValues) =>
                before.transition !== after.transition
              }
            >
              {({ getFieldValue }) =>
                // Отмена требует причины — её спрашивает автомат, и спросить
                // её здесь дешевле, чем получить отказ по каждому рейсу.
                getFieldValue('transition') === 'cancel' ? (
                  <Form.Item
                    name="reasonCode"
                    label={t('flight.reasonCode')}
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={['client_request', 'weather', 'technical', 'other'].map(
                        (value) => ({ value, label: t(`reasonCode.${value}`) }),
                      )}
                    />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
          </>
        ) : (
          <Form.Item
            name="vendorId"
            label={t('service.vendor')}
            tooltip={t('schedule.bulkVendorHint')}
            rules={[{ required: true }]}
          >
            <Select
              autoFocus
              showSearch
              optionFilterProp="label"
              loading={vendors.isLoading}
              options={(vendors.data?.data ?? []).map((vendor) => ({
                value: vendor.id,
                label: vendor.name,
              }))}
            />
          </Form.Item>
        )}
      </Form>

      {outcomes.length > 0 ? (
        <>
          <Alert
            type={outcomes.every((item) => item.ok) ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 8 }}
            message={t('schedule.bulkResult', {
              done: outcomes.filter((item) => item.ok).length,
              total: outcomes.length,
            })}
          />
          <Table<Outcome>
            size="small"
            rowKey="flight"
            dataSource={outcomes}
            pagination={false}
            scroll={{ y: 240 }}
            columns={[
              {
                title: t('flight.number'),
                dataIndex: 'flight',
                width: 120,
                render: (value: string) => <Mono>{value}</Mono>,
              },
              {
                title: t('common.status'),
                dataIndex: 'ok',
                width: 110,
                render: (value: boolean) => (
                  <Tag color={value ? 'green' : 'red'}>
                    {value ? t('schedule.bulkOk') : t('schedule.bulkFailed')}
                  </Tag>
                ),
              },
              { title: t('common.error'), dataIndex: 'detail', ellipsis: true },
            ]}
          />
        </>
      ) : null}
    </Modal>
  );
}
