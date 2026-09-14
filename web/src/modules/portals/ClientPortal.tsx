import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Form, Input, InputNumber, Row, Select, Space, Tag,
  Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { DateTimePicker } from '@/shared/ui/DateTimePicker';

import { ApiError } from '@/api/client';
import { useInvoices, useQuotes, useQuoteAction } from '@/api/documents';
import type { ClientPortalDocument, ClientPortalFlight } from '@/api/types';
import { ordersForFlight } from '@/mocks/flights';
import { AIRPORTS } from '@/mocks/reference';
import { useSocStore } from '@/mocks/store';
import { useCurrentUser } from '@/shared/auth/session';
import {
  DateText, EmptyState, FlightStatusTag, MoneyText, Mono, ServiceStatusTag, UtcTime,
} from '@/shared/ui/primitives';

/**
 * Портал клиента `[ТЗ 3.5.3]`.
 *
 * Урезанное представление: клиент видит **статусы** своих услуг, но не видит
 * ни закупочных цен, ни данных поставщиков. Это обеспечивается составом ответа
 * сервера (`ClientPortalFlight` в контракте), а не фильтрацией на клиенте.
 *
 * Изоляция данных — фильтрация выборки по арендатору на сервере; запрос
 * чужого рейса возвращает **404**, а не 403: факт существования чужого рейса
 * не раскрывается (ADR-003).
 */
export function ClientFlightsPage(): JSX.Element {
  const { t } = useTranslation();
  const user = useCurrentUser();

  const allFlights = useSocStore((state) => state.flights);
  const flights: ClientPortalFlight[] = allFlights
    .filter((f) => f.clientId === user?.clientId)
    .map(
    (flight) => ({
      id: flight.id,
      number: flight.number,
      depIcao: flight.depIcao,
      arrIcao: flight.arrIcao,
      stdUtc: flight.stdUtc,
      staUtc: flight.staUtc,
      status: flight.status,
      services: ordersForFlight(flight.id).map((order) => ({
        serviceName: order.service?.name ?? { ru: order.serviceId, en: order.serviceId },
        leg: order.leg,
        status: order.status,
      })),
    }),
  );

  const columns: DataColumns<ClientPortalFlight> = [
    {
      title: t('flight.number'), dataIndex: 'number', width: 110,
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
      title: t('portal.client.servicesStatus'), key: 'services',
      render: (_, row) => (
        <Space size={4} wrap>
          {(row.services ?? []).map((service, index) => (
            <Space key={index} size={2}>
              <Typography.Text style={{ fontSize: 12 }}>{service.serviceName?.ru}</Typography.Text>
              <ServiceStatusTag status={service.status ?? 'draft'} />
            </Space>
          ))}
          {(row.services ?? []).length === 0 ? (
            <Typography.Text type="secondary">—</Typography.Text>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.client.flights')}
      </Typography.Title>

      <Alert type="info" showIcon message={t('portal.client.noPurchasePrices')} />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<ClientPortalFlight>
          size="small" rowKey="id" columns={columns} dataSource={flights}
          pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 900 }}
          locale={{ emptyText: <EmptyState description={t('portal.client.noFlights')} /> }}
        />
      </Card>
    </Space>
  );
}

/** Заявка клиента на рейс. Становится рейсом только после подтверждения диспетчером. */
export function ClientRequestPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const user = useCurrentUser();
  const createRequest = useSocStore((state) => state.createRequest);
  const [submitted, setSubmitted] = useState(false);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.client.newRequest')}
      </Typography.Title>

      <Alert type="info" showIcon message={t('portal.client.requestNotice')} />

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
          <Form
            layout="vertical"
            style={{ maxWidth: 620 }}
            onFinish={(values: {
              dep: string;
              arr: string;
              date: { toISOString: () => string };
              pax: number;
              comment?: string;
            }) => {
              createRequest({
                clientId: (user?.clientId ?? ''),
                depIcao: values.dep,
                arrIcao: values.arr,
                requestedStdUtc: values.date.toISOString(),
                paxCount: values.pax,
                comment: values.comment ?? '',
              });
              setSubmitted(true);
              void message.success(t('portal.client.requestSubmitted'));
            }}
          >
            <Row gutter={12}>
              <Col xs={24} md={12}>
                <Form.Item
                  label={t('flight.departure')} name="dep"
                  rules={[{ required: true, message: t('common.required') }]}
                >
                  <Select
                    showSearch optionFilterProp="label"
                    options={AIRPORTS.map((a) => ({ value: a.icao, label: `${a.icao} — ${a.city}` }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  label={t('flight.arrival')} name="arr"
                  rules={[{ required: true, message: t('common.required') }]}
                >
                  <Select
                    showSearch optionFilterProp="label"
                    options={AIRPORTS.map((a) => ({ value: a.icao, label: `${a.icao} — ${a.city}` }))}
                  />
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
                <Form.Item label={t('flight.pax')} name="pax" initialValue={4}>
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label={t('portal.client.comment')} name="comment">
              <Input.TextArea rows={3} />
            </Form.Item>

            <Button type="primary" htmlType="submit">
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
 * на экране.
 *
 * Черновики клиенту не показываются: документ становится документом
 * в момент выставления, а до него это внутренняя заготовка.
 */
export function ClientDocumentsPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const quotes = useQuotes({}).data?.data ?? [];
  const invoices = useInvoices({}).data?.data ?? [];

  const accept = useQuoteAction('accept');
  const decline = useQuoteAction('decline');

  const respond = (id: string, accepted: boolean): void => {
    const action = accepted ? accept : decline;
    action
      .mutateAsync({ id })
      .then(() => {
        void message.success(
          accepted ? t('portal.client.quoteAccepted') : t('portal.client.quoteDeclined'),
        );
      })
      .catch((error: unknown) => {
        void message.error(
          error instanceof ApiError ? error.message : t('common.saveFailed'),
        );
      });
  };

  const documents: ClientPortalDocument[] = [
    ...quotes
      .filter((quote) => quote.number !== null)
      .map((quote) => ({
        id: quote.id,
        kind: 'quote' as const,
        number: quote.number ?? '',
        issuedAt: quote.issuedAt,
        dueDate: null,
        status: quote.status,
        total: quote.totals.grandTotal,
        downloadUrl: '#',
      })),
    ...invoices
      .filter((invoice) => invoice.number !== null)
      .map((invoice) => ({
        id: invoice.id,
        kind: 'invoice' as const,
        number: invoice.number ?? '',
        issuedAt: invoice.issuedAt,
        dueDate: invoice.dueDate,
        status: invoice.status,
        total: invoice.totals.grandTotal,
        downloadUrl: '#',
      })),
  ];

  const columns: DataColumns<ClientPortalDocument> = [
    {
      title: t('finance.kind'), dataIndex: 'kind', width: 130,
      render: (value: string) => <Tag>{t(`finance.${value}`)}</Tag>,
    },
    {
      title: t('finance.number'), dataIndex: 'number', width: 180,
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
      render: (_, row) =>
        row.kind === 'quote' && row.status === 'issued' ? (
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
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('portal.client.documents')}
      </Typography.Title>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<ClientPortalDocument>
          size="small" rowKey="id" columns={columns} dataSource={documents}
          pagination={{ pageSize: 15, size: 'small' }} scroll={{ x: 1050 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
