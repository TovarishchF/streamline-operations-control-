import { useMemo, useState, type JSX } from 'react';
import { Alert, Button, Card, Col, Row, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { Invoice, Quote } from '@/api/types';
import { INVOICES, QUOTES } from '@/mocks/billing';
import { CLIENTS, CLIENT_BY_ID } from '@/mocks/counterparties';
import { FLIGHT_BY_ID } from '@/mocks/flights';
import { Can } from '@/shared/auth/Can';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const QUOTE_TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  draft: 'neutral', issued: 'progress', accepted: 'done',
  declined: 'critical', expired: 'cancelled', voided: 'cancelled',
};

const INVOICE_TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  draft: 'neutral', issued: 'progress', sent: 'progress', partially_paid: 'warning',
  paid: 'done', overdue: 'critical', voided: 'cancelled',
};

function StatusTag({ status, map, prefix }: { status: string; map: Record<string, keyof typeof STATUS_TOKENS>; prefix: string }): JSX.Element {
  const { t } = useTranslation();
  const token = STATUS_TOKENS[map[status] ?? 'neutral'];
  return (
    <Tag style={{ color: token.color, background: token.background, borderColor: token.border, margin: 0 }}>
      {t(`${prefix}.${status}`)}
    </Tag>
  );
}

/** Котировки `[ТЗ 3.4.1]`. */
export function QuotesPage(): JSX.Element {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const filtered = useMemo(
    () =>
      QUOTES.filter((quote) => {
        if (clientId && quote.clientId !== clientId) return false;
        if (status && quote.status !== status) return false;
        return true;
      }),
    [clientId, status],
  );

  const columns: DataColumns<Quote> = [
    {
      title: t('finance.number'), dataIndex: 'number', width: 170, fixed: 'left',
      render: (value: string | null, row) => (
        <Link to={`/billing/quotes/${row.id}`}>
          <Mono>{value ?? t('finance.draft')}</Mono>
        </Link>
      ),
    },
    {
      title: t('flight.number'), dataIndex: 'flightId', width: 110,
      render: (value: string) => (
        <Link to={`/flights/${value}`}>
          <Mono>{FLIGHT_BY_ID.get(value)?.number ?? value}</Mono>
        </Link>
      ),
    },
    {
      title: t('flight.client'), dataIndex: 'clientId', ellipsis: true,
      render: (value: string) => CLIENT_BY_ID.get(value)?.name ?? value,
    },
    {
      title: t('finance.issuedAt'), dataIndex: 'issuedAt', width: 110,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.validUntil'), dataIndex: 'validUntil', width: 110,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.total'), key: 'total', width: 160, align: 'right',
      sortBy: (row) => Number.parseFloat(row.totals.grandTotal.amount),
      sorter: (a, b) =>
        Number.parseFloat(a.totals.grandTotal.amount) -
        Number.parseFloat(b.totals.grandTotal.amount),
      render: (_, row) => <MoneyText value={row.totals.grandTotal} strong />,
    },
    {
      title: t('finance.status'), dataIndex: 'status', width: 150,
      render: (value: string) => <StatusTag status={value} map={QUOTE_TOKEN} prefix="quoteStatus" />,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]} wrap>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.quotes')}</Typography.Title>
        </Col>
        <Col>
          <Can permission="billing.documents.edit">
            <Button type="primary">{t('finance.createQuote')}</Button>
          </Can>
        </Col>
      </Row>

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={8}>
            <Select
              allowClear showSearch optionFilterProp="label" style={{ width: '100%' }}
              placeholder={t('flight.client')} value={clientId} onChange={setClientId}
              options={CLIENTS.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Col>
          <Col xs={12} md={6}>
            <Select
              allowClear style={{ width: '100%' }} placeholder={t('finance.status')}
              value={status} onChange={setStatus}
              options={Object.keys(QUOTE_TOKEN).map((code) => ({
                value: code, label: t(`quoteStatus.${code}`),
              }))}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<Quote>
          size="small" rowKey="id" columns={columns} dataSource={filtered}
          pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 950 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}

/** Счета клиентам `[ТЗ 3.4.1]`. */
export function InvoicesPage(): JSX.Element {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const filtered = useMemo(
    () =>
      INVOICES.filter((invoice) => {
        if (clientId && invoice.clientId !== clientId) return false;
        if (status && invoice.status !== status) return false;
        return true;
      }),
    [clientId, status],
  );

  const overdueCount = INVOICES.filter((i) => i.status === 'overdue').length;

  const columns: DataColumns<Invoice> = [
    {
      title: t('finance.number'), dataIndex: 'number', width: 170, fixed: 'left',
      render: (value: string | null, row) => (
        <Link to={`/billing/invoices/${row.id}`}>
          <Mono>{value ?? t('finance.draft')}</Mono>
        </Link>
      ),
    },
    {
      title: t('flight.number'), dataIndex: 'flightId', width: 110,
      render: (value: string) => (
        <Link to={`/flights/${value}`}>
          <Mono>{FLIGHT_BY_ID.get(value)?.number ?? value}</Mono>
        </Link>
      ),
    },
    {
      title: t('flight.client'), dataIndex: 'clientId', ellipsis: true,
      render: (value: string) => CLIENT_BY_ID.get(value)?.name ?? value,
    },
    {
      title: t('finance.issuedAt'), dataIndex: 'issuedAt', width: 108,
      render: (value: string | null) => <DateText value={value} />,
    },
    {
      title: t('finance.dueDate'), dataIndex: 'dueDate', width: 108,
      render: (value: string | null, row) => (
        <Space size={4}>
          <DateText value={value} />
          {row.status === 'overdue' ? (
            <Tooltip title={t('finance.overdueHint')}>
              <Tag color="red" style={{ margin: 0 }}>!</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('finance.total'), key: 'total', width: 150, align: 'right',
      sortBy: (row) => Number.parseFloat(row.totals.grandTotal.amount),
      render: (_, row) => <MoneyText value={row.totals.grandTotal} strong />,
    },
    {
      title: t('finance.paid'), key: 'paid', width: 150, align: 'right',
      render: (_, row) => <MoneyText value={row.paidAmount ?? null} />,
    },
    {
      title: t('finance.status'), dataIndex: 'status', width: 160,
      render: (value: string) => <StatusTag status={value} map={INVOICE_TOKEN} prefix="invoiceStatus" />,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]} wrap>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.invoices')}</Typography.Title>
        </Col>
        <Col>
          <Can permission="billing.documents.edit">
            <Button type="primary">{t('finance.createInvoice')}</Button>
          </Can>
        </Col>
      </Row>

      {overdueCount > 0 ? (
        <Alert type="warning" showIcon message={t('finance.overdueCount', { count: overdueCount })} />
      ) : null}

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={8}>
            <Select
              allowClear showSearch optionFilterProp="label" style={{ width: '100%' }}
              placeholder={t('flight.client')} value={clientId} onChange={setClientId}
              options={CLIENTS.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Col>
          <Col xs={12} md={6}>
            <Select
              allowClear style={{ width: '100%' }} placeholder={t('finance.status')}
              value={status} onChange={setStatus}
              options={Object.keys(INVOICE_TOKEN).map((code) => ({
                value: code, label: t(`invoiceStatus.${code}`),
              }))}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<Invoice>
          size="small" rowKey="id" columns={columns} dataSource={filtered}
          pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1100 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
