import type { JSX } from 'react';
import { Card, Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { Client } from '@/api/types';
import { CLIENTS } from '@/mocks/counterparties';
import { FLIGHT_LIST } from '@/mocks/flights';
import { EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';

/** Клиенты (авиакомпании) `[ТЗ 3.4.1]`. */
export function ClientsPage(): JSX.Element {
  const { t } = useTranslation();

  const columns: DataColumns<Client> = [
    {
      title: t('client.name'), dataIndex: 'name', width: 230, fixed: 'left',
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Link to={`/clients/${row.id}`}>{value}</Link>
            {!row.isActive ? <Tag>{t('common.inactive')}</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.legalName}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('client.country'), dataIndex: 'country', width: 90,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('client.currency'), dataIndex: 'settlementCurrency', width: 100,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('client.paymentTerms'), key: 'terms', width: 240,
      render: (_, row) => (
        <Space size={4} wrap>
          <Tag style={{ margin: 0 }}>{t(`paymentMode.${row.paymentTerms.mode}`)}</Tag>
          {row.paymentTerms.deferDays ? (
            <Typography.Text type="secondary">
              {row.paymentTerms.deferDays} {t('common.days')}
            </Typography.Text>
          ) : null}
          {row.paymentTerms.prepaymentPercent ? (
            <Typography.Text type="secondary">
              {Number.parseFloat(row.paymentTerms.prepaymentPercent).toFixed(0)} %
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('client.creditLimit'), key: 'limit', width: 170, align: 'right',
      render: (_, row) => <MoneyText value={row.creditLimit ?? null} />,
    },
    {
      title: t('client.flights'), key: 'flights', width: 100, align: 'right',
      render: (_, row) => <Mono>{FLIGHT_LIST.filter((f) => f.clientId === row.id).length}</Mono>,
    },
    {
      title: t('client.contact'), key: 'contact', ellipsis: true,
      render: (_, row) => {
        const contact = row.contacts?.[0];
        return contact ? (
          <Space direction="vertical" size={0}>
            <span>{contact.name}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Mono>{contact.email}</Mono>
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.clients')}</Typography.Title>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<Client>
          size="small" rowKey="id" columns={columns} dataSource={CLIENTS}
          pagination={false} scroll={{ x: 1100 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
