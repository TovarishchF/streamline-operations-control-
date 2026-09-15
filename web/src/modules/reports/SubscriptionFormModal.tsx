import { useState, type JSX } from 'react';
import { Alert, App, Col, Form, Modal, Row, Select, TimePicker, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import {
  exportFormats,
  useCreateSubscription,
  useUpdateSubscription,
  type ExportFormat,
  type ReportDefinition,
  type ReportSchedule,
  type ReportSubscription,
} from '@/api/reports';
import { applyApiError } from '@/shared/ui/form-errors';

const SCHEDULES: ReportSchedule[] = ['daily', 'weekly', 'monthly'];

interface FormValues {
  code: string;
  schedule: ReportSchedule;
  time: Dayjs;
  format: ExportFormat;
  recipients: string[];
}

/**
 * Подписка на отчёт по расписанию `[ТЗ 3.6.3]`.
 *
 * Время задаётся и показывается в UTC: планировщик работает по серверным
 * часам, а получатели бывают в разных зонах. Подпись зоны стоит рядом
 * с полем — время без зоны в этой системе не бывает (`CLAUDE.md § 3` п. 2).
 *
 * Одно окно и на заведение, и на изменение: набор полей тот же, а два
 * почти одинаковых окна расходятся при первой же правке.
 */
export function SubscriptionFormModal({
  open,
  onClose,
  definitions,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  definitions: ReportDefinition[];
  /** `null` — заведение новой подписки. */
  editing: ReportSubscription | null;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);

  const createSubscription = useCreateSubscription();
  const updateSubscription = useUpdateSubscription();
  const pending = createSubscription.isPending || updateSubscription.isPending;

  /**
   * Начальные значения задаются формой, а не проставляются после открытия.
   *
   * Содержимое окна создаётся заново на каждое открытие (`destroyOnClose`),
   * и попытка заполнить поля извне приходится на момент, когда формы ещё
   * нет: окно изменения открывалось пустым, а сохранение падало
   * на обязательных полях.
   */
  const initialValues = editing
    ? {
        code: editing.code,
        schedule: editing.schedule,
        time: dayjs(editing.timeUtc, 'HH:mm'),
        format: editing.format,
        recipients: editing.recipients,
      }
    : {
        schedule: 'weekly' as ReportSchedule,
        time: dayjs('06:00', 'HH:mm'),
        format: 'xlsx' as ExportFormat,
        recipients: [],
      };

  const close = (): void => {
    setBanner(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    const payload = {
      code: values.code,
      schedule: values.schedule,
      // Время не переводится между зонами: человек вводит время по UTC,
      // подпись зоны стоит у поля. Пересчёт превратил бы 06:00 UTC
      // в 03:00 UTC на машине в Москве.
      timeUtc: values.time.format('HH:mm'),
      format: values.format,
      recipients: values.recipients,
    };

    try {
      if (editing) {
        await updateSubscription.mutateAsync({ id: editing.id, ...payload });
        void message.success(t('reports.subscriptionUpdated'));
      } else {
        await createSubscription.mutateAsync(payload);
        void message.success(t('reports.subscriptionCreated'));
      }
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={560}
      title={editing ? t('reports.editSubscription') : t('reports.addSubscription')}
      okText={editing ? t('common.save') : t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={pending}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Form<FormValues>
        // Ключ по изменяемой записи: при переключении между подписками
        // форма пересобирается, а не показывает прежние значения.
        key={editing?.id ?? 'new'}
        form={form}
        layout="vertical"
        requiredMark
        preserve={false}
        initialValues={initialValues}
      >
        {banner ? (
          <Alert type="error" showIcon message={banner} style={{ marginBottom: 12 }} />
        ) : null}

        <Form.Item name="code" label={t('reports.report')} rules={[{ required: true }]}>
          <Select
            autoFocus
            options={definitions.map((definition) => ({
              value: definition.code,
              label: definition.name.ru,
            }))}
          />
        </Form.Item>

        <Row gutter={12}>
          <Col xs={24} sm={9}>
            <Form.Item
              name="schedule"
              label={t('reports.scheduleLabel')}
              rules={[{ required: true }]}
            >
              <Select
                options={SCHEDULES.map((value) => ({
                  value,
                  label: t(`reports.schedule.${value}`),
                }))}
              />
            </Form.Item>
          </Col>
          <Col xs={12} sm={8}>
            <Form.Item
              name="time"
              label={t('reports.timeUtc')}
              tooltip={t('reports.timeUtcHint')}
              rules={[{ required: true }]}
            >
              <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} sm={7}>
            <Form.Item
              name="format"
              label={t('reports.format')}
              rules={[{ required: true }]}
            >
              <Select
                options={exportFormats.map((value) => ({
                  value,
                  label: value.toUpperCase(),
                }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="recipients"
          label={t('reports.recipients')}
          tooltip={t('reports.recipientsHint')}
          rules={[
            { required: true, type: 'array', min: 1 },
            {
              type: 'array',
              defaultField: { type: 'email' },
            },
          ]}
        >
          <Select mode="tags" tokenSeparators={[',', ' ', ';']} open={false} />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('reports.subscriptionsHint')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
