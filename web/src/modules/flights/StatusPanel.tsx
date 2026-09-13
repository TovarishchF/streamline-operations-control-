import { useState, type JSX } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Space, Steps, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import type { Flight, FlightTransition, ServiceOrder } from '@/api/types';
import flightMachine from '@shared/state-machines/flight.json';
import { Can } from '@/shared/auth/Can';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Панель статуса рейса `[ТЗ 3.1.2]`.
 *
 * Доступные переходы — кнопки, недоступные — **скрыты**, но рядом с
 * заблокированным переходом виден список невыполненных условий
 * (`SPEC.md § 4.4`). Список строится из `guardDescriptions` определения
 * автомата, а не из строк в компоненте: определение одно на сервер
 * и клиент (ADR-015).
 *
 * Переходы `cancel` и `aog` требуют выбора причины из справочника
 * и комментария — оба попадают в аудит и в уведомления.
 */

const GUARD_DESCRIPTIONS = flightMachine.guardDescriptions as Record<string, string>;
const MACHINE_STATES = Object.keys(flightMachine.states);

/** Основная линия жизненного цикла — для индикатора прогресса. */
const MAIN_LINE = ['planned', 'in_work', 'ready_for_departure', 'in_flight', 'arrived', 'completed'];

const REASON_CODES: Record<string, string[]> = {
  cancel: ['client_request', 'weather', 'technical', 'no_permit', 'commercial', 'other'],
  aog: ['technical', 'crew', 'weather', 'airport', 'other'],
};

export function StatusPanel({
  flight,
  orders,
}: {
  flight: Flight;
  orders: ServiceOrder[];
}): JSX.Element {
  const { t } = useTranslation();
  const [pending, setPending] = useState<FlightTransition | null>(null);
  const [form] = Form.useForm<{ reasonCode: string; comment: string }>();

  const available = flight.availableTransitions ?? [];
  const blocked = flight.blockedTransitions ?? [];

  const currentIndex = MAIN_LINE.indexOf(flight.status);
  const offMainLine = currentIndex === -1;

  const unconfirmed = orders.filter((o) => o.status === 'ordered' || o.status === 'draft').length;
  const rejected = orders.filter((o) => o.status === 'rejected').length;

  const needsReason = pending === 'cancel' || pending === 'aog';

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={16} wrap align="start" style={{ width: '100%' }}>
        <div style={{ flex: 1, minWidth: 280, maxWidth: 620 }}>
          {offMainLine ? (
            <Alert
              type={flight.status === 'aog' ? 'error' : 'info'}
              showIcon
              message={t(`flightStatus.${flight.status}`)}
              description={flight.statusReason?.comment ?? undefined}
            />
          ) : (
            <Steps
              size="small"
              current={currentIndex}
              items={MAIN_LINE.map((state) => ({ title: t(`flightStatus.${state}`) }))}
            />
          )}
        </div>

        <Space size={6} wrap>
          <Can permission="flight.status">
            {available.map((transition) => (
              <Button
                key={transition}
                type={transition === 'cancel' || transition === 'aog' ? 'default' : 'primary'}
                danger={transition === 'cancel' || transition === 'aog'}
                onClick={() => {
                  setPending(transition);
                }}
              >
                {t(`flightTransition.${transition}`)}
              </Button>
            ))}
          </Can>

          {/* Заблокированный переход показывается с перечнем невыполненных условий */}
          {blocked.map((item) => (
            <Tooltip
              key={item.transition}
              title={
                <Space direction="vertical" size={2}>
                  <span>{t('flight.blockedBecause')}</span>
                  {(item.unmetConditions ?? []).map((code) => (
                    <span key={code}>• {GUARD_DESCRIPTIONS[code] ?? code}</span>
                  ))}
                  {unconfirmed > 0 ? <span>• {t('flight.unconfirmedCount', { count: unconfirmed })}</span> : null}
                  {rejected > 0 ? <span>• {t('flight.rejectedCount', { count: rejected })}</span> : null}
                </Space>
              }
            >
              <Button disabled>{t(`flightTransition.${item.transition ?? ''}`)}</Button>
            </Tooltip>
          ))}
        </Space>
      </Space>

      {blocked.length > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('flight.blockedHint', {
            transition: t(`flightTransition.${blocked[0]?.transition ?? ''}`),
          })}
        </Typography.Text>
      ) : null}

      <Modal
        open={pending !== null}
        title={pending ? t(`flightTransition.${pending}`) : ''}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => {
          setPending(null);
          form.resetFields();
        }}
        onOk={() => {
          // На M4 здесь будет POST /flights/{id}/status.
          setPending(null);
          form.resetFields();
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            message={t('flight.transitionEffects')}
            description={
              <Space direction="vertical" size={0}>
                <span>• {t('flight.effectAudit')}</span>
                <span>• {t('flight.effectOutbox')}</span>
                <span>• {t('flight.effectMargin')}</span>
                {pending === 'cancel' ? <span>• {t('flight.effectCascade')}</span> : null}
                {pending === 'aog' ? <span>• {t('flight.effectAircraft')}</span> : null}
              </Space>
            }
          />

          {needsReason ? (
            <Form form={form} layout="vertical" requiredMark>
              <Form.Item
                name="reasonCode"
                label={t('flight.reasonCode')}
                rules={[{ required: true, message: t('flight.reasonRequired') }]}
              >
                <Select
                  options={(REASON_CODES[pending] ?? []).map((code) => ({
                    value: code,
                    label: t(`reasonCode.${code}`),
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="comment"
                label={t('flight.comment')}
                rules={[{ required: true, message: t('flight.commentRequired') }]}
              >
                <Input.TextArea rows={3} />
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('flight.reasonGoesToAudit')}
              </Typography.Text>
            </Form>
          ) : null}
        </Space>
      </Modal>
    </Space>
  );
}

export { MACHINE_STATES, STATUS_TOKENS };
