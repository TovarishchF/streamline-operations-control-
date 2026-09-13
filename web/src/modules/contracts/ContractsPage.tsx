import { useMemo, useState, type JSX } from 'react';
import { Alert, Card, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { VendorContract } from '@/api/types';
import { CONTRACTS, VENDOR_BY_ID } from '@/mocks/counterparties';
import { useClock } from '@/shared/clock/useClock';
import { DateText, EmptyState, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  active: 'done', expiring: 'warning', expired: 'critical', terminated: 'cancelled',
};

/**
 * Договоры с поставщиками `[ТЗ 3.3.3]`.
 *
 * Светофор сроков: действует / истекает / истёк. Фильтр по умолчанию —
 * «требуют внимания» (`SPEC.md § 6.3`): администратору нужен список того,
 * чем заняться, а не полный реестр.
 *
 * Уведомления за 30, 15 и 7 дней ставятся планировщиком с ключом
 * идемпотентности `contractId + порог` — повторно одно и то же уведомление
 * не создаётся.
 */
export function ContractsPage(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');

  const filtered = useMemo(
    () =>
      CONTRACTS.filter((contract) =>
        filter === 'all' ? true : contract.status === 'expiring' || contract.status === 'expired',
      ),
    [filter],
  );

  const expiring = CONTRACTS.filter((c) => c.status === 'expiring').length;
  const expired = CONTRACTS.filter((c) => c.status === 'expired').length;

  const daysLeft = (validTo: string): number | null =>
    nowUtc === null
      ? null
      : Math.round((new Date(validTo).getTime() - nowUtc.getTime()) / 86_400_000);

  const columns: ColumnsType<VendorContract> = [
    {
      title: t('contract.number'), dataIndex: 'number', width: 150, fixed: 'left',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('service.vendor'), dataIndex: 'vendorId', ellipsis: true,
      render: (value: string) => (
        <Link to={`/vendors/${value}`}>{VENDOR_BY_ID.get(value)?.name ?? value}</Link>
      ),
    },
    {
      title: t('contract.validFrom'), dataIndex: 'validFrom', width: 120,
      render: (value: string) => <DateText value={value} />,
    },
    {
      title: t('contract.validTo'), dataIndex: 'validTo', width: 170,
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.validTo.localeCompare(b.validTo),
      render: (value: string, row) => {
        const days = daysLeft(value);
        return (
          <Space size={6}>
            <DateText value={value} />
            {row.status !== 'active' && days !== null ? (
              <Typography.Text
                style={{
                  fontSize: 12,
                  color: days < 0 ? STATUS_TOKENS.critical.color : STATUS_TOKENS.warning.color,
                }}
              >
                {days < 0
                  ? t('contract.expiredDaysAgo', { days: Math.abs(days) })
                  : t('contract.daysLeft', { days })}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: t('contract.currency'), dataIndex: 'currency', width: 90,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('client.paymentTerms'), key: 'terms', width: 170,
      render: (_, row) =>
        `${t(`paymentMode.${row.paymentTerms?.mode ?? 'deferred'}`)}, ${String(row.paymentTerms?.deferDays ?? 0)} ${t('common.days')}`,
    },
    {
      title: t('contract.status'), dataIndex: 'status', width: 140,
      render: (value: string) => {
        const token = STATUS_TOKENS[TOKEN[value] ?? 'neutral'];
        return (
          <Tag style={{ color: token.color, background: token.background, borderColor: token.border, margin: 0 }}>
            {t(`contractStatus.${value}`)}
          </Tag>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.contracts')}</Typography.Title>

      {expired > 0 || expiring > 0 ? (
        <Alert
          type={expired > 0 ? 'error' : 'warning'}
          showIcon
          message={t('contract.attentionNotice', { expiring, expired })}
          description={t('contract.attentionHint')}
        />
      ) : null}

      <Segmented
        value={filter}
        onChange={(value) => { setFilter(value as 'attention' | 'all'); }}
        options={[
          { label: t('contract.needsAttention'), value: 'attention' },
          { label: t('common.all'), value: 'all' },
        ]}
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<VendorContract>
          size="small" rowKey="id" columns={columns} dataSource={filtered}
          pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1000 }}
          locale={{ emptyText: <EmptyState description={t('contract.noneNeedAttention')} /> }}
        />
      </Card>
    </Space>
  );
}
