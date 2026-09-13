import { useMemo, useState, type JSX } from 'react';
import { Alert, App, Button, Form, Input, Modal, Select, Space, Steps, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import type { Flight, FlightTransition, ServiceOrder } from '@/api/types';
import flightMachine from '@shared/state-machines/flight.json';
import { useSocStore } from '@/mocks/store';
import { Can } from '@/shared/auth/Can';

/**
 * Панель статуса рейса `[ТЗ 3.1.2]`.
 *
 * Переход действительно выполняется: статус меняется, у рейса пересчитываются
 * доступные переходы, отмена каскадно отменяет заявки. Проверка ведётся против
 * определения автомата `shared/state-machines/flight.json` — того же, что
 * будет валидировать сервер (ADR-015).
 *
 * Недоступный переход не скрывается молча: рядом виден список невыполненных
 * условий, построенный из `guardDescriptions` того же определения
 * (`SPEC.md § 4.4`). Переходы `cancel` и `aog` требуют кода причины
 * и комментария — оба идут в аудит.
 */

const GUARD_DESCRIPTIONS = flightMachine.guardDescriptions as Record<string, string>;

/** Основная линия жизненного цикла — для индикатора прогресса. */
const MAIN_LINE = ['planned', 'in_work', 'ready_for_departure', 'in_flight', 'arrived', 'completed'];

const REASON_CODES: Record<string, string[]> = {
  cancel: ['client_request', 'weather', 'technical', 'no_permit', 'commercial', 'other'],
  aog: ['technical', 'crew', 'weather', 'airport', 'other'],
};

interface ReasonForm {
  reasonCode: string;
  comment: string;
}

export function StatusPanel({
  flight,
  orders,
}: {
  flight: Flight;
  orders: ServiceOrder[];
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const transitionFlight = useSocStore((state) => state.transitionFlight);

  const [pending, setPending] = useState<FlightTransition | null>(null);
  const [form] = Form.useForm<ReasonForm>();

  const available = useMemo(() => flight.availableTransitions ?? [], [flight.availableTransitions]);
  const currentIndex = MAIN_LINE.indexOf(flight.status);
  const offMainLine = currentIndex === -1;

  const unconfirmed = orders.filter((o) => o.status === 'ordered' || o.status === 'draft').length;
  const rejected = orders.filter((o) => o.status === 'rejected').length;

  /**
   * Условия, из-за которых переход не пройдёт. Считаются заранее, чтобы
   * кнопка была видна, но отключена с объяснением, а не исчезала.
   */
  const unmetFor = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const transition of available) {
      const reasons: string[] = [];
      if (transition === 'start') {
        if (!flight.aircraftId) reasons.push('aircraft_assigned');
        if (orders.length === 0) reasons.push('has_at_least_one_service_order');
      }
      if (transition === 'ready') {
        if (rejected > 0) reasons.push('no_rejected_orders');
        if (!orders.every((o) => o.status === 'confirmed' || o.status === 'completed')) {
          reasons.push('all_orders_confirmed_or_completed');
        }
      }
      if (transition === 'complete') {
        if (!orders.every((o) => o.status === 'completed' || o.status === 'cancelled')) {
          reasons.push('all_orders_completed_or_cancelled');
        }
      }
      if (reasons.length > 0) result.set(transition, reasons);
    }
    return result;
  }, [available, flight.aircraftId, orders, rejected]);

  const needsReason = pending === 'cancel' || pending === 'aog';

  const run = (transition: FlightTransition, reason?: ReasonForm): void => {
    const error = transitionFlight(
      flight.id,
      transition,
      reason ? { code: reason.reasonCode, comment: reason.comment } : undefined,
    );

    if (error) {
      void message.error(
        `${t('flight.transitionFailed')}: ${GUARD_DESCRIPTIONS[error] ?? t(`errors.${error}`, error)}`,
      );
      return;
    }

    void message.success(t('flight.transitionDone', { transition: t(`flightTransition.${transition}`) }));
    setPending(null);
    form.resetFields();
  };

  const handleClick = (transition: FlightTransition): void => {
    if (transition === 'cancel' || transition === 'aog') {
      setPending(transition);
      return;
    }
    setPending(transition);
  };

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
            {available.map((transition) => {
              const unmet = unmetFor.get(transition);
              const button = (
                <Button
                  key={transition}
                  type={transition === 'cancel' || transition === 'aog' ? 'default' : 'primary'}
                  danger={transition === 'cancel' || transition === 'aog'}
                  disabled={unmet !== undefined}
                  onClick={() => {
                    handleClick(transition);
                  }}
                >
                  {t(`flightTransition.${transition}`)}
                </Button>
              );

              if (!unmet) return button;

              return (
                <Tooltip
                  key={transition}
                  title={
                    <Space direction="vertical" size={2}>
                      <span>{t('flight.blockedBecause')}</span>
                      {unmet.map((code) => (
                        <span key={code}>• {GUARD_DESCRIPTIONS[code] ?? code}</span>
                      ))}
                      {unconfirmed > 0 ? (
                        <span>• {t('flight.unconfirmedCount', { count: unconfirmed })}</span>
                      ) : null}
                      {rejected > 0 ? (
                        <span>• {t('flight.rejectedCount', { count: rejected })}</span>
                      ) : null}
                    </Space>
                  }
                >
                  <span>{button}</span>
                </Tooltip>
              );
            })}
          </Can>
        </Space>
      </Space>

      {unmetFor.size > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('flight.blockedHint', {
            transition: t(`flightTransition.${[...unmetFor.keys()][0] ?? ''}`),
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
          if (!pending) return;
          if (!needsReason) {
            run(pending);
            return;
          }
          void form.validateFields().then((values) => {
            run(pending, values);
          });
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
            <Form<ReasonForm> form={form} layout="vertical" requiredMark>
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
