import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Form, Input, InputNumber, Row, Space, Tag, Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useExportInvoice, useQuoteAction } from '@/api/documents';
import {
  useClientPortalDocuments,
  useClientPortalFlights,
  useSubmitFlightRequest,
  type ClientPortalDocumentRow,
  type ClientPortalFlightRow,
} from '@/api/portals';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { AirportSelect } from '@/shared/ui/AirportSelect';
import { DateTimePicker } from '@/shared/ui/DateTimePicker';
import { QueryState } from '@/shared/ui/QueryState';
import {
  DateText, EmptyState, FlightStatusTag, MoneyText, Mono, ServiceStatusTag, UtcTime,
} from '@/shared/ui/primitives';
import { Notice } from '@/shared/ui/Notice';

/**
 * Портал клиента `[ТЗ 3.5.3]`.
 *
 * Урезанное представление: клиент видит **статусы** своих услуг, но не видит
 * ни закупочных цен, ни данных поставщиков. Это обеспечивается составом ответа
 * сервера (`GET /portal/client/flights`), а не фильтрацией на клиенте.
 *
 * Изоляция данных — фильтрация выборки по арендатору на сервере; запрос
 * чужого рейса возвращает **404**, а не 403: факт существования чужого рейса
 * не раскрывается (ADR-003).
 */
export function ClientFlightsPage(): JSX.Element {
  const { t } = useTranslation();
  const localized = useLocalizedName();
  const query = useClientPortalFlights();

  const columns: DataColumns<ClientPortalFlightRow> = [
    {
      title: t('flight.number'), dataIndex: 'number', filterable: 'text', width: 110,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('flight.route'), key: 'route', width: 130,
      render: (_, row) => <Mono>{row.depIcao} → {row.arrIcao}</Mono>,
    },
    {
      title: t('flight.std'), dataIndex: 'stdUtc', width: 110,
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.stdUtc.localeCompare(b.stdUtc),
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.sta'), dataIndex: 'staUtc', width: 110,
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.status'), dataIndex: 'status', width: 150,
      render: (value: string) => <FlightStatusTag status={value} />,
    },
    {
      title: t('portal.client.servicesStatus'), key: 'services', sortable: false,
      render: (_, row) =>
        row.services.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {row.services.map((service, index) => (
              <Space key={`${service.leg}:${String(index)}`} size={2}>
                <Typography.Text style={{ fontSize: 12 }}>{localized(service.serviceName)}</Typography.Text>
                <ServiceStatusTag status={service.status} />
              </Space>
            ))}
          </Space>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.client.flights')}
      </Typography.Title>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<ClientPortalFlightRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 900 }}
              locale={{ emptyText: <EmptyState description={t('portal.client.noFlights')} /> }}
            />
          )}
        </QueryState>
      </Card>
    </Space>
  );
}

interface RequestValues {
  dep: string;
  arr: string;
  date: Dayjs;
  pax: number;
  comment?: string;
}

/** Заявка клиента на рейс. Становится рейсом только после подтверждения диспетчером. */
export function ClientRequestPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<RequestValues>();
  const submit = useSubmitFlightRequest();
  const [submitted, setSubmitted] = useState(false);

  const send = async (values: RequestValues): Promise<void> => {
    try {
      await submit.mutateAsync({
        depIcao: values.dep,
        arrIcao: values.arr,
        requestedStdUtc: values.date.toISOString(),
        paxCount: values.pax,
        comment: values.comment ?? '',
      });
      setSubmitted(true);
      form.resetFields();
      void message.success(t('portal.client.requestSubmitted'));
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.client.newRequest')}
      </Typography.Title>

      <Notice id="portal.client.request" type="info" showIcon message={t('portal.client.requestNotice')} />

      {submitted ? (
        <Alert
          type="success" showIcon
          message={t('portal.client.requestSubmitted')}
          action={
            <Button size="small" onClick={() => { setSubmitted(false); }}>
              {t('portal.client.newAnother')}
            </Button>
          }
        />
      ) : (
        <Card size="small">
          <Form<RequestValues>
            form={form}
            layout="vertical"
            style={{ maxWidth: 620 }}
            initialValues={{ pax: 4 }}
            onFinish={(values) => {
              void send(values);
            }}
          >
            <Row gutter={12}>
              <Col xs={24} md={12}>
                <Form.Item
                  label={t('flight.departure')} name="dep"
                  rules={[{ required: true, message: t('common.required') }]}
                >
                  <AirportSelect />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  label={t('flight.arrival')} name="arr"
                  rules={[
                    { required: true, message: t('common.required') },
                    {
                      validator: (_, value: string | undefined) =>
                        value && value === form.getFieldValue('dep')
                          ? Promise.reject(new Error(t('flight.sameAirport')))
                          : Promise.resolve(),
                    },
                  ]}
                >
                  <AirportSelect />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  label={t('portal.client.requestedDate')} name="date"
                  rules={[{ required: true, message: t('common.required') }]}
                >
                  <DateTimePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item label={t('flight.pax')} name="pax">
                  <InputNumber min={0} max={500} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label={t('portal.client.comment')} name="comment">
              <Input.TextArea rows={3} />
            </Form.Item>

            <Button type="primary" htmlType="submit" loading={submit.isPending}>
              {t('portal.client.submitRequest')}
            </Button>
          </Form>
        </Card>
      )}
    </Space>
  );
}

/**
 * Финансовые документы клиента `[ТЗ 3.5.3]`.
 *
 * Выборка ограничена сервером по `client_id` (ADR-003): чужие документы
 * сюда не попадают по построению, а не потому, что их отфильтровали
 * на экране. Черновиков в ответе нет: документ становится документом
 * в момент выставления.
 */
export function ClientDocumentsPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const query = useClientPortalDocuments();

  const accept = useQuoteAction('accept');
  const decline = useQuoteAction('decline');
  const exportInvoice = useExportInvoice();

  const report = (error: unknown): void => {
    void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
  };

  const respond = (id: string, accepted: boolean): void => {
    const action = accepted ? accept : decline;
    action
      .mutateAsync({ id })
      .then(() => {
        void message.success(
          accepted ? t('portal.client.quoteAccepted') : t('portal.client.quoteDeclined'),
        );
        void query.refetch();
      })
      .catch(report);
  };

  /** PDF собирает сервер и отдаёт подписанной ссылкой (ADR-007). */
  const download = (id: string): void => {
    exportInvoice
      .mutateAsync({ id, format: 'pdf' })
      .then((ticket) => {
        if (ticket.downloadUrl) window.open(ticket.downloadUrl, '_blank', 'noopener');
      })
      .catch(report);
  };

  const columns: DataColumns<ClientPortalDocumentRow> = [
    {
      title: t('finance.kind'), dataIndex: 'kind', width: 130,
      render: (value: string) => <Tag>{t(`finance.${value}`)}</Tag>,
    },
    {
      title: t('finance.number'), dataIndex: 'number', filterable: 'text', width: 180,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('finance.issuedAt'), dataIndex: 'issuedAt', width: 120,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.dueDate'), dataIndex: 'dueDate', width: 120,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.total'), key: 'total', width: 160, align: 'right',
      render: (_, row) => <MoneyText value={row.total} strong />,
    },
    {
      title: t('finance.status'), dataIndex: 'status', width: 150,
      render: (value: string, row) => (
        <Tag>{row.kind === 'quote' ? t(`quoteStatus.${value}`) : t(`invoiceStatus.${value}`)}</Tag>
      ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 230,
      render: (_, row) => {
        if (row.kind === 'quote' && row.status === 'issued') {
          return (
            <Space size={4}>
              <Button
                size="small"
                type="primary"
                loading={accept.isPending}
                onClick={() => { respond(row.id, true); }}
              >
                {t('finance.acceptQuote')}
              </Button>
              <Button
                size="small"
                danger
                loading={decline.isPending}
                onClick={() => { respond(row.id, false); }}
              >
                {t('finance.declineQuote')}
              </Button>
            </Space>
          );
        }
        if (row.kind === 'invoice') {
          return (
            <Button size="small" loading={exportInvoice.isPending} onClick={() => { download(row.id); }}>
              {t('common.download')}
            </Button>
          );
        }
        return <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.client.documents')}
      </Typography.Title>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<ClientPortalDocumentRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 1050 }}
              locale={{ emptyText: <EmptyState /> }}
            />
          )}
        </QueryState>
      </Card>
    </Space>
  );
}
