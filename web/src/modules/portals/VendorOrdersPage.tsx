import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Space, Tag, Typography,
  Upload,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { CameraOutlined, PaperClipOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import type { AttachmentRef } from '@/api/attachments';
import { ApiError } from '@/api/client';
import {
  uploadOrderDocument,
  useOrderTransition,
  useServiceOrders,
  type ServiceOrderRow,
} from '@/api/orders';
import { useCurrentUser } from '@/shared/auth/session';
import { useClock } from '@/shared/clock/useClock';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';
import {
  EmptyState, MoneyText, Mono, ServiceStatusTag, UtcTime,
} from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

interface FinishValues {
  actualStart: Dayjs;
  actualEnd: Dayjs;
  actualQuantity: number;
  comment?: string;
}

/**
 * Заявки в портале поставщика `[ТЗ 4.3]`.
 *
 * Поставщик видит **только свои** заявки: ни чужих заявок, ни закупочных цен
 * других поставщиков, ни цен продажи клиенту. Изоляция — на сервере,
 * фильтрацией выборки по `vendor_id` (ADR-003), а не сокрытием на экране.
 *
 * Основной сценарий — подтверждение в два касания: для поставщика это
 * рабочий инструмент, а не справочная система.
 */
export function VendorOrdersPage(): JSX.Element {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const user = useCurrentUser();
  const { nowUtc } = useClock();

  const [finishing, setFinishing] = useState<ServiceOrderRow | null>(null);
  const [needsResponseOnly, setNeedsResponseOnly] = useState(false);
  const [act, setAct] = useState<AttachmentRef | null>(null);
  const [uploading, setUploading] = useState(false);
  const [form] = Form.useForm<FinishValues>();

  const query = useServiceOrders({
    vendorId: user?.vendorId ?? undefined,
    ...(needsResponseOnly ? { needsResponse: true } : {}),
  });
  const orders = query.data?.data ?? [];
  const needsResponse = orders.filter((order) => order.status === 'ordered').length;

  const transition = useOrderTransition();

  const report = (error: unknown): void => {
    const unmet =
      error instanceof ApiError && Array.isArray(error.details['unmetConditions'])
        ? (error.details['unmetConditions'] as { message: string }[])
            .map((item) => item.message)
            .join('; ')
        : '';
    void message.error(
      unmet || (error instanceof ApiError ? error.message : t('service.transitionFailed')),
    );
  };

  const run = (
    id: string,
    name: 'confirm' | 'begin' | 'reject',
    comment?: string,
  ): void => {
    transition
      .mutateAsync({ id, transition: name, ...(comment ? { comment } : {}) })
      .then(() => {
        void message.success(
          t('service.transitionDone', { transition: t(`serviceTransition.${name}`) }),
        );
      })
      .catch(report);
  };

  /** Отказ требует причины: она уходит диспетчеру и в аудит. */
  const requestReject = (id: string): void => {
    let reason = '';
    modal.confirm({
      title: t('portal.vendor.reject'),
      content: (
        <Input.TextArea
          rows={3}
          placeholder={t('service.rejectReasonPlaceholder')}
          onChange={(event) => {
            reason = event.target.value;
          }}
        />
      ),
      okText: t('portal.vendor.reject'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => {
        run(id, 'reject', reason);
      },
    });
  };

  const closeFinish = (): void => {
    setFinishing(null);
    setAct(null);
    form.resetFields();
  };

  /**
   * Завершение заявки: фактические время и количество идут в биллинг
   * (ADR-020), а для услуг с обязательным актом сервер не пропустит
   * переход без загруженного документа.
   */
  const submitFinish = async (): Promise<void> => {
    if (!finishing) return;
    const values = await form.validateFields();

    try {
      await transition.mutateAsync({
        id: finishing.id,
        transition: 'finish',
        actualStartAt: values.actualStart.toISOString(),
        actualEndAt: values.actualEnd.toISOString(),
        actualQuantity: values.actualQuantity.toFixed(4),
        ...(values.comment ? { comment: values.comment } : {}),
      });
      void message.success(t('portal.vendor.finished'));
      closeFinish();
    } catch (error) {
      report(error);
    }
  };

  const countdown = (iso: string | null): string => {
    if (!iso) return '—';
    const diff = new Date(iso).getTime() - nowUtc.getTime();
    if (diff < 0) return t('service.overdue');
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return `${String(hours)} ч ${String(minutes)} м`;
  };

  const columns: DataColumns<ServiceOrderRow> = [
    {
      title: t('service.name'), key: 'service', width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.service?.name.ru ?? row.serviceId}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Mono>{row.airportIcao}</Mono> · {t(`serviceLeg.${row.leg}`)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('service.quantity'), dataIndex: 'quantity', width: 110, align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('finance.cost'), key: 'cost', width: 150, align: 'right',
      render: (_, row) => <MoneyText value={row.purchaseCost} />,
    },
    {
      title: t('service.orderedAt'), dataIndex: 'orderedAt', width: 150,
      render: (value: string | null) =>
        value ? <UtcTime value={value} /> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('service.status'), dataIndex: 'status', width: 150,
      render: (value: string) => <ServiceStatusTag status={value} />,
    },
    {
      title: t('service.slaDeadline'), key: 'sla', width: 150,
      render: (_, row) =>
        row.status === 'ordered' ? (
          <Space direction="vertical" size={0}>
            <Typography.Text
              style={{
                fontSize: 12,
                color: row.slaBreached ? STATUS_TOKENS.critical.color : STATUS_TOKENS.warning.color,
              }}
            >
              <Mono>{countdown(row.slaConfirmDeadline)}</Mono>
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 230, fixed: 'right',
      render: (_, row) => (
        <Space size={4} wrap>
          {row.availableTransitions.includes('confirm') ? (
            <Button
              size="small"
              type="primary"
              loading={transition.isPending}
              onClick={() => { run(row.id, 'confirm'); }}
            >
              {t('portal.vendor.confirm')}
            </Button>
          ) : null}
          {row.availableTransitions.includes('reject') ? (
            <Button size="small" danger onClick={() => { requestReject(row.id); }}>
              {t('portal.vendor.reject')}
            </Button>
          ) : null}
          {row.availableTransitions.includes('begin') ? (
            <Button
              size="small"
              loading={transition.isPending}
              onClick={() => { run(row.id, 'begin'); }}
            >
              {t('serviceTransition.begin')}
            </Button>
          ) : null}
          {row.availableTransitions.includes('finish') ? (
            <Button
              size="small"
              type="primary"
              onClick={() => {
                setFinishing(row);
                setAct(null);
              }}
            >
              {t('serviceTransition.finish')}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.vendor.orders')}
      </Typography.Title>

      {needsResponse > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('portal.vendor.needsResponse', { count: needsResponse })}
        />
      ) : null}

      <Tag.CheckableTag checked={needsResponseOnly} onChange={setNeedsResponseOnly}>
        {t('portal.vendor.needsResponseOnly')}
      </Tag.CheckableTag>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<ServiceOrderRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 1050 }}
              locale={{ emptyText: <EmptyState description={t('portal.vendor.noOrders')} /> }}
            />
          )}
        </QueryState>
      </Card>

      <Modal
        open={finishing !== null}
        title={t('portal.vendor.finishTitle')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmLoading={transition.isPending}
        okButtonProps={{ disabled: uploading }}
        onCancel={closeFinish}
        onOk={() => {
          void submitFinish();
        }}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="info" showIcon message={t('portal.vendor.finishHint')} />
          <Form<FinishValues> form={form} layout="vertical" preserve={false}>
            <Row gutter={12}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="actualStart"
                  label={t('service.actualStart')}
                  rules={[{ required: true }]}
                >
                  <DateTimePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="actualEnd"
                  label={t('service.actualEnd')}
                  rules={[
                    { required: true },
                    {
                      validator: (_, value: Dayjs | undefined) => {
                        const start = form.getFieldValue('actualStart') as Dayjs | undefined;
                        if (value && start && value.isBefore(start)) {
                          return Promise.reject(new Error(t('service.endBeforeStart')));
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <DateTimePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="actualQuantity"
              label={t('service.actualQuantity')}
              extra={t('service.actualQuantityHint')}
              rules={[{ required: true, type: 'number', min: 0 }]}
              initialValue={Number(finishing?.quantity ?? 1)}
            >
              <InputNumber style={{ width: 200 }} precision={4} />
            </Form.Item>

            <Form.Item
              label={t('service.uploadAct')}
              required={finishing?.service?.requiresActToComplete ?? false}
              extra={
                finishing?.service?.requiresActToComplete
                  ? t('service.actRequiredHint')
                  : undefined
              }
            >
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Upload
                  showUploadList={false}
                  accept=".pdf,.jpg,.jpeg,.png"
                  // Файл идёт прямо в хранилище по подписанной ссылке (ADR-007)
                  // и сразу привязывается к заявке: акт, загруженный и не
                  // привязанный, не откроет переход в «Выполнена».
                  customRequest={({ file, onSuccess, onError }) => {
                    if (!finishing) return;
                    setUploading(true);
                    uploadOrderDocument(finishing.id, file as File, 'act')
                      .then((ref) => {
                        setAct(ref);
                        onSuccess?.(ref);
                      })
                      .catch((cause: unknown) => {
                        report(cause);
                        onError?.(cause as Error);
                      })
                      .finally(() => {
                        setUploading(false);
                      });
                  }}
                >
                  <Button icon={<CameraOutlined />} loading={uploading}>
                    {t('service.attachAct')}
                  </Button>
                </Upload>
                {act ? (
                  <Space size={6}>
                    <PaperClipOutlined />
                    <Typography.Text>{act.fileName}</Typography.Text>
                  </Space>
                ) : null}
              </Space>
            </Form.Item>

            <Form.Item name="comment" label={t('portal.vendor.comment')}>
              <Input.TextArea rows={2} />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </Space>
  );
}
