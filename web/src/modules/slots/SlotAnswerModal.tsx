import { useState, type JSX } from 'react';
import { Alert, App, DatePicker, Form, Input, Modal, Select, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { useApplySlotAnswer, type SlotRow, type SlotStatus } from '@/api/slots';
import { applyApiError } from '@/shared/ui/form-errors';
import { Mono } from '@/shared/ui/primitives';

interface FormValues {
  text: string;
  status?: SlotStatus;
  confirmedTime?: Dayjs;
}

/**
 * Применение ответа координатора `[ТЗ 3.1.1]` (ADR-026).
 *
 * Диспетчер вставляет ответ письмом, сервер его разбирает. Если разбор
 * не понял ответ — он отказывает и объясняет, а решение и время диспетчер
 * указывает сам. Это не обход проверки: подтверждение слота — основание
 * выпускать рейс, и ошибиться здесь дороже, чем переспросить.
 */
export function SlotAnswerModal({
  slot,
  onClose,
}: {
  slot: SlotRow | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);
  const [needsDecision, setNeedsDecision] = useState(false);

  const applyAnswer = useApplySlotAnswer();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    setNeedsDecision(false);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    try {
      await applyAnswer.mutateAsync({
        id: slot?.id ?? '',
        text: values.text,
        ...(values.status ? { status: values.status } : {}),
        ...(values.confirmedTime
          ? { confirmedTimeUtc: values.confirmedTime.toISOString() }
          : {}),
      });
      void message.success(t('slots.answerApplied'));
      close();
    } catch (error) {
      // Разбор не понял ответ — показываем поля решения, а не просто отказ.
      setNeedsDecision(true);
      setBanner(applyApiError(error, form as never, t('slots.answerFailed')));
    }
  };

  return (
    <Modal
      open={slot !== null}
      width={620}
      title={t('slots.applyAnswer')}
      okText={t('slots.apply')}
      cancelText={t('common.cancel')}
      confirmLoading={applyAnswer.isPending}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      {slot ? (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t('slots.applyAnswerHint')}
          </Typography.Paragraph>

          {slot.messageRef ? (
            <Typography.Paragraph>
              {t('slots.messageRef')}: <Mono>{slot.messageRef}</Mono>
            </Typography.Paragraph>
          ) : null}

          <Form<FormValues> form={form} layout="vertical" requiredMark preserve={false}>
            {banner ? (
              <Alert type="warning" showIcon message={banner} style={{ marginBottom: 12 }} />
            ) : null}

            <Form.Item
              name="text"
              label={t('slots.answerText')}
              rules={[{ required: !needsDecision }]}
            >
              <Input.TextArea
                autoFocus
                rows={6}
                placeholder="SVO SLOT CONFIRMED 1345Z"
              />
            </Form.Item>

            {needsDecision ? (
              <>
                <Form.Item
                  name="status"
                  label={t('slots.decision')}
                  rules={[{ required: true }]}
                >
                  <Select
                    options={(['confirmed', 'rejected'] as const).map((value) => ({
                      value,
                      label: t(`slotStatus.${value}`),
                    }))}
                  />
                </Form.Item>

                <Form.Item
                  name="confirmedTime"
                  label={t('slots.confirmed')}
                  tooltip={t('slots.timeUtcHint')}
                >
                  <DatePicker
                    showTime={{ format: 'HH:mm' }}
                    format="DD.MM.YYYY HH:mm"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </>
            ) : null}
          </Form>
        </>
      ) : null}
    </Modal>
  );
}
