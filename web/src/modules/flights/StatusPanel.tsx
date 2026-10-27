import { useState, type JSX } from 'react';
import { Alert, App, Button, Form, Input, Modal, Select, Space, Steps, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useFlightTransition, type Flight, type FlightTransition } from '@/api/flights';
import flightDefinition from '@shared/state-machines/flight.json';
import { flightMachine, targetOf } from '@/domain/machines';
import { Can } from '@/shared/auth/Can';
import { FLIGHT_REASON_CODES } from './reasons';

/**
 * Панель статуса рейса `[ТЗ 3.1.2]` (`SPEC.md § 4.4`).
 *
 * Доступные и заблокированные переходы приходят с сервера: он проверяет
 * условия против `shared/state-machines/flight.json` (ADR-015), и клиент
 * их не повторяет — иначе кнопка оказалась бы активной там, где сервер
 * ответит отказом. Доступные переходы — кнопки, у заблокированных рядом
 * список невыполненных условий.
 *
 * Отмена и AOG требуют причины из справочника и комментария. Завершение
 * без выставленного счёта — отдельное явное действие с причиной
 * (`DOMAIN.md § 5.1`).
 */

/** Основная линия жизненного цикла — для индикатора прогресса. */
const MAIN_LINE = ['planned', 'in_work', 'ready_for_departure', 'in_flight', 'arrived', 'completed'];


/**
 * Что сделает переход — из того же определения автомата, что исполняет
 * сервер. `mark_aircraft_aog` сервер не выполняет (G-56), письма
 * поставщикам уходят только об отменённых заявках.
 */
function effectsOf(transition: FlightTransition): string[] {
  const definition = flightDefinition.transitions.find((item) => item.name === transition);
  const effects: string[] = definition?.effects ?? [];
  const cascade = effects.includes('cancel_all_orders');
  return effects.filter(
    (effect) =>
      effect !== 'mark_aircraft_aog' && (effect !== 'notify_vendors' || cascade),
  );
}

type Pending = { transition: FlightTransition; withoutInvoice: boolean };

interface ReasonForm {
  reasonCode?: string;
  comment?: string;
}

export function StatusPanel({ flight }: { flight: Flight }): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const mutation = useFlightTransition(flight.id);

  const [pending, setPending] = useState<Pending | null>(null);
  const [refusal, setRefusal] = useState<string[]>([]);
  const [form] = Form.useForm<ReasonForm>();

  const currentIndex = MAIN_LINE.indexOf(flight.status);
  const offMainLine = currentIndex === -1;
  const completeBlocked = flight.blockedTransitions.some((item) => item.transition === 'complete');

  const needsReason = pending?.transition === 'cancel' || pending?.transition === 'aog';
  // Куда ведёт переход — по машине из того же определения, что у сервера.
  const target = pending ? targetOf(flightMachine, flight.status, pending.transition) : null;
  const needsComment = needsReason || pending?.withoutInvoice === true;

  const close = (): void => {
    setPending(null);
    setRefusal([]);
    form.resetFields();
  };

  const run = (values: ReasonForm): void => {
    if (!pending) return;
    setRefusal([]);
    mutation.mutate(
      {
        transition: pending.transition,
        ...(values.reasonCode ? { reasonCode: values.reasonCode } : {}),
        ...(values.comment ? { comment: values.comment } : {}),
        ...(pending.withoutInvoice ? { completeWithoutInvoice: true } : {}),
      },
      {
        onSuccess: () => {
          void message.success(
            t('flight.transitionDone', { transition: t(`flightTransition.${pending.transition}`) }),
          );
          close();
        },
        onError: (error) => {
          // Условия могли измениться между загрузкой карточки и нажатием:
          // сервер присылает актуальный перечень, он и показывается.
          const unsatisfied =
            error instanceof ApiError && Array.isArray(error.details['unsatisfied'])
              ? error.details['unsatisfied'].map(String)
              : [];
          setRefusal(
            unsatisfied.length > 0
              ? unsatisfied
              : [error instanceof ApiError ? error.message : t('flight.transitionFailed')],
          );
        },
      },
    );
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={16} wrap align="start" style={{ width: '100%' }}>
        {/* Шести шагам нужна ширина: в 620 px «Запланирован» и «Готов
            к вылету» резались многоточием до «Запланирс». */}
        <div style={{ flex: 1, minWidth: 'min(280px, 100%)', maxWidth: 880 }}>
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
              labelPlacement="vertical"
              items={MAIN_LINE.map((state) => ({ title: t(`flightStatus.${state}`) }))}
            />
          )}
        </div>

        <Can permission="flight.status">
          <Space size={6} wrap>
            {flight.availableTransitions.map((transition) => (
              <Button
                key={transition}
                type={transition === 'cancel' || transition === 'aog' ? 'default' : 'primary'}
                danger={transition === 'cancel' || transition === 'aog'}
                onClick={() => {
                  setPending({ transition, withoutInvoice: false });
                }}
              >
                {t(`flightTransition.${transition}`)}
              </Button>
            ))}
            {completeBlocked ? (
              <Button
                onClick={() => {
                  setPending({ transition: 'complete', withoutInvoice: true });
                }}
              >
                {t('flight.completeWithoutInvoice')}
              </Button>
            ) : null}
          </Space>
        </Can>
      </Space>

      {flight.blockedTransitions.length > 0 ? (
        <Space direction="vertical" size={2}>
          {flight.blockedTransitions.map((blocked) => (
            <Typography.Text key={blocked.transition} type="secondary" style={{ fontSize: 12 }}>
              {t('flight.blockedTransition', {
                transition: t(`flightTransition.${blocked.transition}`),
              })}{' '}
              {blocked.unmetConditions.join('; ')}
            </Typography.Text>
          ))}
        </Space>
      ) : null}

      <Modal
        open={pending !== null}
        title={
          pending
            ? pending.withoutInvoice
              ? t('flight.completeWithoutInvoice')
              : t(`flightTransition.${pending.transition}`)
            : ''
        }
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmLoading={mutation.isPending}
        onCancel={close}
        onOk={() => {
          void form.validateFields().then(run);
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {target ? (
            <Typography.Text>
              {t('flight.transitionTarget', {
                from: t(`flightStatus.${flight.status}`),
                to: t(`flightStatus.${target}`),
              })}
            </Typography.Text>
          ) : null}

          {pending ? (
            <Alert
              type="info"
              message={t('flight.transitionEffects')}
              description={
                <Space direction="vertical" size={0}>
                  {effectsOf(pending.transition).map((effect) => (
                    <span key={effect}>• {t(`flight.effects.${effect}`)}</span>
                  ))}
                </Space>
              }
            />
          ) : null}

          {refusal.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message={t('flight.transitionFailed')}
              description={
                <Space direction="vertical" size={0}>
                  {refusal.map((text) => (
                    <span key={text}>• {text}</span>
                  ))}
                </Space>
              }
            />
          ) : null}

          <Form<ReasonForm> form={form} layout="vertical" requiredMark>
            {needsReason ? (
              <Form.Item
                name="reasonCode"
                label={t('flight.reasonCode')}
                rules={[{ required: true, message: t('flight.reasonRequired') }]}
              >
                <Select
                  options={FLIGHT_REASON_CODES[pending.transition === 'aog' ? 'aog' : 'cancel'].map((code) => ({
                    value: code,
                    label: t(`reasonCode.${code}`),
                  }))}
                />
              </Form.Item>
            ) : null}
            {needsComment ? (
              <>
                <Form.Item
                  name="comment"
                  label={t('flight.comment')}
                  rules={[{ required: true, whitespace: true, message: t('flight.commentRequired') }]}
                >
                  <Input.TextArea rows={3} />
                </Form.Item>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('flight.reasonGoesToAudit')}
                </Typography.Text>
              </>
            ) : null}
          </Form>
        </Space>
      </Modal>
    </Space>
  );
}
