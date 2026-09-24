import { useState, type JSX } from 'react';
import { Alert, Button, Card, Col, Row, Select, Space, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  useInvoices,
  useQuotes,
  type InvoiceRow,
  type QuoteRow,
} from '@/api/documents';
import { useClients } from '@/api/counterparties';
import { useFlights } from '@/api/flights';
import { Can } from '@/shared/auth/Can';
import { useClock } from '@/shared/clock/useClock';
import { DateText, EmptyState, MoneyText, Mono, GenericStatusTag } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { DocumentFormModal } from './DocumentFormModal';

const QUOTE_TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  draft: 'neutral', issued: 'progress', accepted: 'done',
  declined: 'critical', expired: 'cancelled', voided: 'cancelled',
};

const INVOICE_TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  draft: 'neutral', issued: 'progress', sent: 'progress', partially_paid: 'warning',
  paid: 'done', overdue: 'critical', voided: 'cancelled',
};

function StatusTag({
  status,
  map,
  prefix,
}: {
  status: string;
  map: Record<string, keyof typeof STATUS_TOKENS>;
  prefix: string;
}): JSX.Element {
  const { t } = useTranslation();
  return <GenericStatusTag token={map[status] ?? 'neutral'} label={t(`${prefix}.${status}`)} />;
}

/**
 * Имена рейсов и клиентов по идентификаторам.
 *
 * Документ несёт только идентификаторы: номер рейса и наименование клиента
 * живут в своих реестрах и меняются там. Дублировать их в документ значило
 * бы показывать устаревшее имя после переименования клиента.
 */
function useLabels(): { flights: Map<string, string>; clients: Map<string, string> } {
  const flights = new Map(
    (useFlights({}).data?.data ?? []).map((flight) => [
      flight.id,
      `${flight.number} ${flight.depIcao}→${flight.arrIcao}`,
    ]),
  );
  const clients = new Map(
    (useClients().data?.data ?? []).map((client) => [client.id, client.name]),
  );
  return { flights, clients };
}

/** Котировки `[ТЗ 3.4.1]`. */
export function QuotesPage(): JSX.Element {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  const query = useQuotes({ clientId, status });
  const { flights, clients } = useLabels();

  const columns: DataColumns<QuoteRow> = [
    {
      title: t('finance.number'), dataIndex: 'number', width: 170, fixed: 'left',
      render: (value: string | null, row) => (
        <Link to={`/billing/quotes/${row.id}`}>
          <Mono>{value ?? t('finance.draft')}</Mono>
        </Link>
      ),
    },
    {
      title: t('finance.client'), dataIndex: 'clientId', width: 220, ellipsis: true,
      render: (value: string) => clients.get(value) ?? value,
    },
    {
      title: t('finance.flight'), dataIndex: 'flightId', width: 200,
      render: (value: string) => (
        <Link to={`/flights/${value}`}>
          <Mono>{flights.get(value) ?? value}</Mono>
        </Link>
      ),
    },
    {
      title: t('finance.issuedAt'), dataIndex: 'issuedAt', width: 130,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.validUntil'), dataIndex: 'validUntil', width: 130,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.total'), key: 'total', width: 170, align: 'right',
      sorter: (a, b) =>
        Number.parseFloat(a.totals.grandTotal.amount) -
        Number.parseFloat(b.totals.grandTotal.amount),
      render: (_, row) => <MoneyText value={row.totals.grandTotal} strong />,
    },
    {
      title: t('finance.status'), dataIndex: 'status', width: 150,
      render: (value: string) => (
        <StatusTag status={value} map={QUOTE_TOKEN} prefix="quoteStatus" />
      ),
    },
  ];

  const createButton = (
    <Can permission="billing.documents.edit">
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setCreating(true);
        }}
      >
        {t('finance.createQuote')}
      </Button>
    </Can>
  );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nav.quotes')}
          </Typography.Title>
        </Col>
        <Col>{createButton}</Col>
      </Row>

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={24} md={10}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('finance.client')}
              value={clientId}
              onChange={setClientId}
              options={[...clients].map(([id, name]) => ({ value: id, label: name }))}
            />
          </Col>
          <Col xs={24} md={8}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder={t('finance.status')}
              value={status}
              onChange={setStatus}
              options={Object.keys(QUOTE_TOKEN).map((code) => ({
                value: code,
                label: t(`quoteStatus.${code}`),
              }))}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<QuoteRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1100 }}
              locale={{
                emptyText: (
                  <EmptyState description={t('finance.noQuotes')} action={createButton} />
                ),
              }}
            />
          )}
        </QueryState>
      </Card>

      <DocumentFormModal
        kind="quote"
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </Space>
  );
}

/** Счета клиентам `[ТЗ 3.4.1]`. */
export function InvoicesPage(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();
  const [clientId, setClientId] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  const query = useInvoices({ clientId, status });
  const { flights, clients } = useLabels();

  const invoices = query.data?.data ?? [];
  const overdue = invoices.filter(
    (invoice) =>
      invoice.dueDate !== null &&
      new Date(invoice.dueDate).getTime() < nowUtc.getTime() &&
      !['paid', 'voided', 'draft'].includes(invoice.status),
  );

  const columns: DataColumns<InvoiceRow> = [
    {
      title: t('finance.number'), dataIndex: 'number', width: 170, fixed: 'left',
      render: (value: string | null, row) => (
        <Link to={`/billing/invoices/${row.id}`}>
          <Mono>{value ?? t('finance.draft')}</Mono>
        </Link>
      ),
    },
    {
      title: t('finance.client'), dataIndex: 'clientId', width: 220, ellipsis: true,
      render: (value: string) => clients.get(value) ?? value,
    },
    {
      title: t('finance.flight'), dataIndex: 'flightId', width: 200,
      render: (value: string) => (
        <Link to={`/flights/${value}`}>
          <Mono>{flights.get(value) ?? value}</Mono>
        </Link>
      ),
    },
    {
      title: t('finance.issuedAt'), dataIndex: 'issuedAt', width: 130,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.dueDate'), dataIndex: 'dueDate', width: 160,
      defaultSortOrder: 'ascend',
      sorter: (a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''),
      render: (value: string | null, row) => {
        if (!value) return <Typography.Text type="secondary">—</Typography.Text>;
        const days = Math.round((new Date(value).getTime() - nowUtc.getTime()) / 86_400_000);
        const late = days < 0 && !['paid', 'voided', 'draft'].includes(row.status);
        return (
          <Space size={6}>
            <DateText value={value} />
            {late ? (
              <Typography.Text style={{ fontSize: 12, color: STATUS_TOKENS.critical.color }}>
                {t('finance.overdueDays', { days: Math.abs(days) })}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: t('finance.total'), key: 'total', width: 170, align: 'right',
      sorter: (a, b) =>
        Number.parseFloat(a.totals.grandTotal.amount) -
        Number.parseFloat(b.totals.grandTotal.amount),
      render: (_, row) => <MoneyText value={row.totals.grandTotal} strong />,
    },
    {
      title: t('finance.paid'), key: 'paid', width: 150, align: 'right',
      render: (_, row) => (
        <Tooltip title={t('finance.paidFromPaymentsHint')}>
          <span>
            <MoneyText value={row.paidAmount} />
          </span>
        </Tooltip>
      ),
    },
    {
      title: t('finance.status'), dataIndex: 'status', width: 160,
      render: (value: string) => (
        <StatusTag status={value} map={INVOICE_TOKEN} prefix="invoiceStatus" />
      ),
    },
  ];

  const createButton = (
    <Can permission="billing.documents.edit">
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setCreating(true);
        }}
      >
        {t('finance.createInvoice')}
      </Button>
    </Can>
  );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nav.invoices')}
          </Typography.Title>
        </Col>
        <Col>{createButton}</Col>
      </Row>

      {overdue.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={t('finance.overdueNotice', { count: overdue.length })}
        />
      ) : null}

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={24} md={10}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('finance.client')}
              value={clientId}
              onChange={setClientId}
              options={[...clients].map(([id, name]) => ({ value: id, label: name }))}
            />
          </Col>
          <Col xs={24} md={8}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder={t('finance.status')}
              value={status}
              onChange={setStatus}
              options={Object.keys(INVOICE_TOKEN).map((code) => ({
                value: code,
                label: t(`invoiceStatus.${code}`),
              }))}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<InvoiceRow>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1300 }}
              rowClassName={(row) =>
                row.dueDate !== null &&
                new Date(row.dueDate).getTime() < nowUtc.getTime() &&
                !['paid', 'voided', 'draft'].includes(row.status)
                  ? 'soc-row-critical'
                  : ''
              }
              locale={{
                emptyText: (
                  <EmptyState description={t('finance.noInvoices')} action={createButton} />
                ),
              }}
            />
          )}
        </QueryState>
      </Card>

      <DocumentFormModal
        kind="invoice"
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </Space>
  );
}
